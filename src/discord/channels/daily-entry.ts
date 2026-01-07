import type { Message } from 'discord.js';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { AppContext } from '../events';
import { getVoiceAttachments, transcribeMessageVoice } from '../voice';
import { isoDateInTimeZone } from '../../time';
import { requestVaultSync } from '../../vault/sync-queue';

/**
 * Configuration for a daily entry handler.
 *
 * This pattern is used for channels that append content to daily notes:
 * - Voice messages are transcribed and appended
 * - Text messages are appended directly
 * - Changes are synced to git
 */
export interface DailyEntryConfig {
  /**
   * Format the entry content for the daily note.
   * @param content - The transcribed voice or text content
   * @param timestamp - Formatted timestamp string (e.g., "3:45 PM PT")
   */
  formatEntry: (content: string, timestamp: string) => string;

  /**
   * Generate the git commit message.
   * @param date - Today's date in YYYY-MM-DD format
   */
  commitMessage: (date: string) => string;

  /** Name for logging (e.g., 'MeditationLog', 'DailyLog') */
  logName: string;
}

/**
 * Create a handler function for daily entry channels.
 *
 * Usage:
 * ```ts
 * const handle = createDailyEntryHandler({
 *   formatEntry: (content, time) => `\n### Meditation (${time})\n\n${content}\n`,
 *   commitMessage: (date) => `meditation log: ${date}`,
 *   logName: 'MeditationLog',
 * });
 * ```
 */
export function createDailyEntryHandler(
  config: DailyEntryConfig
): (message: Message, ctx: AppContext) => Promise<void> {
  return async (message: Message, ctx: AppContext): Promise<void> => {
    const voiceAttachments = getVoiceAttachments(message);

    // Handle text-only messages
    if (voiceAttachments.length === 0) {
      const text = message.content.trim();
      if (!text) return;
      await appendDailyEntry(text, message, ctx, config);
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

    // Combine all transcripts and append
    const fullTranscript = transcripts.join('\n\n');
    await appendDailyEntry(fullTranscript, message, ctx, config);
  };
}

/**
 * Append an entry to today's daily note and sync to git.
 */
async function appendDailyEntry(
  content: string,
  message: Message,
  ctx: AppContext,
  config: DailyEntryConfig
): Promise<void> {
  const vaultPath = ctx.cfg.vaultPath;

  // Get today's date in YYYY-MM-DD format
  const today = isoDateInTimeZone(new Date());
  const dailyNotePath = join(vaultPath, 'Daily', `${today}.md`);

  // Format timestamp (Pacific time)
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });

  const entry = config.formatEntry(content, `${timeStr} PT`);

  try {
    // Ensure daily folder exists
    mkdirSync(dirname(dailyNotePath), { recursive: true });

    // Append to daily note
    appendFileSync(dailyNotePath, entry, 'utf-8');

    // Sync to git
    requestVaultSync(vaultPath, config.commitMessage(today));

    // React and reply with word count
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    await message.react('👍');

    await message.reply(`Logged ${wordCount} words to \`Daily/${today}.md\` (sync queued)`);
  } catch (err: any) {
    console.error(`[${config.logName}] Failed to append:`, err);
    await message.reply(`Failed to log: ${err.message}`);
  }
}
