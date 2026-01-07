/**
 * Discord Event Handlers
 *
 * This module is the thin router for Discord events.
 * Channel-specific logic is in src/discord/channels/
 * Slash command handlers are in src/discord/commands/
 */

import type { Client, ChatInputCommandInteraction, Message } from 'discord.js';
import { ChannelType, Events } from 'discord.js';
import type { DiscordTransport } from './transport';
import type { AppConfig } from '../config';
import type { StateStore } from '../state';
import { buildAssistantContext } from '../assistant/invoke';
import { invokeClaude, type RunnerEvent } from '../assistant/runner';
import { storeSession, getSession, setSessionMetadata, getSessionMetadata } from '../assistant/sessions';
import { ProgressRenderer } from '../assistant/progress';
import {
  ensureBlipsStreamCard,
  handleBlipsStreamButton,
  handleBlipsStreamModal,
  isBlipsStreamCustomId,
} from './blips-stream';
import { getVoiceAttachments, transcribeMessageVoice } from './voice';
import {
  routeToChannelHandler,
  readChannelMemory,
  ensureChannelMemoryInitialized,
  resolveAssistantCategoryId,
  getManagedAssistantChannelIds,
  isBlipCommand,
  isFlashcardCustomId,
  handleFlashcardButton,
} from './channels';
import { handleBlipCommand, handleAssistantCommand } from './commands/index';

export interface AppContext {
  cfg: AppConfig;
  state: StateStore;
  transport: DiscordTransport;
}

// ============== Progress/Session Infrastructure ==============

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

function escapeCodeBlock(text: string): string {
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

function ensureQueue(sessionId: string): QueuedAssistantMessage[] {
  const q = queuedBySessionId.get(sessionId);
  if (q) return q;
  const next: QueuedAssistantMessage[] = [];
  queuedBySessionId.set(sessionId, next);
  return next;
}

function truncateForPrompt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

// ============== Event Registration ==============

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

    if (interaction.isButton() && isFlashcardCustomId(interaction.customId)) {
      await handleFlashcardButton(interaction);
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
    if (!ctx.state.isAssistantEnabled()) return;

    const assistantChannels = ctx.state.snapshot.assistant.channels;
    const managed = getManagedAssistantChannelIds(ctx.state);

    // Priority 1: Reply-to-bot detection (session continuity)
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

    // Priority 2: Route to channel-specific handlers
    const handled = await routeToChannelHandler(message, ctx);

    // If blips handler returned without handling (command case), route to assistant
    if (!handled) {
      // Check if it's a blips channel command
      const isBlipsChannel = message.channelId === assistantChannels.blips;
      if (isBlipsChannel && isBlipCommand(message.content.trim())) {
        await handleAssistantMessage(message, ctx);
        return;
      }
    }

    if (handled) return;

    // Priority 3: Blips stream channel (refresh card on any message)
    const isBlipsStreamChannel =
      assistantChannels.blipsStream
        ? message.channelId === assistantChannels.blipsStream
        : (message.channel as any)?.name === 'blips-stream';

    if (isBlipsStreamChannel) {
      await ensureBlipsStreamCard({
        client,
        guild: message.guild as any,
        blipsStreamChannelId: assistantChannels.blipsStream,
      });
      return;
    }

    // Priority 4: Core assistant channels (morning checkin)
    const isAssistantChannel = message.channelId === assistantChannels.morningCheckin;
    const isManagedChannel = managed.includes(message.channelId);

    if (isAssistantChannel || isManagedChannel) {
      await handleAssistantMessage(message, ctx);
      return;
    }

    // Priority 5: Category-based detection (any channel under assistant category)
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
  });
}

// ============== Slash Commands ==============

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
        await handleBlipCommand(interaction, ctx);
        break;
      case 'assistant':
        await handleAssistantCommand(interaction, ctx);
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
    '**Daily Logs**',
    '• Send voice notes to meditation-logs or dailies channels',
    '• Messages are transcribed and appended to daily notes',
    '',
    '**Settings**',
    '• `/assistant enable` - Enable/disable assistant',
    '• `/assistant channel` - Set channels',
    '• `/assistant category` - Set category for created channels',
    '• `/assistant status` - Show configuration',
  ].join('\n');

  await interaction.reply(help);
}

// ============== Reply Chain Traversal ==============

interface ThreadMessage {
  author: 'User' | 'Assistant';
  content: string;
  messageId: string;
}

async function getReplyChain(message: Message, maxDepth = 100): Promise<ThreadMessage[]> {
  const chain: ThreadMessage[] = [];
  let current: Message | null = message;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (current.id !== message.id) {
      chain.unshift({
        author: current.author.bot ? 'Assistant' : 'User',
        content: current.content,
        messageId: current.id,
      });
    }

    if (current.reference?.messageId) {
      try {
        current = await current.channel.messages.fetch(current.reference.messageId);
        depth++;
      } catch {
        break;
      }
    } else {
      break;
    }
  }

  return chain;
}

// ============== Assistant Message Handler ==============

async function getReplyTarget(message: Message): Promise<{
  resumeId: string | null;
  running: RunningAssistantTask | null;
  repliedToId: string | null;
}> {
  if (!message.reference?.messageId) return { resumeId: null, running: null, repliedToId: null };

  try {
    const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    if (repliedTo.author.bot) {
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

async function maybeStartSessionWorker(sessionId: string, ctx: AppContext): Promise<void> {
  if (workerActiveForSession.has(sessionId)) return;
  if (runningBySessionId.has(sessionId)) return;

  const queue = queuedBySessionId.get(sessionId);
  if (!queue || queue.length === 0) return;

  workerActiveForSession.add(sessionId);
  (async () => {
    try {
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
    workerActiveForSession.delete(sessionId);
  });
}

async function handleAssistantMessage(message: Message, ctx: AppContext): Promise<void> {
  let text = message.content.trim();

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

  const assistantChannels = ctx.state.snapshot.assistant.channels;
  let channelType: QueuedAssistantMessage['channelType'] = 'general';
  if (message.channelId === assistantChannels.morningCheckin) channelType = 'morning-checkin';
  else if (message.channelId === assistantChannels.blips) channelType = 'blips';
  else if (message.channelId === assistantChannels.lobby) channelType = 'lobby';

  // Ensure per-channel memory exists for managed/category channels
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

  // Handle in-flight session replies
  if (target?.running) {
    if (isCancelText(text)) {
      await cancelRunningTask(target.running);
      await message.reply('cancelling…');
      return;
    }

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

  const metadata = resumeId ? getSessionMetadata(resumeId) : undefined;
  const model = metadata?.model || 'opus';

  const channelMemory = readChannelMemory(ctx.cfg, message.channelId);
  const channelContext = channelMemory
    ? `## Channel Memory\n\n${truncateForPrompt(channelMemory, 3000)}\n\n`
    : '';

  // Build conversation context only for new sessions
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
    queueCount: resumeId ? queuedBySessionId.get(resumeId)?.length || 0 : 0,
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
