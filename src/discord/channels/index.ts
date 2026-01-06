/**
 * Channel Handler Registry
 *
 * This module provides a declarative way to register channel handlers.
 * Adding a new channel type is simple:
 *
 * 1. Create a handler file (e.g., `my-channel.ts`)
 * 2. Export a ChannelHandler object
 * 3. Add it to the `handlers` array below
 *
 * Handlers are checked in priority order (highest first).
 * The first matching handler processes the message.
 */

import type { Message } from 'discord.js';
import type { ChannelHandler, ChannelMatchContext } from './types';
import type { AppContext } from '../events';

// Import handlers
import { meditationHandler } from './meditation';
import { dailiesHandler } from './dailies';
import { blipsHandler } from './blips';
import { lobbyHandler } from './lobby';

// Re-export utilities that events.ts needs
export {
  readChannelMemory,
  ensureChannelMemoryInitialized,
  resolveAssistantCategoryId,
  getManagedAssistantChannelIds,
} from './lobby';
export { isBlipCommand } from './blips';
export type { ChannelHandler, ChannelMatchContext } from './types';

/**
 * Registered channel handlers, sorted by priority.
 *
 * To add a new channel:
 * 1. Create the handler file
 * 2. Import it here
 * 3. Add it to this array
 */
const handlers: ChannelHandler[] = [
  lobbyHandler,
  blipsHandler,
  meditationHandler,
  dailiesHandler,
].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

/**
 * Route a message to the appropriate channel handler.
 *
 * @returns true if a handler processed the message, false otherwise
 */
export async function routeToChannelHandler(
  message: Message,
  ctx: AppContext
): Promise<boolean> {
  const matchCtx: ChannelMatchContext = {
    message,
    channelId: message.channelId,
    channelName: (message.channel as any)?.name,
    parentId: (message.channel as any)?.parentId,
    ctx,
  };

  for (const handler of handlers) {
    try {
      const matches = await handler.matches(matchCtx);
      if (matches) {
        await handler.handle(message, ctx);
        return true;
      }
    } catch (error) {
      console.error(`[ChannelRouter] Error in handler ${handler.name}:`, error);
      // Continue to next handler on error
    }
  }

  return false;
}

/**
 * Get all registered handler names (for debugging/status).
 */
export function getRegisteredHandlers(): string[] {
  return handlers.map((h) => h.name);
}
