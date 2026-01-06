import type { ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../events';
import {
  listBlips,
  readBlip,
  createBlip,
  appendToLog,
  snoozeBlip,
  archiveBlip,
  getBlipsToSurface,
  suggestMoves,
  touchBlip,
} from '../../blips';
import { buildAssistantContext } from '../../assistant/invoke';
import { invokeClaude } from '../../assistant/runner';

/**
 * Handle /blip slash command and its subcommands.
 */
export async function handleBlipCommand(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'capture':
      await handleCapture(interaction);
      break;
    case 'list':
      await handleList(interaction);
      break;
    case 'show':
      await handleShow(interaction);
      break;
    case 'surface':
      await handleSurface(interaction);
      break;
    case 'note':
      await handleNote(interaction);
      break;
    case 'snooze':
      await handleSnooze(interaction);
      break;
    case 'archive':
      await handleArchive(interaction);
      break;
    case 'stats':
      await handleStats(interaction);
      break;
    case 'process':
      await handleProcess(interaction, ctx);
      break;
    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
  }
}

async function handleCapture(interaction: ChatInputCommandInteraction): Promise<void> {
  const content = interaction.options.getString('content', true);
  const title = content.split('\n')[0].slice(0, 50) || 'Untitled blip';

  const path = createBlip({
    title,
    content,
    logEntry: 'Captured from Discord',
  });

  const filename = path.split('/').pop() || path;
  await interaction.reply({
    content: `Captured blip \`${filename}\`\n> ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`,
    ephemeral: false,
  });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const blips = listBlips().slice(0, 10);
  if (blips.length === 0) {
    await interaction.reply({
      content: 'No blips yet. Capture one with `/blip capture`!',
      ephemeral: true,
    });
    return;
  }

  const lines = blips.map((b) => {
    const status = b.status === 'active' ? '🔥' : b.status === 'snoozed' ? '💤' : '📦';
    const title = b.title.slice(0, 50);
    return `${status} **${title}** (${b.touched})`;
  });

  await interaction.reply({
    content: `**Recent Blips**\n${lines.join('\n')}`,
    ephemeral: false,
  });
}

async function handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
  const filename = interaction.options.getString('id', true);
  const blips = listBlips();
  const summary = blips.find(
    (b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase())
  );

  if (!summary) {
    await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
    return;
  }

  const blip = readBlip(summary.path);
  if (!blip) {
    await interaction.reply({ content: `Could not read blip.`, ephemeral: true });
    return;
  }

  const statusEmoji = blip.status === 'active' ? '🔥' : blip.status === 'snoozed' ? '💤' : '📦';
  const tags = blip.tags?.length ? ` [${blip.tags.join(', ')}]` : '';

  let response = `${statusEmoji} **${blip.title}**${tags}\n`;
  response += `Created: ${blip.created} · Last touched: ${blip.touched}\n\n`;

  const preview = blip.content.split(/^##/m)[0].trim().slice(0, 300);
  response += `> ${preview}${blip.content.length > 300 ? '...' : ''}`;

  await interaction.reply({ content: response, ephemeral: true });
}

async function handleSurface(interaction: ChatInputCommandInteraction): Promise<void> {
  const count = interaction.options.getInteger('count') || 3;
  const toSurface = getBlipsToSurface(count);

  if (toSurface.length === 0) {
    await interaction.reply({ content: 'No blips ready to surface right now.', ephemeral: true });
    return;
  }

  const lines: string[] = [];
  for (let i = 0; i < toSurface.length; i++) {
    const summary = toSurface[i];
    const blip = readBlip(summary.path);
    if (!blip) continue;

    touchBlip(summary.path);

    const preview = blip.content.split(/^##/m)[0].trim().slice(0, 80);
    const moves = suggestMoves(blip).slice(0, 3);
    const moveLabels = moves.map((m) => m.label).join(', ');

    lines.push(
      `**${i + 1}.** ${blip.title}\n> ${preview}${blip.content.length > 80 ? '...' : ''}\nMoves: ${moveLabels}`
    );
  }

  await interaction.reply({
    content: `**Blips to Consider**\n\n${lines.join('\n\n')}`,
    ephemeral: false,
  });
}

async function handleNote(interaction: ChatInputCommandInteraction): Promise<void> {
  const filename = interaction.options.getString('id', true);
  const note = interaction.options.getString('note', true);

  const blips = listBlips();
  const summary = blips.find(
    (b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase())
  );

  if (!summary) {
    await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
    return;
  }

  appendToLog(summary.path, note);
  await interaction.reply({ content: `Added note to **${summary.title}**`, ephemeral: false });
}

async function handleSnooze(interaction: ChatInputCommandInteraction): Promise<void> {
  const filename = interaction.options.getString('id', true);
  const days = interaction.options.getInteger('days') || 7;

  const blips = listBlips();
  const summary = blips.find(
    (b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase())
  );

  if (!summary) {
    await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
    return;
  }

  const until = new Date();
  until.setDate(until.getDate() + days);
  snoozeBlip(summary.path, until.toISOString().split('T')[0]);
  await interaction.reply({
    content: `Snoozed **${summary.title}** for ${days} days`,
    ephemeral: false,
  });
}

async function handleArchive(interaction: ChatInputCommandInteraction): Promise<void> {
  const filename = interaction.options.getString('id', true);

  const blips = listBlips();
  const summary = blips.find(
    (b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase())
  );

  if (!summary) {
    await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
    return;
  }

  archiveBlip(summary.path);
  await interaction.reply({ content: `Archived **${summary.title}**`, ephemeral: false });
}

async function handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const blips = listBlips();
  const byStatus: Record<string, number> = {};
  for (const b of blips) {
    byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  }

  const statusLines = Object.entries(byStatus)
    .map(([status, count]) => `  ${status}: ${count}`)
    .join('\n');

  await interaction.reply({
    content: `**Blip Statistics**\nTotal: ${blips.length}\n\n**By Status:**\n${statusLines}`,
    ephemeral: false,
  });
}

async function handleProcess(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  await interaction.deferReply();

  const result = await invokeClaude(
    `You are the personal assistant. Review the Obsidian vault for new items to capture as blips.

${buildAssistantContext()}

## Your Task

1. Read the Note Inbox.md file and identify any new items worth capturing
2. Check the Clippings/ folder for new highlights
3. For each item worth capturing, describe what it is

For now, just report what you find. Output a brief summary.`,
    { model: 'opus' }
  );

  await interaction.editReply({
    content: result.ok
      ? `**Vault Review**\n${result.text}`
      : `**Review failed:** ${result.text || 'Unknown error'}`,
  });
}
