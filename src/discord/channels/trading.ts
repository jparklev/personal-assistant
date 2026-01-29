/**
 * Trading Channel Handler
 *
 * Trade logging, reflection, idea curation, and evolving understanding.
 *
 * Scope note:
 * - Position monitoring + external data ingestion belongs in a separate library (out of scope here).
 * - This handler focuses on Discord UX + Obsidian vault notes in Trading/.
 */

import type { Attachment, Message } from 'discord.js';
import type { ChannelHandler } from './types';
import type { AppContext } from '../events';
import { createChannelMatcher } from './types';
import { getVoiceAttachments, transcribeMessageVoice, storeTranscription } from '../voice';
import { extractUrls } from '../../captures';
import { captureUrlToFile } from '../../captures/capture-url';
import { buildAssistantContext } from '../../assistant/invoke';
import { invokeClaude, type RunnerEvent } from '../../assistant/runner';
import { storeSession, setSessionMetadata } from '../../assistant/sessions';
import { ProgressRenderer } from '../../assistant/progress';
import { formatTimeInTimeZone, isoDateForAssistant } from '../../time';
import { requestVaultSync } from '../../vault/sync-queue';
import { appendIdeaLogEntry, ensureTradingFiles } from '../../trading/files';
import { buildTradingContext } from '../../trading/context';

const PROGRESS_EDIT_EVERY_MS = 2000;

function escapeCodeBlock(text: string): string {
  return text.replace(/```/g, '``\u200b`');
}

function wrapProgress(text: string): string {
  return `\`\`\`text\n${escapeCodeBlock(text)}\n\`\`\``;
}

function isTwitterUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com') || host.endsWith('.x.com');
  } catch {
    return false;
  }
}

function looksLikeTradeText(text: string): boolean {
  return /\b(buy|bought|sell|sold|short|long|entry|entered|exit|exited|stop|sl|take profit|tp)\b/i.test(
    text
  );
}

function looksLikeReflectionText(text: string): boolean {
  return /\bwhat was i thinking\b/i.test(text) || /\bwhy did i\b/i.test(text);
}

export const tradingHandler: ChannelHandler = {
  name: 'trading',

  matches: createChannelMatcher({
    stateKey: 'trading',
    fallbackName: 'trading',
  }),

  handle: handleTradingMessage,

  priority: 47,
};

async function handleTradingMessage(message: Message, ctx: AppContext): Promise<void> {
  ensureTradingFiles(ctx.cfg.vaultPath);

  let text = message.content.trim();
  const attachments: Attachment[] = Array.from(message.attachments.values());
  const voiceAttachments = getVoiceAttachments(message);

  if (voiceAttachments.length > 0) {
    const { transcripts, errors } = await transcribeMessageVoice(message);

    if (transcripts.length > 0) {
      for (const t of transcripts) storeTranscription(message.id, t);
      const voiceText = transcripts
        .map((t, i) => (voiceAttachments.length > 1 ? `[Voice ${i + 1}]: ${t}` : `[Voice]: ${t}`))
        .join('\n\n');
      text = text ? `${voiceText}\n\n${text}` : voiceText;
    } else if (errors.length > 0 && !text) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
      return;
    }
  }

  // Attachment-only messages: keep references so they’re not lost.
  const nonVoiceAttachments = attachments.filter((a) => !voiceAttachments.includes(a));
  if (!text && nonVoiceAttachments.length > 0) {
    text = nonVoiceAttachments.map((a) => `[attachment: ${a.name} - ${a.url}]`).join('\n');
  }

  if (!text) return;

  // URL capture (reuse capture pipeline)
  const urls = extractUrls(text);
  const twitterUrls = urls.filter(isTwitterUrl);
  const capturableUrls = urls.filter((u) => !isTwitterUrl(u));

  if (urls.length > 0 && capturableUrls.length === 0 && twitterUrls.length > 0) {
    await message.reply(
      "I can't read Twitter/X URLs directly right now. Paste the key text (or a screenshot + summary) and I’ll log it into Trading/Ideas.md."
    );
    return;
  }

  const capturedUrls: Array<{ url: string; filename: string; title: string }> = [];
  for (const url of capturableUrls) {
    try {
      const captured = await captureUrlToFile(url, () => {}, { now: message.createdAt });
      if (captured.success) {
        capturedUrls.push({
          url,
          filename: captured.captureFilename,
          title: captured.meta.title,
        });
      }
    } catch {
      // Capture failed; Claude can still use the raw URL if needed.
    }
  }

  let captureContext = '';
  if (capturedUrls.length > 0 || twitterUrls.length > 0) {
    const lines: string[] = [];
    if (capturedUrls.length > 0) {
      lines.push(
        '## Captured URLs',
        '',
        ...capturedUrls.map((c) => `- ${c.url}\n  - Capture: Clippings/${c.filename}\n  - Title: ${c.title}`)
      );
    }
    if (twitterUrls.length > 0) {
      lines.push(
        '',
        '## Twitter/X URLs (not captured)',
        '',
        ...twitterUrls.map((u) => `- ${u}`)
      );
    }
    captureContext = `\n\n${lines.join('\n')}`;
  }

  // Capture-first safety net: for non-trade messages, append a raw bullet to Ideas.md -> Idea Log.
  // Claude can later curate and move it into the right asset section.
  const at = message.createdAt || new Date();
  const date = isoDateForAssistant(at);
  const timeStr = formatTimeInTimeZone(at);

  let didLocalVaultWrite = false;
  if (!looksLikeTradeText(text) && !looksLikeReflectionText(text)) {
    const sources =
      capturedUrls.length > 0
        ? ` Sources: ${capturedUrls
            .map((c) => `[[Clippings/${c.filename.replace(/\\.md$/i, '')}]]`)
            .join(', ')}`
        : '';
    const rawLogText = (text + sources).slice(0, 1200);
    didLocalVaultWrite = appendIdeaLogEntry(ctx.cfg.vaultPath, { date, time: timeStr, text: rawLogText });
  }

  await runTradingAssistant(message, ctx, text, captureContext, { didLocalVaultWrite });
}

async function runTradingAssistant(
  message: Message,
  ctx: AppContext,
  text: string,
  captureContext: string,
  opts: { didLocalVaultWrite: boolean }
): Promise<void> {
  const at = message.createdAt || new Date();
  const date = isoDateForAssistant(at);
  const timeStr = formatTimeInTimeZone(at);

  const tradingContext = buildTradingContext(ctx.cfg.vaultPath);

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

  const prompt = `You are Josh's trading assistant.

The user posted this in the #trading channel:

---
${text}
---${captureContext}

## Time Context

- User timezone: America/Los_Angeles (Pacific)
- Message time: ${timeStr} PT
- Effective date for filenames/logs: ${date} (00:00–04:59 PT counts as previous day)

${tradingContext}

${buildAssistantContext({ cfg: ctx.cfg })}

## Key Files (vault: ${ctx.cfg.vaultPath})

- Trading/Claude.md - Your evolving understanding
- Trading/Ideas.md - Living document of assets being watched
- Trading/Trades.md - Trade log
- Trading/Lessons.md - Extracted lessons
- Trading/Philosophy.md - Trading philosophy
- Trading/Money-Management.md - Risk rules
- Daily/ - Daily notes (check occasionally for trading relevance)

## Your Role

Help me think through trades, curate ideas, and learn from outcomes.

### Non-negotiables

- Write in my voice (first person). Never write about me in third person.
- Capture first, organize later.
- Be concise (no fluff).
- When you make vault changes, prefer small, targeted edits.
${opts.didLocalVaultWrite ? `\n- Note: I already appended a raw capture bullet to Trading/Ideas.md → “## Idea Log” for safety. Avoid duplicating it; feel free to edit/move it.` : ''}

### URL capture behavior

- For non-Twitter URLs, a capture has already been attempted and (if successful) lives under Clippings/.
- Twitter/X is not reliably capturable; if the only URL is Twitter/X, ask me to paste the key text or share a screenshot.
- If a URL was captured, link it from Trading/Ideas.md as a source using an Obsidian link like: [[Clippings/<filename>]].

### Ideas / watchlist

- If this message is an idea, log it immediately under Trading/Ideas.md → “## Idea Log” as a dated bullet.
- If it clearly belongs to an asset already in Ideas.md, add it to that asset’s “Updates” or “Sources” section.
- If an asset section doesn’t exist yet but should, add one (simple template is fine).

### Trades (Pre-flight check)

If this message implies a new trade (or a clear plan to take one):
- Capture the thesis first.
- Scan Trading/Lessons.md quickly for relevant warnings (keywords: asset, direction, pattern).
- Log the trade in Trading/Trades.md (new “## …” section).
- Ask 1-2 pointed questions only if needed to clarify risk/invalidation.

### Reflections

If I’m asking “what was I thinking” or similar:
- Find the relevant trade in Trading/Trades.md
- Prompt reflection briefly
- Extract and append a concise lesson to Trading/Lessons.md

### Proactive

- If it’s helpful, check recent vault changes via git history and mention relevant updates.
- Occasionally scan Daily/ for trading-relevant notes (light touch).

Respond directly with your message to me.`;

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
      setSessionMetadata(result.sessionId, { model: 'opus', type: 'trading' });

      const fileTools = ['Edit', 'Write', 'MultiEdit'];
      if (opts.didLocalVaultWrite || result.toolsUsed.some((t) => fileTools.includes(t))) {
        requestVaultSync(ctx.cfg.vaultPath, `trading: ${date}`);
      }
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
