import type { Message } from 'discord.js';
import type { AppContext } from '../events';

/**
 * Context provided to channel matchers for determining if a handler applies.
 */
export interface ChannelMatchContext {
  message: Message;
  channelId: string;
  channelName: string | undefined;
  parentId: string | undefined;
  ctx: AppContext;
}

/**
 * A channel handler defines how messages in a specific channel type are processed.
 *
 * To add a new channel:
 * 1. Create a handler file in src/discord/channels/
 * 2. Implement the ChannelHandler interface
 * 3. Register it in the handlers array in index.ts
 */
export interface ChannelHandler {
  /** Unique identifier for this handler (used for logging/debugging) */
  name: string;

  /**
   * Determine if this handler should process the message.
   * Return true to handle, false to pass to next handler.
   */
  matches: (matchCtx: ChannelMatchContext) => boolean | Promise<boolean>;

  /**
   * Process the message. Called only if matches() returns true.
   */
  handle: (message: Message, ctx: AppContext) => Promise<void>;

  /**
   * Priority for handler ordering. Higher values are checked first.
   * Default: 0
   *
   * Recommended ranges:
   * - 100+: Override handlers (reply-to-bot detection)
   * - 50-99: Core channel handlers (lobby, blips)
   * - 0-49: Standard channel handlers (dailies, meditation)
   * - <0: Fallback handlers (category-based detection)
   */
  priority?: number;
}

/** Valid channel type keys */
export type ChannelTypeKey =
  | 'morningCheckin'
  | 'blips'
  | 'blipsStream'
  | 'lobby'
  | 'meditationLogs'
  | 'dailies';

/**
 * Configuration for a channel that can be identified by state ID or channel name.
 */
export interface ChannelConfig {
  /** Key in state.assistant.channels (e.g., 'meditationLogs') */
  stateKey?: ChannelTypeKey;

  /** Fallback channel name to match (e.g., 'meditation-logs') */
  fallbackName?: string;
}

/**
 * Helper to create a standard channel matcher from config.
 */
export function createChannelMatcher(config: ChannelConfig): ChannelHandler['matches'] {
  return (matchCtx) => {
    const { channelId, channelName, ctx } = matchCtx;
    const assistantChannels = ctx.state.snapshot.assistant.channels;

    // Check state-stored channel ID first
    if (config.stateKey) {
      const configuredId = assistantChannels[config.stateKey];
      if (configuredId && channelId === configuredId) {
        return true;
      }
    }

    // Fall back to name-based detection
    if (config.fallbackName && channelName) {
      return channelName.toLowerCase() === config.fallbackName.toLowerCase();
    }

    return false;
  };
}
