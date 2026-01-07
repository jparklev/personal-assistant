/**
 * Flashcards Channel Handler
 *
 * Provides a Discord interface for spaced repetition review.
 * Shows cards with interactive buttons for rating.
 */

import type { Message, ButtonInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { ChannelHandler } from './types';
import type { AppContext } from '../events';
import type { Flashcard, ReviewRating } from '../../flashcards/types';
import {
  getDueCards,
  getCard,
  reviewCard,
  getDeckStats,
  addCards,
} from '../../flashcards';
import { readBlip } from '../../blips';
import { invokeClaude } from '../../assistant/runner';

const FLASHCARD_PREFIX = 'fc_';

/**
 * Flashcards channel handler.
 *
 * Messages in this channel trigger a review session.
 */
export const flashcardsHandler: ChannelHandler = {
  name: 'flashcards',

  matches: (matchCtx) => {
    const { channelId, channelName, ctx } = matchCtx;
    const flashcardsId = (ctx.state.snapshot.assistant.channels as any).flashcards;
    if (flashcardsId) return channelId === flashcardsId;
    return channelName?.toLowerCase() === 'flashcards';
  },

  handle: handleFlashcardsMessage,

  priority: 30,
};

async function handleFlashcardsMessage(message: Message, ctx: AppContext): Promise<void> {
  const text = message.content.trim().toLowerCase();

  // Commands
  if (text === 'review' || text === 'next' || text === '') {
    await showNextCard(message);
    return;
  }

  if (text === 'stats' || text === 'status') {
    await showStats(message);
    return;
  }

  if (text.startsWith('generate from ')) {
    const blipRef = text.slice('generate from '.length).trim();
    await generateFromBlip(message, blipRef, ctx);
    return;
  }

  // Default: show next card
  await showNextCard(message);
}

async function showNextCard(message: Message): Promise<void> {
  const dueCards = getDueCards();

  if (dueCards.length === 0) {
    const stats = getDeckStats();
    await message.reply(
      `No cards due right now.\n\n**Deck stats:** ${stats.total} total, ${stats.new} new, ${stats.learning} learning, ${stats.mature} mature`
    );
    return;
  }

  const card = dueCards[0];
  await showCardQuestion(message, card);
}

async function showCardQuestion(message: Message, card: Flashcard): Promise<void> {
  const dueCards = getDueCards();
  const remaining = dueCards.length;

  const sourceInfo = card.sourceBlipTitle
    ? `\n\n_From: ${card.sourceBlipTitle}_`
    : '';

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FLASHCARD_PREFIX}show_${card.id}`)
      .setLabel('Show Answer')
      .setStyle(ButtonStyle.Primary)
  );

  await message.reply({
    content: `**Question** (${remaining} due)\n\n${card.question}${sourceInfo}`,
    components: [row],
  });
}

async function showStats(message: Message): Promise<void> {
  const stats = getDeckStats();

  await message.reply(
    [
      '**Flashcard Stats**',
      '',
      `Total cards: ${stats.total}`,
      `Due today: ${stats.due}`,
      `New: ${stats.new}`,
      `Learning: ${stats.learning}`,
      `Mature: ${stats.mature}`,
    ].join('\n')
  );
}

async function generateFromBlip(
  message: Message,
  blipRef: string,
  _ctx: AppContext
): Promise<void> {
  // Find the blip
  const { listBlips } = await import('../../blips/index.js');
  const blips = listBlips();

  const blipSummary = blips.find(
    (b: { filename: string; title: string }) =>
      b.filename.includes(blipRef) ||
      b.title.toLowerCase().includes(blipRef.toLowerCase())
  );

  if (!blipSummary) {
    await message.reply(`Could not find blip matching "${blipRef}"`);
    return;
  }

  const blip = readBlip(blipSummary.path);
  if (!blip) {
    await message.reply(`Could not read blip "${blipSummary.filename}"`);
    return;
  }

  const progressMsg = await message.reply('Generating flashcards...');

  const prompt = `You are generating flashcards from the following content.

## Content

Title: ${blip.title}

${blip.content}

## Instructions

Generate 3-7 flashcards that capture the key concepts, facts, or insights from this content.

For each flashcard:
- Question should be clear and specific
- Answer should be concise but complete
- Focus on things worth remembering long-term

Output as a JSON array:
[
  { "question": "...", "answer": "..." },
  ...
]

Output ONLY the JSON array, no other text.`;

  try {
    const result = await invokeClaude(prompt, { model: 'haiku' });

    if (!result.ok || !result.text) {
      await progressMsg.edit('Failed to generate flashcards.');
      return;
    }

    // Parse the JSON
    let cards: Array<{ question: string; answer: string }>;
    try {
      // Extract JSON from response (may have markdown code blocks)
      const jsonMatch = result.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array found');
      cards = JSON.parse(jsonMatch[0]);
    } catch {
      await progressMsg.edit('Failed to parse generated flashcards.');
      return;
    }

    if (!Array.isArray(cards) || cards.length === 0) {
      await progressMsg.edit('No flashcards generated.');
      return;
    }

    // Add the cards
    const addedCards = addCards(cards, {
      sourceBlipPath: blipSummary.path,
      sourceBlipTitle: blip.title,
    });

    await progressMsg.edit(
      `Generated ${addedCards.length} flashcards from "${blip.title}"\n\nType \`review\` to start studying.`
    );
  } catch (err: any) {
    await progressMsg.edit(`Error: ${err?.message || 'Unknown error'}`);
  }
}

/**
 * Handle flashcard button interactions.
 */
export function isFlashcardCustomId(customId: string): boolean {
  return customId.startsWith(FLASHCARD_PREFIX);
}

export async function handleFlashcardButton(
  interaction: ButtonInteraction
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith(`${FLASHCARD_PREFIX}show_`)) {
    const cardId = customId.slice(`${FLASHCARD_PREFIX}show_`.length);
    await showCardAnswer(interaction, cardId);
    return;
  }

  if (customId.startsWith(`${FLASHCARD_PREFIX}rate_`)) {
    const [cardId, rating] = customId
      .slice(`${FLASHCARD_PREFIX}rate_`.length)
      .split('_');
    await rateCard(interaction, cardId, rating as ReviewRating);
    return;
  }

  await interaction.reply({ content: 'Unknown action', ephemeral: true });
}

async function showCardAnswer(
  interaction: ButtonInteraction,
  cardId: string
): Promise<void> {
  const card = getCard(cardId);

  if (!card) {
    await interaction.reply({ content: 'Card not found', ephemeral: true });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FLASHCARD_PREFIX}rate_${cardId}_again`)
      .setLabel('Again')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${FLASHCARD_PREFIX}rate_${cardId}_hard`)
      .setLabel('Hard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${FLASHCARD_PREFIX}rate_${cardId}_good`)
      .setLabel('Good')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${FLASHCARD_PREFIX}rate_${cardId}_easy`)
      .setLabel('Easy')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.update({
    content: `**Question**\n\n${card.question}\n\n---\n\n**Answer**\n\n${card.answer}`,
    components: [row],
  });
}

async function rateCard(
  interaction: ButtonInteraction,
  cardId: string,
  rating: ReviewRating
): Promise<void> {
  const updatedCard = reviewCard(cardId, rating);

  if (!updatedCard) {
    await interaction.reply({ content: 'Card not found', ephemeral: true });
    return;
  }

  const dueCards = getDueCards();
  const remaining = dueCards.length;

  const ratingEmoji: Record<ReviewRating, string> = {
    again: '🔴',
    hard: '🟠',
    good: '🟢',
    easy: '⭐',
  };

  let content = `${ratingEmoji[rating]} Rated **${rating}** — next review in ${updatedCard.interval} day(s)`;

  if (remaining > 0) {
    content += `\n\n${remaining} card(s) remaining.`;

    // Show next card
    const nextCard = dueCards[0];
    const sourceInfo = nextCard.sourceBlipTitle
      ? `\n\n_From: ${nextCard.sourceBlipTitle}_`
      : '';

    content += `\n\n---\n\n**Question**\n\n${nextCard.question}${sourceInfo}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${FLASHCARD_PREFIX}show_${nextCard.id}`)
        .setLabel('Show Answer')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.update({
      content,
      components: [row],
    });
  } else {
    content += '\n\n🎉 All done for now!';
    await interaction.update({
      content,
      components: [],
    });
  }
}
