/**
 * Ideas Channel Handler
 *
 * Captures raw thoughts and develops them into refined ideas.
 * Unlike blips (individual files), ideas append to Projects/Inbox.md.
 *
 * Key behaviors:
 * - Capture immediately - every message saves to inbox
 * - Mixed format - bullets for quick captures, dated sections when developed
 * - Seeds Lab style - push back on half-formed ideas, ask clarifying questions
 * - Claude manages the inbox - trust Claude to write, refine, and clean up
 */

import type { Message, Attachment } from 'discord.js';
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

const PROGRESS_EDIT_EVERY_MS = 2000;

function escapeCodeBlock(text: string): string {
  return text.replace(/```/g, '``\u200b`');
}

function wrapProgress(text: string): string {
  return `\`\`\`text\n${escapeCodeBlock(text)}\n\`\`\``;
}

/**
 * Ideas channel handler.
 *
 * Handles idea capture and development:
 * - Text: Capture to inbox, then discuss/develop
 * - Voice: Transcribe, capture, then discuss
 * - URLs: Fetch content to captures, then add reference to inbox
 * - Attachments: Save reference so they're not lost
 */
export const ideasHandler: ChannelHandler = {
  name: 'ideas',

  matches: createChannelMatcher({
    stateKey: 'ideas',
    fallbackName: 'ideas',
  }),

  handle: handleIdeasMessage,

  priority: 45,
};

async function handleIdeasMessage(message: Message, ctx: AppContext): Promise<void> {
  let text = message.content.trim();
  const attachments: Attachment[] = Array.from(message.attachments.values());
  const voiceAttachments = getVoiceAttachments(message);

  // Transcribe voice messages
  if (voiceAttachments.length > 0) {
    const { transcripts, errors } = await transcribeMessageVoice(message);

    if (transcripts.length > 0) {
      // Store transcriptions for context building
      for (let i = 0; i < transcripts.length; i++) {
        storeTranscription(message.id, transcripts[i]);
      }

      const voiceText = transcripts
        .map((t, i) =>
          voiceAttachments.length > 1 ? `[Voice ${i + 1}]: ${t}` : `[Voice]: ${t}`
        )
        .join('\n\n');
      text = text ? `${voiceText}\n\n${text}` : voiceText;
    } else if (errors.length > 0 && !text) {
      await message.reply(`Couldn't transcribe voice message: ${errors[0]}`);
      return;
    }
  }

  // Handle attachment-only messages (no text, no voice)
  const nonVoiceAttachments = attachments.filter((a) => !voiceAttachments.includes(a));
  if (!text && nonVoiceAttachments.length > 0) {
    const attachmentRefs = nonVoiceAttachments
      .map((a) => `[attachment: ${a.name} - ${a.url}]`)
      .join('\n');
    text = attachmentRefs;
  }

  if (!text) return;

  // Check for URLs - capture them first
  const urls = extractUrls(text);
  const capturedUrls: Array<{ url: string; filename: string; title: string }> = [];

  if (urls.length > 0) {
    for (const url of urls) {
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
        // Capture failed - Claude can still work with the URL
      }
    }
  }

  // Build capture context if URLs were captured
  let captureContext = '';
  if (capturedUrls.length > 0) {
    captureContext = `\n\n## Captured URLs\n\n${capturedUrls
      .map((c) => `- ${c.url}\n  - Capture: Clippings/${c.filename}\n  - Title: ${c.title}`)
      .join('\n')}`;
  }

  await runIdeasAssistant(message, ctx, text, captureContext);
}

async function runIdeasAssistant(
  message: Message,
  ctx: AppContext,
  text: string,
  captureContext: string
): Promise<void> {
  const at = message.createdAt || new Date();
  const date = isoDateForAssistant(at);
  const timeStr = formatTimeInTimeZone(at);
  const inboxPath = `${ctx.cfg.vaultPath}/Projects/Inbox.md`;

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

  const prompt = `You are Josh's ideas assistant in the #ideas Discord channel.

## CRITICAL: Write As Josh
When writing to the vault, write in Josh's voice:
- First person ("I want to...", "My thinking is...")
- Casual, direct
- Never refer to Josh in third person
- Never use "the user" - you ARE capturing Josh's thoughts AS Josh

## Time Context

- User timezone: America/Los_Angeles (Pacific)
- Message time: ${timeStr} PT
- Effective date: ${date} (00:00–04:59 PT counts as previous day)

## Context
${captureContext}
${buildAssistantContext()}

## Current User Message

${text}

## Capture-First Rule

IMMEDIATELY save every idea to \`${inboxPath}\` using the Edit tool to append.

**Format decision:**
- **Quick thoughts** → add as bullet: \`- [idea in Josh's voice]\`
- **Developed ideas** (after discussion) → add as dated section:

\`\`\`markdown
## ${date} - [Title]

[Developed idea content in Josh's voice]

---
\`\`\`

**Never wait for refinement.** Josh may not reply. Capture first.

If the inbox file doesn't exist, use the Write tool to create it with the captured idea.

After saving, briefly confirm what you captured (e.g., "Captured." or "Added to inbox.").

## After Capturing

If the idea seems half-formed, ask 1-2 clarifying questions:
- What tension or pattern does this reveal?
- What would be a tiny next step?
- How does this connect to something you're already working on?

Push back hard on things that don't hold together - but only when warranted. Josh wants honest engagement, not validation.

## Inbox Maintenance

The inbox should stay useful, not ever-growing:
- When refining an idea, you can clean up older drafts
- Delete bullets that have been developed into sections
- Remove things Josh says are no longer relevant
- Keep it curated, not just accumulated

## Follow-up Development

When Josh continues through replies:
- Convert bullet → dated section if it's being developed
- Append new thoughts to the section (still in Josh's voice)
- Keep developing until the idea is clear

## Style

- Concise, not verbose
- Curious - help develop ideas
- No emojis unless Josh uses them
- Warm but honest - willing to push back constructively

Output your response directly.`;

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
      setSessionMetadata(result.sessionId, { model: 'opus', type: 'ideas' });

      // Sync vault if files were modified
      const fileTools = ['Edit', 'Write', 'MultiEdit'];
      if (result.toolsUsed.some((t) => fileTools.includes(t))) {
        requestVaultSync(ctx.cfg.vaultPath, `ideas: ${date}`);
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
