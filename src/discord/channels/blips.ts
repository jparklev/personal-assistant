import type { Message } from 'discord.js';
import type { ChannelHandler } from './types';
import type { AppContext } from '../events';
import { getVoiceAttachments, transcribeMessageVoice } from '../voice';
import { extractUrls } from '../../captures';
import { captureUrlToFile } from '../../captures/capture-url';
import {
  createBlip,
  findBlipBySource,
  canonicalizeBlipSource,
} from '../../blips';
import { buildAssistantContext } from '../../assistant/invoke';
import { invokeClaude, type RunnerEvent } from '../../assistant/runner';
import { storeSession, setSessionMetadata } from '../../assistant/sessions';
import { ProgressRenderer } from '../../assistant/progress';

const PROGRESS_EDIT_EVERY_MS = 2000;

function escapeCodeBlock(text: string): string {
  return text.replace(/```/g, '``\u200b`');
}

function wrapProgress(text: string): string {
  return `\`\`\`text\n${escapeCodeBlock(text)}\n\`\`\``;
}

/**
 * Blips channel handler.
 *
 * Handles natural language capture in the blips channel:
 * - Plain text: Discuss first, then offer to save as blip
 * - URLs: Auto-capture and create blip
 * - Commands: Route to assistant
 * - Replies to bot: Continue session
 */
export const blipsHandler: ChannelHandler = {
  name: 'blips',

  matches: (matchCtx) => {
    const { channelId, ctx, message } = matchCtx;
    if (channelId !== ctx.state.snapshot.assistant.channels.blips) return false;

    // Voice messages should always be handled here (transcribe + capture/discuss).
    if (getVoiceAttachments(message).length > 0) return true;

    const text = message.content.trim();
    if (!text) return false;

    // URLs should always be handled here (auto-capture), even if the text starts with a "command" word.
    if (extractUrls(text).length > 0) return true;

    // Command-like text (no URLs) should fall through to the assistant handler.
    return !isBlipCommand(text);
  },

  handle: handleBlipCapture,

  priority: 50,
};

async function handleBlipCapture(message: Message, ctx: AppContext): Promise<void> {
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

  // Replies to bot messages are handled by the assistant handler (session continuity)
  // This is checked at a higher priority in the router

  const urls = extractUrls(text);
  const hasUrls = urls.length > 0;
  const looksLikeCommand = isBlipCommand(text);

  // Plain text without URLs: discuss first, then offer to save
  if (!hasUrls && !looksLikeCommand) {
    await handleBlipDiscussion(message, ctx, text);
    return;
  }

  // Commands without URLs: route to assistant (handled externally)
  if (!hasUrls && looksLikeCommand) {
    // This case is excluded by matches(); keep for defensive clarity.
    return;
  }

  // URLs: auto-capture
  await handleUrlCapture(message, ctx, text, urls);
}

/**
 * Handle plain text in blips channel: discuss first, then offer to save.
 */
async function handleBlipDiscussion(
  message: Message,
  ctx: AppContext,
  text: string
): Promise<void> {
  const progressRenderer = new ProgressRenderer();
  const initialProgress = progressRenderer.render('thinking', 0, 'claude', 'thinking');
  const progressMsg = await message.reply(wrapProgress(initialProgress));

  let lastRendered = wrapProgress(initialProgress);
  let nextAllowedAt = Date.now() + PROGRESS_EDIT_EVERY_MS;
  let timer: NodeJS.Timeout | null = null;
  let pending: string | null = null;
  let closed = false;

  const requestEdit = (rendered: string) => {
    if (closed) return;
    pending = rendered;
    if (timer) return;
    const delay = Math.max(0, nextAllowedAt - Date.now());
    timer = setTimeout(async () => {
      timer = null;
      if (closed || !pending || pending === lastRendered) return;
      lastRendered = pending;
      nextAllowedAt = Date.now() + PROGRESS_EDIT_EVERY_MS;
      try {
        await progressMsg.edit(pending);
      } catch {}
    }, delay);
  };

  const closeEditor = () => {
    closed = true;
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

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
      model: 'opus',
      onEvent: async (event: RunnerEvent) => {
        const shouldUpdate = progressRenderer.noteEvent(event);
        if (!shouldUpdate) return;

        let currentState: 'thinking' | 'tool' | 'writing' = 'thinking';
        if (event.type === 'tool_start') currentState = 'tool';
        else if (event.type === 'text') currentState = 'writing';

        const label = currentState === 'writing' ? 'writing' : 'thinking';
        requestEdit(wrapProgress(progressRenderer.render(currentState, 0, 'claude', label)));
      },
    });

    if (result.text && result.ok) {
      closeEditor();
      const toolsSummary =
        result.toolsUsed.length > 0
          ? `\n\n_${result.toolsUsed.join(', ')} · ${(result.durationMs / 1000).toFixed(1)}s_`
          : `\n\n_${(result.durationMs / 1000).toFixed(1)}s_`;

      const maxLen = 2000 - toolsSummary.length;
      await progressMsg.edit(result.text.slice(0, maxLen) + toolsSummary);

      storeSession(progressMsg.id, result.sessionId);
      setSessionMetadata(result.sessionId, { model: 'opus', type: 'blip-discussion' });
    } else {
      closeEditor();
      await progressMsg.edit(`Something went wrong: ${result.text || 'No response'}`);
    }
  } catch (error: any) {
    closeEditor();
    await progressMsg.edit(`Error: ${error?.message || 'Unknown error'}`);
  } finally {
    closeEditor();
  }
}

/**
 * Handle URL capture in blips channel.
 */
async function handleUrlCapture(
  message: Message,
  ctx: AppContext,
  text: string,
  urls: string[]
): Promise<void> {
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
    | { url: string; captureFilename: string; title: string; author?: string; type: string }
    | { url: string; error: string }
  > = [];

  const updateProgress = (line: string) => {
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
      const captured = await captureUrlToFile(url, updateProgress);
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
    const successes = captureResults.filter(
      (r): r is { url: string; captureFilename: string; title: string; author?: string; type: string } =>
        'captureFilename' in r
    );
    const failures = captureResults.filter((r): r is { url: string; error: string } => 'error' in r);

    if (successes.length === 0) {
      const details = failures
        .slice(0, 3)
        .map((f) => `- ${f.url}: ${f.error}`)
        .join('\n');
      await progressMsg.edit(`Couldn't capture that link.\n\n${details || 'Unknown error'}`);
      return;
    }

    const primary = successes[0];
    const captureField = successes.length === 1 ? primary.captureFilename : undefined;

    const captureLines = successes
      .map((c) => `- Full capture: ~/.assistant/captures/${c.captureFilename}`)
      .join('\n');
    const failureLines =
      failures.length > 0
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
    const shortTitle =
      primary.title && primary.title.length > 100
        ? primary.title.slice(0, 100) + '…'
        : primary.title || 'Captured link';

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
    ]
      .filter(Boolean)
      .join('\n');

    await progressMsg.edit(response.slice(0, 2000));
  } catch (error: any) {
    await progressMsg.edit(`Error: ${error?.message || 'Unknown error'}`);
  }
}

/**
 * Check if message looks like a command (for routing to assistant).
 */
export function isBlipCommand(text: string): boolean {
  return /^(what|list|show|surface|add|snooze|archive|save|tell|help|can you)/i.test(text);
}
