import type { Client, ChatInputCommandInteraction, Message } from 'discord.js';
import { ChannelType, Events } from 'discord.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname } from 'path';
import { join } from 'path';
import type { DiscordTransport } from './transport';
import type { AppConfig } from '../config';
import type { StateStore } from '../state';
import { buildAssistantContext } from '../assistant/invoke';
import { invokeClaude, type RunnerEvent } from '../assistant/runner';
import { storeSession, getSession, setSessionMetadata, getSessionMetadata } from '../assistant/sessions';
import { ProgressRenderer } from '../assistant/progress';
import { ensureBlipsStreamCard, handleBlipsStreamButton, handleBlipsStreamModal, isBlipsStreamCustomId } from './blips-stream';
import {
  listBlips,
  readBlip,
  createBlip,
  findBlipBySource,
  canonicalizeBlipSource,
  appendToLog,
  snoozeBlip,
  archiveBlip,
  getBlipsToSurface,
  getActiveBlipsSummary,
  suggestMoves,
  formatMoveSuggestions,
  touchBlip,
} from '../blips';
import { extractUrls } from '../captures';
import { captureUrlToFile } from '../captures/capture-url';
import { getDueQuestions, markQuestionAsked } from '../memory';
import { getVoiceAttachments, transcribeMessageVoice, getTranscriptionMethod } from './voice';

export interface AppContext {
  cfg: AppConfig;
  state: StateStore;
  transport: DiscordTransport;
}

type QueuedAssistantMessage = {
  message: Message;
  text: string;
  channelType: 'general' | 'morning-checkin' | 'blips' | 'lobby';
};

type RunningAssistantTask = {
  progressMessageId: string;
  sessionId: string | null;
  resumeReady: Promise<string>;
  resolveResumeReady: (sessionId: string) => void;
  abortController: AbortController;
  cancelled: boolean;
  preSessionQueue: QueuedAssistantMessage[];
  queueCount: number;
  currentState: 'thinking' | 'tool' | 'writing';
  requestRender?: () => Promise<void>;
};

const runningByProgressMessageId = new Map<string, RunningAssistantTask>();
const runningBySessionId = new Map<string, RunningAssistantTask>();
const queuedBySessionId = new Map<string, QueuedAssistantMessage[]>();
const workerActiveForSession = new Set<string>();

const PROGRESS_EDIT_EVERY_MS = 2000;

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

function escapeCodeBlock(text: string): string {
  // Prevent accidental termination of the code block.
  return text.replace(/```/g, '``\u200b`');
}

function wrapProgress(text: string): string {
  return `\`\`\`text\n${escapeCodeBlock(text)}\n\`\`\``;
}

function createThrottledEditor(progressMsg: Message, initialRendered?: string) {
  let lastRendered = initialRendered || '';
  let nextAllowedAt = Date.now() + PROGRESS_EDIT_EVERY_MS;
  let timer: NodeJS.Timeout | null = null;
  let pending: string | null = null;
  let closed = false;

  const flush = async () => {
    if (closed) return;
    if (!pending) return;
    const text = pending;
    pending = null;

    if (text === lastRendered) return;
    lastRendered = text;
    nextAllowedAt = Date.now() + PROGRESS_EDIT_EVERY_MS;

    try {
      await progressMsg.edit(text);
    } catch {
      // ignore
    }
  };

  const request = (rendered: string) => {
    if (closed) return;
    pending = wrapProgress(rendered);
    if (timer) return;

    const delay = Math.max(0, nextAllowedAt - Date.now());
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, delay);
  };

  const close = () => {
    closed = true;
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { request, close };
}

function isCancelText(text: string): boolean {
  const cmd = text.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
  return cmd === '/cancel' || cmd === 'cancel' || cmd === 'stop';
}

function isConfirmText(text: string): boolean {
  const cmd = text.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
  return cmd === 'yes' || cmd === '/confirm' || cmd === 'confirm';
}

function isRejectText(text: string): boolean {
  const cmd = text.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
  return cmd === 'no' || cmd === '/no' || cmd === '/cancel' || cmd === 'cancel';
}

function ensureQueue(sessionId: string): QueuedAssistantMessage[] {
  const q = queuedBySessionId.get(sessionId);
  if (q) return q;
  const next: QueuedAssistantMessage[] = [];
  queuedBySessionId.set(sessionId, next);
  return next;
}

function getManagedAssistantChannelIds(state: StateStore): string[] {
  const list = state.snapshot.assistant.managedChannelIds;
  if (!Array.isArray(list)) return [];
  return list;
}

function getChannelDir(cfg: AppConfig, channelId: string): string {
  return join(cfg.assistantDir, 'channels', channelId);
}

function getChannelMemoryPath(cfg: AppConfig, channelId: string): string {
  return join(getChannelDir(cfg, channelId), 'memory.md');
}

function readChannelMemory(cfg: AppConfig, channelId: string): string {
  const path = getChannelMemoryPath(cfg, channelId);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function truncateForPrompt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

export function registerEventHandlers(client: Client, ctx: AppContext) {
  client.once(Events.ClientReady, async () => {
    const guildId = ctx.cfg.discordGuildId;
    if (!guildId) return;
    if (!ctx.state.isAssistantEnabled()) return;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const blipsStreamChannelId = ctx.state.snapshot.assistant.channels.blipsStream;
    await ensureBlipsStreamCard({ client, guild, blipsStreamChannelId }).catch(() => {});
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, ctx);
      return;
    }

    if (interaction.isButton() && isBlipsStreamCustomId(interaction.customId)) {
      await handleBlipsStreamButton(interaction);
      return;
    }

    if (interaction.isModalSubmit() && isBlipsStreamCustomId(interaction.customId)) {
      await handleBlipsStreamModal(interaction);
      return;
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const assistantChannels = ctx.state.snapshot.assistant.channels;
    const managed = getManagedAssistantChannelIds(ctx.state);

    // Reply-to anywhere: if the user is replying to an assistant/progress message,
    // continue/cancel/queue regardless of which channel it's in.
    if (message.reference?.messageId) {
      try {
        const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedTo.author.bot) {
          const sessionId = getSession(repliedTo.id);
          const isInFlight = runningByProgressMessageId.has(repliedTo.id);
          if (sessionId || isInFlight) {
            await handleAssistantMessage(message, ctx);
            return;
          }
        }
      } catch {
        // ignore
      }
    }

    const isLobbyChannel =
      assistantChannels.lobby
        ? message.channelId === assistantChannels.lobby
        : (message.channel as any)?.name === 'assistant';

    // Lobby channel (assistant "control plane"): create/confirm managed channels.
    if (isLobbyChannel && ctx.state.isAssistantEnabled()) {
      await handleLobbyMessage(message, ctx);
      return;
    }

    // Blips channel - natural language capture (text and/or URLs)
    if (message.channelId === assistantChannels.blips && ctx.state.isAssistantEnabled()) {
      await handleBlipCapture(message, ctx);
      return;
    }

    // Meditation logs channel - voice messages appended to daily notes
    const isMeditationLogsChannel =
      assistantChannels.meditationLogs
        ? message.channelId === assistantChannels.meditationLogs
        : (message.channel as any)?.name === 'meditation-logs';

    if (isMeditationLogsChannel && ctx.state.isAssistantEnabled()) {
      await handleMeditationLog(message, ctx);
      return;
    }

    // Dailies channel - voice messages appended to daily notes
    const isDailiesChannel =
      assistantChannels.dailies
        ? message.channelId === assistantChannels.dailies
        : (message.channel as any)?.name === 'dailies';

    if (isDailiesChannel && ctx.state.isAssistantEnabled()) {
      await handleDailyLog(message, ctx);
      return;
    }

    // Blips stream: keep a single Components V2 "current blip" card updated.
    const isBlipsStreamChannel =
      assistantChannels.blipsStream
        ? message.channelId === assistantChannels.blipsStream
        : (message.channel as any)?.name === 'blips-stream';

    if (isBlipsStreamChannel && ctx.state.isAssistantEnabled()) {
      // Ignore chatter; only refresh the stream card.
      await ensureBlipsStreamCard({
        client,
        guild: message.guild as any,
        blipsStreamChannelId: assistantChannels.blipsStream,
      });
      return;
    }

    // Other configured assistant channels (morning checkin)
    const isAssistantChannel =
      message.channelId === assistantChannels.morningCheckin;

    const isManagedChannel = managed.includes(message.channelId);

    if ((isAssistantChannel || isManagedChannel) && ctx.state.isAssistantEnabled()) {
      await handleAssistantMessage(message, ctx);
      return;
    }

    // Treat any text channel under the assistant category as an assistant channel.
    if (ctx.state.isAssistantEnabled()) {
      const parentId = (message.channel as any)?.parentId;
      if (typeof parentId === 'string' && parentId) {
        try {
          const categoryId = await resolveAssistantCategoryId(message.guild as any, ctx);
          if (categoryId && parentId === categoryId) {
            await handleAssistantMessage(message, ctx);
            return;
          }
        } catch {
          // ignore
        }
      }
    }
  });
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const { commandName } = interaction;
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
    return;
  }

  try {
    switch (commandName) {
      case 'blip':
        await handleBlip(interaction, ctx);
        break;
      case 'assistant':
        await handleAssistant(interaction, ctx);
        break;
      case 'help':
        await handleHelp(interaction);
        break;
      default:
        await interaction.reply({ content: `Unknown command: /${commandName}`, ephemeral: true });
    }
  } catch (e: any) {
    const errorMsg = e?.message || String(e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `Error: ${errorMsg}` });
    } else {
      await interaction.reply({ content: `Error: ${errorMsg}`, ephemeral: true });
    }
  }
}

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const help = [
    '**Personal Assistant**',
    '',
    '**Lobby**',
    '• Post in the lobby to create purpose-built channels (with confirmation)',
    '',
    '**Blips** (small ideas to incubate)',
    '• `/blip capture <content>` - Capture a new blip',
    '• `/blip list` - Show recent blips',
    '• `/blip surface` - Get blips ready for review',
    '• `/blip note <id> <note>` - Add a note',
    '• `/blip snooze <id>` - Hide for a while',
    '• `/blip archive <id>` - Archive a blip',
    '',
    '**Blips Channel** (just post anything)',
    '• Text becomes a blip',
    '• URLs get fetched and embedded automatically',
    '',
    '**Settings**',
    '• `/assistant enable` - Enable/disable assistant',
    '• `/assistant channel` - Set channels',
    '• `/assistant category` - Set category for created channels',
    '• `/assistant status` - Show configuration',
    '• `/assistant sync` - Sync with vault',
  ].join('\n');

  await interaction.reply(help);
}

// ============== Reply Chain Traversal ==============

interface ThreadMessage {
  author: 'User' | 'Assistant';
  content: string;
  messageId: string;
}

/**
 * Follow the reply chain backwards to build full conversation thread.
 * This enables session-like behavior where replying continues a conversation.
 * Multiple replies to the same message create independent "forks".
 */
async function getReplyChain(message: Message, maxDepth = 100): Promise<ThreadMessage[]> {
  const chain: ThreadMessage[] = [];
  let current: Message | null = message;
  let depth = 0;

  while (current && depth < maxDepth) {
    // Don't include the current message being processed
    if (current.id !== message.id) {
      chain.unshift({
        author: current.author.bot ? 'Assistant' : 'User',
        content: current.content,
        messageId: current.id,
      });
    }

    // Follow the reply reference
    if (current.reference?.messageId) {
      try {
        current = await current.channel.messages.fetch(current.reference.messageId);
        depth++;
      } catch {
        // Referenced message deleted or inaccessible
        break;
      }
    } else {
      break;
    }
  }

  return chain;
}

// ============== Assistant Message Handler ==============

/**
 * Resolve what a reply is targeting:
 * - a known Claude session (stored mapping)
 * - an in-flight run (progress message) where the session may not be known yet
 */
async function getReplyTarget(message: Message): Promise<{
  resumeId: string | null;
  running: RunningAssistantTask | null;
  repliedToId: string | null;
}> {
  if (!message.reference?.messageId) return { resumeId: null, running: null, repliedToId: null };

  try {
    const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    if (repliedTo.author.bot) {
      // Look up session ID from our store
      const resumeId = getSession(repliedTo.id);
      const running = runningByProgressMessageId.get(repliedTo.id) || null;
      return { resumeId, running, repliedToId: repliedTo.id };
    }
  } catch {
    // Message deleted or inaccessible
  }
  return { resumeId: null, running: null, repliedToId: null };
}

async function cancelRunningTask(task: RunningAssistantTask, reason = 'Cancelled.'): Promise<boolean> {
  if (task.cancelled) return true;
  task.cancelled = true;
  try {
    task.abortController.abort(reason);
  } catch {}
  return true;
}

async function enqueueSessionMessage(item: QueuedAssistantMessage, sessionId: string): Promise<number> {
  const queue = ensureQueue(sessionId);
  queue.push(item);
  return queue.length;
}

// ============== Lobby: managed channel creation/deletion ==============

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

async function proposeUniqueChannelName(guild: any, base: string): Promise<string> {
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

async function generateChannelQuestions(purpose: string): Promise<string> {
  const prompt = `You are helping configure a new Discord channel for a personal assistant system.

The user said they want a channel for:

${purpose}

Ask 4-6 clarifying questions to remove ambiguity and define how the channel should work.

Questions should be short and concrete and cover:
- what “success” looks like
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
    '2. What does “success” look like after 1 week of using it?',
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
  const purposeOut = typeof parsed?.purpose === 'string' ? String(parsed.purpose).slice(0, 200) : safePurpose;
  const memoryContent = typeof parsed?.memoryContent === 'string' && parsed.memoryContent.trim() ? parsed.memoryContent : fallbackMemory;

  return { name, topic, purpose: purposeOut, memoryContent };
}

function ensureChannelMemoryInitialized(cfg: AppConfig, channel: any, purposeHint?: string): void {
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

async function resolveAssistantCategoryId(guild: any, ctx: AppContext): Promise<string | null> {
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

async function handleLobbyMessage(message: Message, ctx: AppContext): Promise<void> {
  let text = message.content.trim();
  if (!message.guild) return;

  // Check for voice message attachments and transcribe them
  const voiceAttachments = getVoiceAttachments(message);
  if (voiceAttachments.length > 0) {
    const { transcripts, errors } = await transcribeMessageVoice(message);

    if (transcripts.length > 0) {
      const voiceText = transcripts.map((t, i) =>
        voiceAttachments.length > 1 ? `[Voice message ${i + 1}]: ${t}` : `[Voice message]: ${t}`
      ).join('\n\n');

      text = text ? `${voiceText}\n\n${text}` : voiceText;
    } else if (errors.length > 0 && !text) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
      return;
    }
  }

  if (!text) return;

  // Confirm/reject a pending action by replying to the proposal message.
  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedTo.author.bot) {
        const wizard = pendingCreateWizardsByQuestionMessageId.get(repliedTo.id);
        if (wizard && wizard.guildId === message.guild.id) {
          if (wizard.requesterId !== message.author.id) {
            await message.reply('Only the requester can answer those questions.');
            return;
          }

          if (isRejectText(text)) {
            pendingCreateWizardsByQuestionMessageId.delete(repliedTo.id);
            await message.reply('Ok — cancelled channel creation.');
            return;
          }

          pendingCreateWizardsByQuestionMessageId.delete(repliedTo.id);
          const categoryId = (await resolveAssistantCategoryId(message.guild as any, ctx)) || null;
          if (!categoryId) {
            await message.reply('Set the assistant category first with `/assistant category`.');
            return;
          }

          const spec = await synthesizeChannelSpec({ purpose: wizard.purpose, answers: text });
          const name = await proposeUniqueChannelName(message.guild as any, spec.name);

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
          return;
        }

        const pending = pendingLobbyActionsByProposalMessageId.get(repliedTo.id);
        if (pending && pending.guildId === message.guild.id) {
          if (pending.requesterId !== message.author.id) {
            await message.reply('Only the requester can confirm that action.');
            return;
          }

          if (isRejectText(text)) {
            pendingLobbyActionsByProposalMessageId.delete(repliedTo.id);
            await message.reply('Ok — not doing that.');
            return;
          }

          if (!isConfirmText(text)) {
            await message.reply('Reply `yes` to confirm, or `no` to cancel.');
            return;
          }

          pendingLobbyActionsByProposalMessageId.delete(repliedTo.id);

          if (pending.kind === 'create-channel') {
            const categoryId =
              pending.categoryId || (await resolveAssistantCategoryId(message.guild as any, ctx)) || null;
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
            return;
          }

          if (pending.kind === 'delete-channel') {
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
            return;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const createReq = parseCreateChannelRequest(text);
  if (createReq) {
    const categoryId = (await resolveAssistantCategoryId(message.guild as any, ctx)) || null;
    if (!categoryId) {
      await message.reply('Set the assistant category first with `/assistant category`.');
      return;
    }

    const purpose = createReq.purpose.trim().slice(0, 200);
    const questions = await generateChannelQuestions(purpose);
    const questionMsg = await message.reply(
      [
        `Before I create a channel for **${purpose}**, a few quick questions:`,
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
      purpose,
    });
    return;
  }

  const delReq = parseDeleteChannelRequest(text);
  if (delReq) {
    const managed = getManagedAssistantChannelIds(ctx.state);
    if (!managed.includes(delReq.channelId)) {
      await message.reply('I will only delete channels I created (managed channels).');
      return;
    }

    const proposal = await message.reply(
      [`Proposed: delete <#${delReq.channelId}>.`, '', 'Reply `yes` to confirm, or `no` to cancel.'].join(
        '\n'
      )
    );
    pendingLobbyActionsByProposalMessageId.set(proposal.id, {
      kind: 'delete-channel',
      requesterId: message.author.id,
      guildId: message.guild.id,
      channelId: delReq.channelId,
    });
    return;
  }

  // Not a control-plane message; treat lobby as a normal assistant channel too.
  await handleAssistantMessage(message, ctx);
}

async function maybeStartSessionWorker(sessionId: string, ctx: AppContext): Promise<void> {
  if (workerActiveForSession.has(sessionId)) return;
  if (runningBySessionId.has(sessionId)) return;

  const queue = queuedBySessionId.get(sessionId);
  if (!queue || queue.length === 0) return;

  workerActiveForSession.add(sessionId);
  (async () => {
    try {
      // Drain sequentially; runner itself also serializes per session, but we want immediate UX.
      while (true) {
        const q = queuedBySessionId.get(sessionId);
        const next = q?.shift();
        if (!next) break;
        await runAssistantTurn(next.message, ctx, {
          text: next.text,
          channelType: next.channelType,
          resumeId: sessionId,
        });
      }
    } finally {
      workerActiveForSession.delete(sessionId);
      const q = queuedBySessionId.get(sessionId);
      if (q && q.length === 0) queuedBySessionId.delete(sessionId);
    }
  })().catch(() => {
    // Best-effort: don't crash the bot on queue worker errors.
    workerActiveForSession.delete(sessionId);
  });
}

async function handleAssistantMessage(message: Message, ctx: AppContext): Promise<void> {
  let text = message.content.trim();

  // Check for voice message attachments and transcribe them
  const voiceAttachments = getVoiceAttachments(message);
  if (voiceAttachments.length > 0) {
    const { transcripts, errors } = await transcribeMessageVoice(message);

    if (transcripts.length > 0) {
      // Prepend transcripts to the text content
      const voiceText = transcripts.map((t, i) =>
        voiceAttachments.length > 1 ? `[Voice message ${i + 1}]: ${t}` : `[Voice message]: ${t}`
      ).join('\n\n');

      text = text ? `${voiceText}\n\n${text}` : voiceText;
    } else if (errors.length > 0 && !text) {
      // Only voice message(s) but transcription failed
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
      return;
    }
  }

  if (!text) return;

  const assistantChannels = ctx.state.snapshot.assistant.channels;
  let channelType: QueuedAssistantMessage['channelType'] = 'general';
  if (message.channelId === assistantChannels.morningCheckin) channelType = 'morning-checkin';
  else if (message.channelId === assistantChannels.blips) channelType = 'blips';
  else if (message.channelId === assistantChannels.lobby) channelType = 'lobby';

  // Ensure per-channel memory exists for managed/category channels (not for core channels).
  const isCore =
    message.channelId === assistantChannels.morningCheckin ||
    message.channelId === assistantChannels.blips ||
    message.channelId === assistantChannels.lobby;
  if (!isCore) {
    const managed = getManagedAssistantChannelIds(ctx.state);
    const isManaged = managed.includes(message.channelId);
    let isInCategory = false;
    if (!isManaged) {
      const parentId = (message.channel as any)?.parentId;
      if (typeof parentId === 'string' && parentId) {
        try {
          const categoryId = await resolveAssistantCategoryId(message.guild as any, ctx);
          isInCategory = Boolean(categoryId && parentId === categoryId);
        } catch {
          // ignore
        }
      }
    }
    if (isManaged || isInCategory) {
      ensureChannelMemoryInitialized(ctx.cfg, message.channel);
    }
  }

  const target = await getReplyTarget(message);

  // Reply-to-progress message support:
  // - if the run is in-flight and session not ready yet, queue it on the task
  // - otherwise, queue it on the session worker (serialized like takopi)
  if (target?.running) {
    if (isCancelText(text)) {
      await cancelRunningTask(target.running);
      await message.reply('cancelling…');
      return;
    }

    // In-flight run but session isn't known yet; queue until `started` arrives.
    if (!target.resumeId) {
      target.running.preSessionQueue.push({ message, text, channelType });
      target.running.queueCount = target.running.preSessionQueue.length;
      await target.running.requestRender?.();
      return;
    }
  }

  const resumeId = target?.resumeId || null;

  if (resumeId) {
    if (isCancelText(text)) {
      const running = runningBySessionId.get(resumeId);
      if (running) {
        await cancelRunningTask(running);
        await message.reply('cancelling…');
      } else {
        await message.reply('nothing running for that thread.');
      }
      return;
    }

    // If something is already running for this session, queue it.
    if (runningBySessionId.has(resumeId) || (queuedBySessionId.get(resumeId)?.length || 0) > 0) {
      const pos = await enqueueSessionMessage({ message, text, channelType }, resumeId);
      const running = runningBySessionId.get(resumeId);
      if (running) {
        running.queueCount = pos;
        await running.requestRender?.();
      }
      await maybeStartSessionWorker(resumeId, ctx);
      return;
    }

    await runAssistantTurn(message, ctx, { text, channelType, resumeId });
    return;
  }

  // Fresh message (new Claude session)
  await runAssistantTurn(message, ctx, { text, channelType, resumeId: null });
}

async function runAssistantTurn(
  message: Message,
  ctx: AppContext,
  opts: { text: string; channelType: QueuedAssistantMessage['channelType']; resumeId: string | null }
): Promise<void> {
  const { text, channelType, resumeId } = opts;

  // Check for session metadata to ensure model consistency
  const metadata = resumeId ? getSessionMetadata(resumeId) : undefined;
  const model = metadata?.model || 'opus';

  const channelMemory = readChannelMemory(ctx.cfg, message.channelId);
  const channelContext = channelMemory
    ? `## Channel Memory\n\n${truncateForPrompt(channelMemory, 3000)}\n\n`
    : '';

  // Build conversation context - only needed if NOT resuming (Claude has context already)
  let conversationContext = '';
  if (!resumeId) {
    const replyChain = await getReplyChain(message);

    if (replyChain.length > 0) {
      conversationContext += `## Conversation Thread\n\n`;
      for (const msg of replyChain) {
        const truncated = msg.content.length > 800 ? msg.content.slice(0, 800) + '...' : msg.content;
        conversationContext += `**${msg.author}:** ${truncated}\n\n`;
      }
    } else {
      try {
        const recentMessages = await message.channel.messages.fetch({ limit: 4, before: message.id });
        const relevant = Array.from(recentMessages.values())
          .reverse()
          .map((m) => {
            const author = m.author.bot ? 'Assistant' : 'User';
            return `**${author}:** ${m.content.slice(0, 300)}${m.content.length > 300 ? '...' : ''}`;
          });

        if (relevant.length > 0) {
          conversationContext += `## Recent Channel Messages (may be unrelated - ignore if not relevant)\n\n${relevant.join('\n\n')}\n\n`;
        }
      } catch {
        // ignore
      }
    }
  }

  const progressRenderer = new ProgressRenderer();
  const initialProgress = progressRenderer.render('thinking', 0, 'claude');

  const progressMsg = await message.reply(wrapProgress(initialProgress));
  const progressEditor = createThrottledEditor(progressMsg, wrapProgress(initialProgress));

  let resolveResumeReady: (sessionId: string) => void;
  const resumeReady = new Promise<string>((resolve) => {
    resolveResumeReady = resolve;
  });

  const task: RunningAssistantTask = {
    progressMessageId: progressMsg.id,
    sessionId: resumeId,
    resumeReady,
    resolveResumeReady: resolveResumeReady!,
    abortController: new AbortController(),
    cancelled: false,
    preSessionQueue: [],
    queueCount: resumeId ? (queuedBySessionId.get(resumeId)?.length || 0) : 0,
    currentState: 'thinking',
  };

  task.requestRender = async () => {
    const rendered = progressRenderer.render(task.currentState, task.queueCount, 'claude');
    (progressEditor as any).request(rendered);
  };

  runningByProgressMessageId.set(progressMsg.id, task);
  if (resumeId) {
    runningBySessionId.set(resumeId, task);
    task.resolveResumeReady(resumeId);
    storeSession(progressMsg.id, resumeId);
  }

  await task.requestRender();

  const prompt = resumeId
    ? `${channelContext}${text}`
    : `You are the personal assistant responding in the ${channelType} Discord channel.

${buildAssistantContext()}

${channelContext}${conversationContext}## Current User Message

${text}

## Instructions

Respond as a thoughtful personal assistant. Remember:
- Encourage thinking, don't just give answers
- Ask clarifying questions
- Be concise and direct
- No emojis unless the user uses them
- If this is about a blip, help develop the idea
- If this is a response to a question, acknowledge and follow up
- You have FULL CONTEXT of the conversation above - reference it naturally

If the user shares something you should remember, note it. If they correct you, acknowledge it.

Output ONLY your response message, nothing else.`;

  let finalSessionId: string | null = resumeId;

  try {
    const result = await invokeClaude(prompt, {
      model,
      resumeId: resumeId || undefined,
      signal: task.abortController.signal,
      onEvent: async (event: RunnerEvent) => {
        if (event.type === 'started' && event.sessionId) {
          if (!task.sessionId) {
            task.sessionId = event.sessionId;
            finalSessionId = event.sessionId;
            runningBySessionId.set(event.sessionId, task);
            storeSession(progressMsg.id, event.sessionId);
            task.resolveResumeReady(event.sessionId);

            // If someone replied while the run was booting, move those messages into the session queue now.
            for (const queued of task.preSessionQueue) {
              await enqueueSessionMessage(queued, event.sessionId);
            }
            task.preSessionQueue = [];
            task.queueCount = queuedBySessionId.get(event.sessionId)?.length || 0;
            await task.requestRender?.();
          }
        }

        const shouldUpdate = progressRenderer.noteEvent(event);
        if (!shouldUpdate) return;

        task.currentState = 'thinking';
        if (event.type === 'tool_start') task.currentState = 'tool';
        else if (event.type === 'text') task.currentState = 'writing';

        const rendered = progressRenderer.render(task.currentState, task.queueCount, 'claude');
        (progressEditor as any).request(rendered);
      },
    });

    if (result.text && result.ok) {
      progressEditor.close();
      const toolsSummary =
        result.toolsUsed.length > 0
          ? `\n\n_${result.toolsUsed.join(', ')} · ${(result.durationMs / 1000).toFixed(1)}s_`
          : `\n\n_${(result.durationMs / 1000).toFixed(1)}s_`;

      const maxLen = 2000 - toolsSummary.length;
      const responseText = result.text.slice(0, maxLen) + toolsSummary;

      await progressMsg.edit(responseText);

      storeSession(progressMsg.id, result.sessionId);

      if (result.text.length > maxLen) {
        let remaining = result.text.slice(maxLen);
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, 1900);
          const followUp = await message.reply(chunk);
          storeSession(followUp.id, result.sessionId);
          remaining = remaining.slice(1900);
        }
      }
    } else {
      progressEditor.close();
      const errorMsg = result.text || 'I had trouble processing that. Please try again.';
      await progressMsg.edit(errorMsg);
    }
  } catch (error: any) {
    progressEditor.close();
    const msg = `I had trouble processing that. ${error?.message || 'Please try again.'}`;
    await progressMsg.edit(msg);
  } finally {
    progressEditor.close();
    runningByProgressMessageId.delete(progressMsg.id);

    const sid = finalSessionId || task.sessionId;
    if (sid && runningBySessionId.get(sid) === task) {
      runningBySessionId.delete(sid);
      await maybeStartSessionWorker(sid, ctx);
    }
  }
}

// ============== Blip Discussion Handler ==============

/**
 * Handle plain text in blips channel: discuss first, then offer to save.
 * This encourages developing ideas before capturing them.
 */
async function handleBlipDiscussion(message: Message, ctx: AppContext, text: string): Promise<void> {
  const progressRenderer = new ProgressRenderer();
  const initialProgress = progressRenderer.render('thinking', 0, 'claude', 'thinking');
  const progressMsg = await message.reply(wrapProgress(initialProgress));
  const progressEditor = createThrottledEditor(progressMsg, wrapProgress(initialProgress));

  const prompt = `You are the personal assistant. The user posted this idea/thought in the blips channel:

---
${text}
---

${buildAssistantContext()}

## Your Role

This is an idea or thought the user shared. Blips are stored as markdown files in: ${ctx.cfg.blipsDir}/

**Decision tree:**

1. **If the idea is clear enough to save** (observations, thoughts, ideas, questions - anything that's a distinct capture):
   - **Default to saving** - err on the side of capturing
   - Save it immediately as a blip using the \`Write\` tool
   - Confirm what you saved
   - Optionally ask a brief follow-up question to develop it further

2. **If the idea is ambiguous or half-formed** (needs clarification before it's worth saving):
   - Ask 1-2 clarifying questions to sharpen it
   - Make connections to other blips if relevant
   - **ALWAYS end with:** "Want me to save this as a blip now, or develop it more first?"

**Blip file format:**
\`\`\`markdown
---
title: "Descriptive title"
status: active
created: YYYY-MM-DD
touched: YYYY-MM-DD
tags: [relevant, tags]
related: []
---

The idea or thought

## Log

- **YYYY-MM-DD**: Captured from Discord
\`\`\`

**File naming:** \`YYYY-MM-DD-slug-from-title.md\`

Keep responses concise.`;

  try {
    const result = await invokeClaude(prompt, {
      model: 'opus', // Use Opus for consistent high-quality reasoning
      onEvent: async (event: RunnerEvent) => {
        const shouldUpdate = progressRenderer.noteEvent(event);
        if (!shouldUpdate) return;

        let currentState: 'thinking' | 'tool' | 'writing' = 'thinking';
        if (event.type === 'tool_start') {
          currentState = 'tool';
        } else if (event.type === 'text') {
          currentState = 'writing';
        }

        const label = currentState === 'writing' ? 'writing' : 'thinking';
        progressEditor.request(progressRenderer.render(currentState, 0, 'claude', label));
      },
    });

    if (result.text && result.ok) {
      progressEditor.close();
      const toolsSummary =
        result.toolsUsed.length > 0
          ? `\n\n_${result.toolsUsed.join(', ')} · ${(result.durationMs / 1000).toFixed(1)}s_`
          : `\n\n_${(result.durationMs / 1000).toFixed(1)}s_`;

      const maxLen = 2000 - toolsSummary.length;
      await progressMsg.edit(result.text.slice(0, maxLen) + toolsSummary);

      // Store session for follow-up replies
      storeSession(progressMsg.id, result.sessionId);

      // Persist metadata to ensure follow-ups use the same model and context
      setSessionMetadata(result.sessionId, {
        model: 'opus',
        type: 'blip-discussion',
      });
    } else {
      progressEditor.close();
      await progressMsg.edit(`Something went wrong: ${result.text || 'No response'}`);
    }
  } catch (error: any) {
    progressEditor.close();
    await progressMsg.edit(`Error: ${error?.message || 'Unknown error'}`);
  } finally {
    progressEditor.close();
  }
}

// ============== Blip Capture Handler ==============

async function handleBlipCapture(message: Message, ctx: AppContext): Promise<void> {
  let text = message.content.trim();

  // Check for voice message attachments and transcribe them
  const voiceAttachments = getVoiceAttachments(message);
  if (voiceAttachments.length > 0) {
    const { transcripts, errors } = await transcribeMessageVoice(message);

    if (transcripts.length > 0) {
      const voiceText = transcripts.map((t, i) =>
        voiceAttachments.length > 1 ? `[Voice message ${i + 1}]: ${t}` : `[Voice message]: ${t}`
      ).join('\n\n');

      text = text ? `${voiceText}\n\n${text}` : voiceText;
    } else if (errors.length > 0 && !text) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
      return;
    }
  }

  if (!text) return;

  // PRIORITY: If this is a reply to a bot message, route to assistant handler
  // This ensures session context is preserved for follow-up messages like "yes"
  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedTo.author.bot) {
        // This is a reply to the bot - use assistant handler to resume session
        await handleAssistantMessage(message, ctx);
        return;
      }
    } catch {
      // Message deleted or inaccessible, continue with normal flow
    }
  }

  const urls = extractUrls(text);
  const hasUrls = urls.length > 0;

  // Check if this looks like a command/request rather than content to capture
  const looksLikeCommand = /^(what|list|show|surface|add|snooze|archive|save|tell|help|can you)/i.test(text);

  // For plain text without URLs and not a command: discuss first, then offer to save
  if (!hasUrls && !looksLikeCommand) {
    await handleBlipDiscussion(message, ctx, text);
    return;
  }

  // For commands without URLs: route to assistant handler
  if (!hasUrls && looksLikeCommand) {
    await handleAssistantMessage(message, ctx);
    return;
  }

  // For URLs: auto-capture
  const force = /\bforce\b/i.test(text);
  const duplicates: Array<{ url: string; existingFilename: string }> = [];
  const urlsToCapture: string[] = [];
  for (const url of urls) {
    const existing = force ? null : findBlipBySource(url);
    if (existing) duplicates.push({ url, existingFilename: existing.filename });
    else urlsToCapture.push(url);
  }

  if (urlsToCapture.length === 0) {
    const lines = [
      `Already captured ${duplicates.length === 1 ? 'that link' : 'those links'}:`,
      ...duplicates.slice(0, 5).map((d) => `- \`${d.existingFilename}\``),
      '',
      'If you really want a fresh copy, add `force` to your message.',
    ];
    await message.reply(lines.join('\n').slice(0, 2000));
    return;
  }

  const progressMsg = await message.reply(wrapProgress('capturing · 0s\n\n▸ Fetching...'));
  let lastUpdateTime = Date.now();
  let lastRendered = '';

  const captureResults: Array<
    { url: string; captureFilename: string; title: string; author?: string; type: string }
    | { url: string; error: string }
  > = [];
  const updateCaptureProgress = (line: string) => {
    const now = Date.now();
    if (now - lastUpdateTime < PROGRESS_EDIT_EVERY_MS) return;
    lastUpdateTime = now;
    const msg = wrapProgress(`capturing\n\n▸ ${line}`);
    if (msg === lastRendered) return;
    lastRendered = msg;
    progressMsg.edit(msg).catch(() => {});
  };
  for (const url of urlsToCapture) {
    try {
      const captured = await captureUrlToFile(url, updateCaptureProgress);
      if (captured.success) {
        captureResults.push({
          url,
          captureFilename: captured.captureFilename,
          title: captured.meta.title,
          author: captured.meta.author,
          type: captured.meta.type,
        });
      } else {
        captureResults.push({ url, error: captured.error });
      }
    } catch (e: any) {
      captureResults.push({ url, error: e?.message || 'capture failed' });
    }
  }

  try {
    const successes = captureResults.filter((r): r is { url: string; captureFilename: string; title: string; author?: string; type: string } => 'captureFilename' in r);
    const failures = captureResults.filter((r): r is { url: string; error: string } => 'error' in r);

    if (successes.length === 0) {
      const details = failures.slice(0, 3).map((f) => `- ${f.url}: ${f.error}`).join('\n');
      await progressMsg.edit(`Couldn’t capture that link.\n\n${details || 'Unknown error'}`);
      return;
    }

    const primary = successes[0];
    const captureField = successes.length === 1 ? primary.captureFilename : undefined;

    const captureLines = successes.map((c) => `- Full capture: ~/.assistant/captures/${c.captureFilename}`).join('\n');
    const failureLines = failures.length > 0
      ? `\n\n## Capture Failures\n\n${failures.map((f) => `- ${f.url}: ${f.error}`).join('\n')}`
      : '';

    const blipContent = [
      `Captured from Discord.`,
      '',
      `## Capture`,
      '',
      captureLines,
      '',
      `## Notes`,
      '',
      `(Add your notes / highlights here.)`,
      failureLines,
    ].join('\n');

    const blipPath = createBlip({
      title: primary.title || 'Captured link',
      content: blipContent,
      source: canonicalizeBlipSource(primary.url),
      author: primary.author,
      capture: captureField,
      logEntry: 'Captured from Discord',
    });

    const filename = blipPath.split('/').pop() || blipPath;
    const shortTitle = primary.title && primary.title.length > 100 ? primary.title.slice(0, 100) + '…' : (primary.title || 'Captured link');

    const response = [
      `Captured blip \`${filename}\``,
      `- Title: ${shortTitle}`,
      ...successes.map((c) => `- Full capture: ~/.assistant/captures/${c.captureFilename}`),
      duplicates.length > 0
        ? `- Skipped ${duplicates.length} duplicate(s): ${duplicates
            .slice(0, 3)
            .map((d) => `\`${d.existingFilename}\``)
            .join(', ')}${duplicates.length > 3 ? ', …' : ''}`
        : '',
      failures.length > 0 ? `- (${failures.length} capture(s) failed; see blip for details)` : '',
      '',
      `Reply to this message if you want a summary or highlights.`,
    ].filter(Boolean).join('\n');

    await progressMsg.edit(response.slice(0, 2000));
  } catch (error: any) {
    await progressMsg.edit(`Error: ${error?.message || 'Unknown error'}`);
  }
}

// ============== Meditation Log Handler ==============

async function handleMeditationLog(message: Message, ctx: AppContext): Promise<void> {
  // Only handle voice messages
  const voiceAttachments = getVoiceAttachments(message);
  if (voiceAttachments.length === 0) {
    // Text messages can be handled too - just append them directly
    const text = message.content.trim();
    if (!text) return;

    await appendMeditationEntry(text, message, ctx);
    return;
  }

  // Transcribe voice message(s)
  const { transcripts, errors } = await transcribeMessageVoice(message);

  if (transcripts.length === 0) {
    if (errors.length > 0) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
    }
    return;
  }

  // Combine all transcripts
  const fullTranscript = transcripts.join('\n\n');
  await appendMeditationEntry(fullTranscript, message, ctx);
}

async function appendMeditationEntry(content: string, message: Message, ctx: AppContext): Promise<void> {
  const vaultPath = ctx.cfg.vaultPath;

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split('T')[0];
  const dailyNotePath = join(vaultPath, 'Daily', `${today}.md`);

  // Format the entry with timestamp (Pacific time)
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
  const entry = `\n### Meditation (${timeStr} PT)\n\n${content}\n`;

  try {
    // Ensure daily folder exists
    mkdirSync(dirname(dailyNotePath), { recursive: true });

    // Append to daily note
    appendFileSync(dailyNotePath, entry, 'utf-8');

    // Git: pull, commit, and push the change
    // If pull fails, still commit locally but skip push (vault-sync timer will handle it)
    let pullOk = true;
    try {
      execSync(`git pull --rebase`, {
        cwd: vaultPath,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (pullErr: any) {
      pullOk = false;
      console.error('[MeditationLog] Git pull failed:', pullErr.message);
    }

    try {
      // Always commit locally so the change is captured
      const commitCmd = pullOk
        ? `git add -A && git commit -m "meditation log: ${today}" && git push`
        : `git add -A && git commit -m "meditation log: ${today}"`;  // Skip push if pull failed
      execSync(commitCmd, {
        cwd: vaultPath,
        timeout: 30000,
        stdio: 'pipe',
      });
      if (!pullOk) {
        console.log('[MeditationLog] Committed locally; skipped push (pull failed). vault-sync will handle it.');
      }
    } catch (gitErr: any) {
      // Commit might fail if nothing to commit (already committed) - that's ok
      if (!gitErr.message?.includes('nothing to commit')) {
        console.error('[MeditationLog] Git commit failed:', gitErr.message);
      }
    }

    // React with thumbs up and reply with word count
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    await message.react('👍');
    await message.reply(`Logged ${wordCount} words to \`Daily/${today}.md\``);
  } catch (err: any) {
    console.error('[MeditationLog] Failed to append:', err);
    await message.reply(`Failed to log meditation: ${err.message}`);
  }
}

// ============== Daily Log Handler ==============

async function handleDailyLog(message: Message, ctx: AppContext): Promise<void> {
  // Only handle voice messages
  const voiceAttachments = getVoiceAttachments(message);
  if (voiceAttachments.length === 0) {
    // Text messages can be handled too - just append them directly
    const text = message.content.trim();
    if (!text) return;

    await appendDailyEntry(text, message, ctx);
    return;
  }

  // Transcribe voice message(s)
  const { transcripts, errors } = await transcribeMessageVoice(message);

  if (transcripts.length === 0) {
    if (errors.length > 0) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
    }
    return;
  }

  // Combine all transcripts
  const fullTranscript = transcripts.join('\n\n');
  await appendDailyEntry(fullTranscript, message, ctx);
}

async function appendDailyEntry(content: string, message: Message, ctx: AppContext): Promise<void> {
  const vaultPath = ctx.cfg.vaultPath;

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split('T')[0];
  const dailyNotePath = join(vaultPath, 'Daily', `${today}.md`);

  // Format the entry with timestamp (Pacific time)
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
  const entry = `\n**Voice note (${timeStr} PT):** ${content}\n`;

  try {
    // Ensure daily folder exists
    mkdirSync(dirname(dailyNotePath), { recursive: true });

    // Append to daily note
    appendFileSync(dailyNotePath, entry, 'utf-8');

    // Git: pull, commit, and push the change
    // If pull fails, still commit locally but skip push (vault-sync timer will handle it)
    let pullOk = true;
    try {
      execSync(`git pull --rebase`, {
        cwd: vaultPath,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (pullErr: any) {
      pullOk = false;
      console.error('[DailyLog] Git pull failed:', pullErr.message);
    }

    try {
      // Always commit locally so the change is captured
      const commitCmd = pullOk
        ? `git add -A && git commit -m "daily log: ${today}" && git push`
        : `git add -A && git commit -m "daily log: ${today}"`;  // Skip push if pull failed
      execSync(commitCmd, {
        cwd: vaultPath,
        timeout: 30000,
        stdio: 'pipe',
      });
      if (!pullOk) {
        console.log('[DailyLog] Committed locally; skipped push (pull failed). vault-sync will handle it.');
      }
    } catch (gitErr: any) {
      // Commit might fail if nothing to commit (already committed) - that's ok
      if (!gitErr.message?.includes('nothing to commit')) {
        console.error('[DailyLog] Git commit failed:', gitErr.message);
      }
    }

    // React with thumbs up and reply with word count
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    await message.react('👍');
    await message.reply(`Logged ${wordCount} words to \`Daily/${today}.md\``);
  } catch (err: any) {
    console.error('[DailyLog] Failed to append:', err);
    await message.reply(`Failed to log daily: ${err.message}`);
  }
}

// ============== Blip Handlers ==============

async function handleBlip(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'capture': {
      const content = interaction.options.getString('content', true);

      // Generate a title from the content (first line or first 50 chars)
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
      break;
    }

    case 'list': {
      const blips = listBlips().slice(0, 10);
      if (blips.length === 0) {
        await interaction.reply({ content: 'No blips yet. Capture one with `/blip capture`!', ephemeral: true });
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
      break;
    }

    case 'show': {
      const filename = interaction.options.getString('id', true);
      const blips = listBlips();
      const summary = blips.find((b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase()));

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

      // Show first part of content (before ## sections)
      const preview = blip.content.split(/^##/m)[0].trim().slice(0, 300);
      response += `> ${preview}${blip.content.length > 300 ? '...' : ''}`;

      await interaction.reply({ content: response, ephemeral: true });
      break;
    }

    case 'surface': {
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

        // Mark as touched
        touchBlip(summary.path);

        const preview = blip.content.split(/^##/m)[0].trim().slice(0, 80);
        const moves = suggestMoves(blip).slice(0, 3);
        const moveLabels = moves.map((m) => m.label).join(', ');

        lines.push(`**${i + 1}.** ${blip.title}\n> ${preview}${blip.content.length > 80 ? '...' : ''}\nMoves: ${moveLabels}`);
      }

      await interaction.reply({
        content: `**Blips to Consider**\n\n${lines.join('\n\n')}`,
        ephemeral: false,
      });
      break;
    }

    case 'note': {
      const filename = interaction.options.getString('id', true);
      const note = interaction.options.getString('note', true);

      const blips = listBlips();
      const summary = blips.find((b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase()));

      if (!summary) {
        await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
        return;
      }

      appendToLog(summary.path, note);
      await interaction.reply({ content: `Added note to **${summary.title}**`, ephemeral: false });
      break;
    }

    case 'snooze': {
      const filename = interaction.options.getString('id', true);
      const days = interaction.options.getInteger('days') || 7;

      const blips = listBlips();
      const summary = blips.find((b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase()));

      if (!summary) {
        await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
        return;
      }

      const until = new Date();
      until.setDate(until.getDate() + days);
      snoozeBlip(summary.path, until.toISOString().split('T')[0]);
      await interaction.reply({ content: `Snoozed **${summary.title}** for ${days} days`, ephemeral: false });
      break;
    }

    case 'archive': {
      const filename = interaction.options.getString('id', true);

      const blips = listBlips();
      const summary = blips.find((b) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase()));

      if (!summary) {
        await interaction.reply({ content: `Blip matching \`${filename}\` not found.`, ephemeral: true });
        return;
      }

      archiveBlip(summary.path);
      await interaction.reply({ content: `Archived **${summary.title}**`, ephemeral: false });
      break;
    }

    case 'stats': {
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
      break;
    }

    case 'process': {
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
      break;
    }

    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
  }
}

// ============== Assistant Handlers ==============

async function handleAssistant(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'enable': {
      const enabled = interaction.options.getBoolean('enabled', true);

      await ctx.state.transact(async () => {
        ctx.state.setAssistantEnabled(enabled);
      });

      await interaction.reply({
        content: enabled ? '✅ Assistant enabled' : '⏸️ Assistant disabled',
        ephemeral: false,
      });
      break;
    }

    case 'channel': {
      const type = interaction.options.getString('type', true) as
        | 'morningCheckin'
        | 'blips'
        | 'blipsStream'
        | 'lobby'
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
        meditationLogs: 'Meditation Logs',
        dailies: 'Dailies',
      };

      await interaction.reply({
        content: `Set ${typeNames[type]} channel to <#${channel.id}>`,
        ephemeral: false,
      });
      break;
    }

    case 'category': {
      const category = interaction.options.getChannel('category', true);
      await ctx.state.transact(async () => {
        ctx.state.setAssistantCategory(category.id);
      });
      await interaction.reply({
        content: `Set assistant category to <#${category.id}>`,
        ephemeral: false,
      });
      break;
    }

    case 'status': {
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
      break;
    }

    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
  }
}
