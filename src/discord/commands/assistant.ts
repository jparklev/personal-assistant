import type { ChatInputCommandInteraction } from 'discord.js';
import { existsSync } from 'fs';
import type { AppContext } from '../events';
import { listBlips } from '../../blips';
import { getManagedAssistantChannelIds } from '../channels';

/**
 * Handle /assistant slash command and its subcommands.
 */
export async function handleAssistantCommand(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'enable':
      await handleEnable(interaction, ctx);
      break;
    case 'channel':
      await handleChannel(interaction, ctx);
      break;
    case 'category':
      await handleCategory(interaction, ctx);
      break;
    case 'status':
      await handleStatus(interaction, ctx);
      break;
    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
  }
}

async function handleEnable(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  const enabled = interaction.options.getBoolean('enabled', true);

  await ctx.state.transact(async () => {
    ctx.state.setAssistantEnabled(enabled);
  });

  await interaction.reply({
    content: enabled ? '✅ Assistant enabled' : '⏸️ Assistant disabled',
    ephemeral: false,
  });
}

async function handleChannel(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  const type = interaction.options.getString('type', true) as
    | 'morningCheckin'
    | 'blips'
    | 'blipsStream'
    | 'lobby'
    | 'health'
    | 'meditationLogs'
    | 'dailies';
  const channel = interaction.options.getChannel('channel', true);

  await ctx.state.transact(async () => {
    ctx.state.setAssistantChannel(type, channel.id);
  });

  const typeNames: Record<string, string> = {
    morningCheckin: 'Morning Check-in',
    blips: 'Blips',
    blipsStream: 'Blips Stream',
    lobby: 'Lobby',
    health: 'Health',
    meditationLogs: 'Meditation Logs',
    dailies: 'Dailies',
  };

  await interaction.reply({
    content: `Set ${typeNames[type]} channel to <#${channel.id}>`,
    ephemeral: false,
  });
}

async function handleCategory(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  const category = interaction.options.getChannel('category', true);

  await ctx.state.transact(async () => {
    ctx.state.setAssistantCategory(category.id);
  });

  await interaction.reply({
    content: `Set assistant category to <#${category.id}>`,
    ephemeral: false,
  });
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> {
  const enabled = ctx.state.isAssistantEnabled();
  const channels = ctx.state.snapshot.assistant.channels;
  const categoryId = ctx.state.snapshot.assistant.categoryId;
  const managedCount = getManagedAssistantChannelIds(ctx.state).length;
  const blips = listBlips();

  const channelLines = [
    channels.morningCheckin ? `  Morning: <#${channels.morningCheckin}>` : '  Morning: not set',
    channels.blips ? `  Blips: <#${channels.blips}>` : '  Blips: not set',
    channels.blipsStream ? `  Blips Stream: <#${channels.blipsStream}>` : '  Blips Stream: not set',
    channels.lobby ? `  Lobby: <#${channels.lobby}>` : '  Lobby: not set',
    channels.health ? `  Health: <#${channels.health}>` : '  Health: not set',
    channels.meditationLogs
      ? `  Meditation: <#${channels.meditationLogs}>`
      : '  Meditation: not set',
    channels.dailies ? `  Dailies: <#${channels.dailies}>` : '  Dailies: not set',
  ].join('\n');

  const vaultPath = ctx.cfg.vaultPath;
  const vaultExists = existsSync(vaultPath);

  await interaction.reply({
    content: `**Assistant Status**
Enabled: ${enabled ? '✅' : '❌'}

**Channels:**
${channelLines}

**Category:**
  ${categoryId ? `<#${categoryId}>` : 'not set'}

**Managed channels:**
  ${managedCount}

**Vault:**
  Path: \`${vaultPath}\`
  Accessible: ${vaultExists ? '✅' : '❌'}

**Blips:**
  Total: ${blips.length}`,
    ephemeral: false,
  });
}
