import type { ButtonInteraction, Client, Guild, Message, ModalSubmitInteraction, TextChannel } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig } from '../config';
import {
  getBlipsToSurface,
  readBlip,
  snoozeBlip,
  archiveBlip,
  touchBlip,
  appendToLog,
} from '../blips';
import { addDaysIsoDate, isoDateForAssistant } from '../time';

const BLIPS_STREAM_CUSTOM_ID_PREFIX = 'blips_stream:';
const BLIPS_STREAM_MODAL_PREFIX = 'blips_stream_modal:';

type StreamState = {
  messageId?: string;
  currentFilename?: string;
};

type StreamStateFile = Record<string, StreamState>;

const seenInteractionIds = new Map<string, number>();
const INTERACTION_DEDUPE_MS = 15_000;

function stateFilePath(): string {
  const cfg = loadConfig();
  return join(cfg.assistantDir, 'state', 'blips-stream.json');
}

function readStreamState(): StreamStateFile {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StreamStateFile;
  } catch {
    return {};
  }
}

function writeStreamState(state: StreamStateFile): void {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function getNextBlipFilename(excludeFilename?: string): string | null {
  const candidates = getBlipsToSurface(20);
  for (const c of candidates) {
    if (excludeFilename && c.filename === excludeFilename) continue;
    return c.filename;
  }
  if (excludeFilename) {
    const again = getBlipsToSurface(1)[0];
    return again?.filename || null;
  }
  return null;
}

function blipExists(filename: string): boolean {
  const cfg = loadConfig();
  const path = join(cfg.blipsDir, filename);
  return existsSync(path);
}

function excerptBlipContent(raw: string, maxLen: number): string {
  const content = raw.split(/\n##\s+Log\b/)[0] || raw;
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + '…';
}

function renderBlipCard(opts: {
  filename: string;
  mode?: 'active' | 'done';
}): {
  flags: number;
  components: any[];
} {
  const { filename, mode = 'active' } = opts;
  const cfg = loadConfig();
  const path = join(cfg.blipsDir, filename);
  const blip = readBlip(path);

  const title = blip?.title || filename.replace(/\.md$/i, '');
  const touched = blip?.touched || '';
  const created = blip?.created || '';

  const dateLine = [touched ? `touched ${touched}` : '', created ? `created ${created}` : '']
    .filter(Boolean)
    .join(' · ');

  const meta = [`**${title}**`, dateLine].filter(Boolean).join('\n');
  const excerpt = blip ? excerptBlipContent(blip.content, 600) : '';

  const header: any = { type: ComponentType.TextDisplay, content: meta };
  const sep: any = { type: ComponentType.Separator };
  const body: any = {
    type: ComponentType.TextDisplay,
    content: excerpt || '_No notes yet._',
  };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}next:${filename}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}thoughts:${filename}`)
      .setLabel('Thoughts')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}snooze:${filename}`)
      .setLabel('Snooze')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}archive:${filename}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Danger)
  );

  if (mode === 'done') {
    for (const b of row.components as ButtonBuilder[]) b.setDisabled(true);
  }

  const container: any = {
    type: ComponentType.Container,
    components: [header, sep, body, row.toJSON()],
  };

  return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

async function resolveBlipsStreamChannel(guild: Guild, blipsStreamId?: string): Promise<TextChannel | null> {
  if (blipsStreamId) {
    const ch = await guild.channels.fetch(blipsStreamId).catch(() => null);
    if (ch && ch.isTextBased() && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }

  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    if (!ch) continue;
    if (ch.type !== ChannelType.GuildText) continue;
    if (typeof ch.name === 'string' && ch.name.toLowerCase() === 'blips-stream') {
      return ch as TextChannel;
    }
  }
  return null;
}

export async function ensureBlipsStreamCard(opts: {
  client: Client;
  guild: Guild;
  blipsStreamChannelId?: string;
}): Promise<void> {
  const channel = await resolveBlipsStreamChannel(opts.guild, opts.blipsStreamChannelId);
  if (!channel) return;

  const state = readStreamState();
  const slot = (state[channel.id] ||= {});

  const wanted = slot.currentFilename && blipExists(slot.currentFilename) ? slot.currentFilename : null;
  const filename = wanted || getNextBlipFilename() || null;
  if (!filename) return;

  const payload = renderBlipCard({ filename });
  slot.currentFilename = filename;

  if (slot.messageId) {
    const msg = await channel.messages.fetch(slot.messageId).catch(() => null);
    if (msg) {
      await msg.edit(payload as any).catch(() => {});
      writeStreamState(state);
      return;
    }
  }

  const sent = await channel.send(payload as any).catch(() => null);
  if (sent) {
    slot.messageId = sent.id;
    writeStreamState(state);
  }
}

function blipPathFromFilename(filename: string): string {
  const cfg = loadConfig();
  return join(cfg.blipsDir, filename);
}

function addDaysIso(days: number): string {
  const today = isoDateForAssistant(new Date());
  return addDaysIsoDate(today, days);
}

export function isBlipsStreamCustomId(customId: string): boolean {
  return customId.startsWith(BLIPS_STREAM_CUSTOM_ID_PREFIX) || customId.startsWith(BLIPS_STREAM_MODAL_PREFIX);
}

async function refreshInPlace(message: Message, filename: string | null): Promise<void> {
  if (!filename) {
    await message.edit({
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            { type: ComponentType.TextDisplay, content: '**Blips Stream**\n\n_No blips ready right now._' },
          ],
        },
      ],
    } as any);
    return;
  }
  await message.edit(renderBlipCard({ filename }) as any);
}

async function sendNewCard(message: Message, filename: string | null): Promise<Message | null> {
  if (!filename) return null;
  const ch = message.channel as TextChannel;
  const sent = await ch.send(renderBlipCard({ filename }) as any).catch(() => null);
  return sent as any;
}

async function advanceCard(message: Message, currentFilename?: string): Promise<void> {
  const next = getNextBlipFilename(currentFilename) || null;
  const state = readStreamState();
  const slot = (state[message.channelId] ||= {});
  writeStreamState(state);

  // Finalize the current card in-place so it remains in history
  if (currentFilename) {
    await message.edit(renderBlipCard({ filename: currentFilename, mode: 'done' }) as any).catch(() => {});
  }

  // Post the next blip as a new message
  const nextMsg = await sendNewCard(message, next);
  slot.messageId = nextMsg?.id;
  slot.currentFilename = next || undefined;
  writeStreamState(state);
}

async function advanceCardFallback(client: Client, guild: Guild | null, channelId: string, currentFilename?: string): Promise<void> {
  const next = getNextBlipFilename(currentFilename) || null;
  const state = readStreamState();
  const slot = (state[channelId] ||= {});
  slot.currentFilename = next || undefined;
  writeStreamState(state);

  if (guild) {
    await ensureBlipsStreamCard({ client, guild, blipsStreamChannelId: channelId }).catch(() => {});
  }
}

async function getStreamMessageForChannel(client: Client, channelId: string): Promise<Message | null> {
  const state = readStreamState();
  const slot = state[channelId];
  const messageId = slot?.messageId;
  if (!messageId) return null;

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || ch.type !== ChannelType.GuildText) return null;

  const msg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
  return msg || null;
}

export async function handleBlipsStreamButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(BLIPS_STREAM_CUSTOM_ID_PREFIX)) return;

  const now = Date.now();
  for (const [k, t] of seenInteractionIds) {
    if (now - t > INTERACTION_DEDUPE_MS) seenInteractionIds.delete(k);
  }
  if (seenInteractionIds.has(interaction.id)) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  seenInteractionIds.set(interaction.id, now);

  const rest = customId.slice(BLIPS_STREAM_CUSTOM_ID_PREFIX.length);
  const [verb, filename] = rest.split(':', 2);
  if (!verb || !filename) return;

  const message = interaction.message as Message;
  const state = readStreamState();
  const slot = state[interaction.channelId] || {};
  const current = slot.currentFilename;

  // Stale safety: if the button is for a different blip than the current card, just refresh
  if (current && filename !== current) {
    await interaction.reply({ content: 'That card is no longer active.', ephemeral: true }).catch(() => {});
    return;
  }

  if (verb === 'thoughts') {
    const modal = new ModalBuilder()
      .setCustomId(`${BLIPS_STREAM_MODAL_PREFIX}thoughts:${message.id}:${filename}`)
      .setTitle('Add thoughts');

    const input = new TextInputBuilder()
      .setCustomId('thoughts')
      .setLabel('Thoughts')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  const path = blipPathFromFilename(filename);

  await interaction.deferUpdate().catch(() => {});

  if (verb === 'archive') {
    archiveBlip(path);
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'next') {
    touchBlip(path);
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'snooze') {
    snoozeBlip(path, addDaysIso(7));
    await advanceCard(message, filename);
    return;
  }
}

export async function handleBlipsStreamModal(interaction: ModalSubmitInteraction): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(BLIPS_STREAM_MODAL_PREFIX)) return;

  const rest = customId.slice(BLIPS_STREAM_MODAL_PREFIX.length);
  const parts = rest.split(':');
  const verb = parts[0] || '';
  const legacyFilename = parts[1] || '';
  const messageId = parts.length >= 3 ? parts[1] || '' : '';
  const filename = parts.length >= 3 ? parts.slice(2).join(':') || '' : legacyFilename;
  if (!verb) return;

  await interaction.deferUpdate().catch(() => {});

  let streamMsg: Message | null = null;
  if (messageId && interaction.channelId) {
    const ch = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (ch && ch.isTextBased() && ch.type === ChannelType.GuildText) {
      streamMsg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
    }
  }

  const path = blipPathFromFilename(filename);
  if (!streamMsg && interaction.channelId) {
    streamMsg = await getStreamMessageForChannel(interaction.client as any, interaction.channelId);
  }

  if (verb === 'thoughts') {
    const thoughts = interaction.fields.getTextInputValue('thoughts').trim();
    if (thoughts) appendToLog(path, `Thoughts: ${thoughts}`);
    if (streamMsg) {
      await advanceCard(streamMsg, filename);
    } else if (interaction.channelId) {
      await advanceCardFallback(interaction.client as any, interaction.guild as any, interaction.channelId, filename);
    }
    return;
  }
}
