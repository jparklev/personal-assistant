import type { ChannelHandler } from './types';
import { createChannelMatcher } from './types';
import { createDailyEntryHandler } from './daily-entry';

/**
 * Dailies channel handler.
 *
 * Voice messages and text are transcribed and appended to the daily note
 * as inline voice note entries.
 */
export const dailiesHandler: ChannelHandler = {
  name: 'dailies',

  matches: createChannelMatcher({
    stateKey: 'dailies',
    fallbackName: 'dailies',
  }),

  handle: createDailyEntryHandler({
    formatEntry: (content, timestamp) =>
      `\n**Voice note (${timestamp}):** ${content}\n`,
    commitMessage: (date) => `daily log: ${date}`,
    logName: 'DailyLog',
  }),

  priority: 20,
};
