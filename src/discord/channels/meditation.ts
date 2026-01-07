import type { ChannelHandler } from './types';
import { createChannelMatcher } from './types';
import { createDailyEntryHandler } from './daily-entry';

/**
 * Meditation logs channel handler.
 *
 * Voice messages and text are transcribed and appended to the daily note
 * under a "### Meditation" section header.
 */
export const meditationHandler: ChannelHandler = {
  name: 'meditation',

  matches: createChannelMatcher({
    stateKey: 'meditationLogs',
    fallbackName: 'meditation-logs',
  }),

  handle: createDailyEntryHandler({
    formatEntry: (content, timestamp) =>
      `\n### Meditation (${timestamp})\n\n${content}\n`,
    commitMessage: (date) => `meditation log: ${date}`,
    logName: 'MeditationLog',
  }),

  priority: 20,
};
