import type { Message, Guild } from 'discord.js';
import { ChannelType } from 'discord.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ChannelHandler } from './types';
import type { AppContext } from '../events';
import type { AppConfig } from '../../config';
import type { StateStore } from '../../state';
import { getVoiceAttachments, transcribeMessageVoice } from '../voice';
import { invokeClaude } from '../../assistant/runner';

// ============== Wizard State ==============

type PendingLobbyAction =
  | {
      kind: 'create-channel';
      requesterId: string;
      guildId: string;
      name: string;
      purpose: string;
      topic: string;
      categoryId: string | null;
      memoryContent?: string;
    }
  | {
      kind: 'delete-channel';
      requesterId: string;
      guildId: string;
      channelId: string;
    };

const pendingLobbyActionsByProposalMessageId = new Map<string, PendingLobbyAction>();
const pendingCreateWizardsByQuestionMessageId = new Map<
  string,
  { requesterId: string; guildId: string; purpose: string }
>();
const cachedCategoryIdByGuildId = new Map<string, string>();

// ============== Text Helpers ==============

function isConfirmText(text: string): boolean {
  const cmd = text.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
  return cmd === 'yes' || cmd === '/confirm' || cmd === 'confirm';
}

function isRejectText(text: string): boolean {
  const cmd = text.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
  return cmd === 'no' || cmd === '/no' || cmd === '/cancel' || cmd === 'cancel';
}

function slugifyChannelName(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/['".,!?]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'channel';
}

// ============== Channel Memory ==============

function getChannelDir(cfg: AppConfig, channelId: string): string {
  return join(cfg.assistantDir, 'channels', channelId);
}

function getChannelMemoryPath(cfg: AppConfig, channelId: string): string {
  return join(getChannelDir(cfg, channelId), 'memory.md');
}

export function readChannelMemory(cfg: AppConfig, channelId: string): string {
  const path = getChannelMemoryPath(cfg, channelId);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function writeChannelMemory(cfg: AppConfig, channelId: string, content: string): void {
  const dir = getChannelDir(cfg, channelId);
  mkdirSync(dir, { recursive: true });
  const path = getChannelMemoryPath(cfg, channelId);
  writeFileSync(path, content, 'utf-8');
}

function decorateMemoryContent(raw: string, channelId: string, created: string): string {
  const text = (raw || '').trim();
  if (!text) return text;

  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;

  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return text;

  const frontmatter = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');

  const hasChannelId = /^channel_id\s*:/m.test(frontmatter);
  const hasCreated = /^created\s*:/m.test(frontmatter);

  const fmLines: string[] = [];
  fmLines.push('---');
  if (!hasChannelId) fmLines.push(`channel_id: ${channelId}`);
  if (!hasCreated) fmLines.push(`created: ${created}`);
  if (frontmatter.trim()) fmLines.push(frontmatter.trimEnd());
  fmLines.push('---');

  return `${fmLines.join('\n')}\n\n${body.trimStart()}`.trimEnd();
}

export function ensureChannelMemoryInitialized(cfg: AppConfig, channel: any, purposeHint?: string): void {
  const channelId = String(channel?.id || '');
  if (!channelId) return;
  const path = getChannelMemoryPath(cfg, channelId);
  if (existsSync(path)) return;

  const today = new Date().toISOString().slice(0, 10);
  const name = String(channel?.name || 'channel');
  const topic = typeof channel?.topic === 'string' ? channel.topic : '';
  const purpose = (purposeHint || topic || name).trim();

  writeChannelMemory(
    cfg,
    channelId,
    [
      '---',
      `channel_id: ${channelId}`,
      `created: ${today}`,
      `purpose: "${purpose.replace(/"/g, '\\"')}"`,
      '---',
      '',
      `This channel exists to: ${purpose}`,
      '',
      '## Notes',
      '',
      '- (Add channel-specific preferences, recurring workflows, or useful references here.)',
      '',
    ].join('\n')
  );
}

// ============== Category Resolution ==============

export async function resolveAssistantCategoryId(guild: Guild, ctx: AppContext): Promise<string | null> {
  const explicit = ctx.state.snapshot.assistant.categoryId;
  if (explicit) return explicit;

  const cached = cachedCategoryIdByGuildId.get(guild.id);
  if (cached) return cached;

  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    if (!ch) continue;
    if (ch.type !== ChannelType.GuildCategory) continue;
    if (typeof ch.name === 'string' && ch.name.toLowerCase() === 'personal assistant') {
      cachedCategoryIdByGuildId.set(guild.id, ch.id);
      return ch.id;
    }
  }
  return null;
}

// ============== Channel Creation Helpers ==============

async function proposeUniqueChannelName(guild: Guild, base: string): Promise<string> {
  const channels = await guild.channels.fetch();
  const existing = new Set(
    Array.from(channels.values())
      .map((c: any) => (c?.name ? String(c.name).toLowerCase() : ''))
      .filter(Boolean)
  );

  if (!existing.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function parseCreateChannelRequest(text: string): { purpose: string } | null {
  const m =
    text.match(
      /\b(?:create|spawn|make)\b(?:\s+a)?(?:\s+new)?\s+channel(?:\s+(?:for|named|called)\s+|:\s*)(.+)$/i
    ) || text.match(/\bnew\s+channel(?:\s+for|\s*:)\s*(.+)$/i);
  if (!m) return null;
  const purpose = (m[1] || '').trim();
  if (!purpose) return null;
  return { purpose };
}

function parseDeleteChannelRequest(text: string): { channelId: string } | null {
  if (!/\b(?:delete|remove|kill)\b/i.test(text)) return null;
  if (!/\bchannel\b/i.test(text)) return null;
  const m = text.match(/<#(\d+)>/);
  if (!m) return null;
  return { channelId: m[1] };
}

async function generateChannelQuestions(purpose: string): Promise<string> {
  const prompt = `You are helping configure a new Discord channel for a personal assistant system.

The user said they want a channel for:

${purpose}

Ask 4-6 clarifying questions to remove ambiguity and define how the channel should work.

Questions should be short and concrete and cover:
- what "success" looks like
- what belongs in channel memory (preferences / recurring workflows / constraints)
- what artifacts to store (e.g. watchlists, links, decisions) and where (global captures vs channel-specific notes)
- whether follow-ups/scheduled reminders should happen (and cadence)
- any important guardrails (tone, scope, what NOT to do)

Output ONLY the questions as a numbered list (1., 2., 3., …). No intro, no extra text.`;

  const result = await invokeClaude(prompt, { model: 'haiku' });
  const text = (result.text || '').trim();
  if (text) return text;
  return [
    '1. What is this channel for, in one sentence (what should happen here vs elsewhere)?',
    '2. What does "success" look like after 1 week of using it?',
    '3. What should the assistant remember as durable channel memory (preferences, constraints, recurring cadence)?',
    '4. What artifacts should we track here (links, decisions, a watchlist, TODOs)?',
    '5. Should the assistant schedule follow-ups/reminders? If so, when?',
  ].join('\n');
}

async function synthesizeChannelSpec(opts: {
  purpose: string;
  answers: string;
}): Promise<{ name: string; topic: string; purpose: string; memoryContent: string }> {
  const { purpose, answers } = opts;
  const prompt = `You are configuring a new Discord channel for a personal assistant system.

User's original intent:
${purpose}

User's answers to clarifying questions:
${answers}

Produce a single JSON object with EXACTLY these keys:

- name: a short Discord channel name (lowercase, hyphen-separated, <= 80 chars, no leading '#')
- topic: a short channel topic/description (<= 200 chars)
- purpose: one sentence describing the channel's purpose (<= 200 chars)
- memoryContent: markdown content for a per-channel memory file (outside the Obsidian vault).

Constraints:
- name must be safe for Discord (letters/numbers/hyphens).
- topic and purpose must not be empty.
- memoryContent must start with frontmatter lines '---' and include 'purpose:'.
- memoryContent should incorporate the user's answers as actionable defaults, including these sections (keep it concise):
  - ## Working Agreements (guardrails, tone, what not to do)
  - ## Artifacts (what files/structures to keep; how to link to global captures)
  - ## Cadence (follow-up schedule/reminders if requested)
  - ## Defaults (what the assistant should ask for / capture automatically)

Output ONLY the JSON object. No code fences, no commentary.`;

  const result = await invokeClaude(prompt, { model: 'haiku' });
  const raw = (result.text || '').trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const safePurpose = purpose.trim().slice(0, 200) || 'assistant channel';
  const fallbackName = slugifyChannelName(safePurpose);
  const fallbackTopic = `Personal Assistant: ${safePurpose}`.slice(0, 200);
  const fallbackMemory = [
    '---',
    `purpose: \"${safePurpose.replace(/\"/g, '\\\\\"')}\"`,
    '---',
    '',
    `This channel exists to: ${safePurpose}`,
    '',
    '## Notes',
    '',
    '- (Add channel-specific preferences, recurring workflows, or useful references here.)',
    '',
  ].join('\n');

  const name = typeof parsed?.name === 'string' ? slugifyChannelName(parsed.name) : fallbackName;
  const topic = typeof parsed?.topic === 'string' ? String(parsed.topic).slice(0, 200) : fallbackTopic;
  const purposeOut =
    typeof parsed?.purpose === 'string' ? String(parsed.purpose).slice(0, 200) : safePurpose;
  const memoryContent =
    typeof parsed?.memoryContent === 'string' && parsed.memoryContent.trim()
      ? parsed.memoryContent
      : fallbackMemory;

  return { name, topic, purpose: purposeOut, memoryContent };
}

// ============== Managed Channels ==============

export function getManagedAssistantChannelIds(state: StateStore): string[] {
  const list = state.snapshot.assistant.managedChannelIds;
  if (!Array.isArray(list)) return [];
  return list;
}

// ============== Lobby Handler ==============

/**
 * Lobby channel handler.
 *
 * The lobby is the "control plane" for the assistant:
 * - Create new channels with a guided wizard
 * - Delete managed channels
 * - Also acts as a general assistant channel
 */
export const lobbyHandler: ChannelHandler = {
  name: 'lobby',

  matches: (matchCtx) => {
    const { channelId, channelName, message, ctx } = matchCtx;
    const lobbyId = ctx.state.snapshot.assistant.channels.lobby;
    const isLobby = lobbyId ? channelId === lobbyId : channelName?.toLowerCase() === 'assistant';
    if (!isLobby) return false;

    // Replies to bot proposals/questions are part of the lobby control-plane.
    const repliedToId = message.reference?.messageId;
    if (repliedToId) {
      if (pendingCreateWizardsByQuestionMessageId.has(repliedToId)) return true;
      if (pendingLobbyActionsByProposalMessageId.has(repliedToId)) return true;
    }

    const text = message.content.trim();
    if (parseCreateChannelRequest(text)) return true;
    if (parseDeleteChannelRequest(text)) return true;

    // Everything else is treated as normal assistant chat in events.ts.
    return false;
  },

  handle: handleLobbyMessage,

  priority: 60,
};

async function handleLobbyMessage(message: Message, ctx: AppContext): Promise<void> {
  let text = message.content.trim();
  if (!message.guild) return;

  // Transcribe voice messages
  const voiceAttachments = getVoiceAttachments(message);
  if (voiceAttachments.length > 0) {
    const { transcripts, errors } = await transcribeMessageVoice(message);

    if (transcripts.length > 0) {
      const voiceText = transcripts
        .map((t, i) =>
          voiceAttachments.length > 1 ? `[Voice message ${i + 1}]: ${t}` : `[Voice message]: ${t}`
        )
        .join('\n\n');
      text = text ? `${voiceText}\n\n${text}` : voiceText;
    } else if (errors.length > 0 && !text) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
      return;
    }
  }

  if (!text) return;

  // Handle replies to pending wizard/proposal messages
  if (message.reference?.messageId) {
    const handled = await handleWizardReply(message, ctx, text);
    if (handled) return;
  }

  // Check for create channel request
  const createReq = parseCreateChannelRequest(text);
  if (createReq) {
    await startCreateChannelWizard(message, ctx, createReq.purpose);
    return;
  }

  // Check for delete channel request
  const delReq = parseDeleteChannelRequest(text);
  if (delReq) {
    await proposeDeleteChannel(message, ctx, delReq.channelId);
    return;
  }
}

async function handleWizardReply(
  message: Message,
  ctx: AppContext,
  text: string
): Promise<boolean> {
  if (!message.reference?.messageId || !message.guild) return false;

  try {
    const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    if (!repliedTo.author.bot) return false;

    // Check for pending wizard questions
    const wizard = pendingCreateWizardsByQuestionMessageId.get(repliedTo.id);
    if (wizard && wizard.guildId === message.guild.id) {
      if (wizard.requesterId !== message.author.id) {
        await message.reply('Only the requester can answer those questions.');
        return true;
      }

      if (isRejectText(text)) {
        pendingCreateWizardsByQuestionMessageId.delete(repliedTo.id);
        await message.reply('Ok — cancelled channel creation.');
        return true;
      }

      pendingCreateWizardsByQuestionMessageId.delete(repliedTo.id);
      const categoryId = (await resolveAssistantCategoryId(message.guild as Guild, ctx)) || null;
      if (!categoryId) {
        await message.reply('Set the assistant category first with `/assistant category`.');
        return true;
      }

      const spec = await synthesizeChannelSpec({ purpose: wizard.purpose, answers: text });
      const name = await proposeUniqueChannelName(message.guild as Guild, spec.name);

      const proposal = await message.reply(
        [
          `Proposed: create <#${categoryId}> / **#${name}**`,
          `Topic: ${spec.topic}`,
          `Purpose: ${spec.purpose}`,
          '',
          'Reply `yes` to confirm, or `no` to cancel.',
        ].join('\n')
      );

      pendingLobbyActionsByProposalMessageId.set(proposal.id, {
        kind: 'create-channel',
        requesterId: message.author.id,
        guildId: message.guild.id,
        name,
        purpose: spec.purpose,
        topic: spec.topic,
        categoryId,
        memoryContent: spec.memoryContent,
      });
      return true;
    }

    // Check for pending action proposals
    const pending = pendingLobbyActionsByProposalMessageId.get(repliedTo.id);
    if (pending && pending.guildId === message.guild.id) {
      if (pending.requesterId !== message.author.id) {
        await message.reply('Only the requester can confirm that action.');
        return true;
      }

      if (isRejectText(text)) {
        pendingLobbyActionsByProposalMessageId.delete(repliedTo.id);
        await message.reply('Ok — not doing that.');
        return true;
      }

      if (!isConfirmText(text)) {
        await message.reply('Reply `yes` to confirm, or `no` to cancel.');
        return true;
      }

      pendingLobbyActionsByProposalMessageId.delete(repliedTo.id);

      if (pending.kind === 'create-channel') {
        await executeCreateChannel(message, ctx, pending);
        return true;
      }

      if (pending.kind === 'delete-channel') {
        await executeDeleteChannel(message, ctx, pending);
        return true;
      }
    }
  } catch {
    // ignore
  }

  return false;
}

async function startCreateChannelWizard(
  message: Message,
  ctx: AppContext,
  purpose: string
): Promise<void> {
  if (!message.guild) return;

  const categoryId = (await resolveAssistantCategoryId(message.guild as Guild, ctx)) || null;
  if (!categoryId) {
    await message.reply('Set the assistant category first with `/assistant category`.');
    return;
  }

  const safePurpose = purpose.trim().slice(0, 200);
  const questions = await generateChannelQuestions(safePurpose);
  const questionMsg = await message.reply(
    [
      `Before I create a channel for **${safePurpose}**, a few quick questions:`,
      '',
      questions,
      '',
      'Reply to this message with your answers (numbered is easiest).',
      'Reply `no` to cancel.',
    ].join('\n')
  );

  pendingCreateWizardsByQuestionMessageId.set(questionMsg.id, {
    requesterId: message.author.id,
    guildId: message.guild.id,
    purpose: safePurpose,
  });
}

async function proposeDeleteChannel(
  message: Message,
  ctx: AppContext,
  channelId: string
): Promise<void> {
  if (!message.guild) return;

  const managed = getManagedAssistantChannelIds(ctx.state);
  if (!managed.includes(channelId)) {
    await message.reply('I will only delete channels I created (managed channels).');
    return;
  }

  const proposal = await message.reply(
    [`Proposed: delete <#${channelId}>.`, '', 'Reply `yes` to confirm, or `no` to cancel.'].join('\n')
  );

  pendingLobbyActionsByProposalMessageId.set(proposal.id, {
    kind: 'delete-channel',
    requesterId: message.author.id,
    guildId: message.guild.id,
    channelId,
  });
}

async function executeCreateChannel(
  message: Message,
  ctx: AppContext,
  pending: Extract<PendingLobbyAction, { kind: 'create-channel' }>
): Promise<void> {
  if (!message.guild) return;

  const categoryId =
    pending.categoryId || (await resolveAssistantCategoryId(message.guild as Guild, ctx)) || null;
  if (!categoryId) {
    await message.reply('Set the assistant category first with `/assistant category`.');
    return;
  }

  const created = await message.guild.channels.create({
    name: pending.name,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: pending.topic.slice(0, 1024),
    reason: 'Personal Assistant: user requested channel',
  });

  await ctx.state.transact(async () => {
    ctx.state.addManagedChannel(created.id);
  });

  if (pending.memoryContent && pending.memoryContent.trim()) {
    const today = new Date().toISOString().slice(0, 10);
    writeChannelMemory(ctx.cfg, created.id, decorateMemoryContent(pending.memoryContent, created.id, today));
  } else {
    const today = new Date().toISOString().slice(0, 10);
    writeChannelMemory(
      ctx.cfg,
      created.id,
      [
        '---',
        `channel_id: ${created.id}`,
        `created: ${today}`,
        `purpose: "${pending.purpose.replace(/"/g, '\\"')}"`,
        '---',
        '',
        `This channel exists to: ${pending.purpose}`,
        '',
        '## Notes',
        '',
        '- (Add channel-specific preferences, recurring workflows, or useful references here.)',
        '',
      ].join('\n')
    );
  }

  await created.send(
    [
      `Created for: **${pending.purpose}**`,
      '',
      'This channel has its own additive memory (stored outside the Obsidian vault).',
      'Reply `/cancel` to an in-flight progress message to stop a run.',
    ].join('\n')
  );

  await message.reply(`Created <#${created.id}>.`);
}

async function executeDeleteChannel(
  message: Message,
  ctx: AppContext,
  pending: Extract<PendingLobbyAction, { kind: 'delete-channel' }>
): Promise<void> {
  if (!message.guild) return;

  const managed = getManagedAssistantChannelIds(ctx.state);
  if (!managed.includes(pending.channelId)) {
    await message.reply('I will only delete channels I created (managed channels).');
    return;
  }

  const ch = await message.guild.channels.fetch(pending.channelId);
  if (!ch) {
    await message.reply('That channel no longer exists.');
    await ctx.state.transact(async () => {
      ctx.state.removeManagedChannel(pending.channelId);
    });
    return;
  }

  await ch.delete('Personal Assistant: user requested deletion');
  await ctx.state.transact(async () => {
    ctx.state.removeManagedChannel(pending.channelId);
  });
  await message.reply('Deleted.');
}
