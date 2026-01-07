/**
 * Health Check-in Scheduled Task
 *
 * Sends an evening check-in to the health channel.
 * Avoids duplicates via local health state.
 */

import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import type { SchedulerContext, TaskResult } from '../types';
import {
  buildHealthCheckinMessage,
  shouldSendCheckin,
  recordCheckinSent,
} from '../../health';

export async function runHealthCheckin(ctx: SchedulerContext): Promise<TaskResult> {
  if (!ctx.channels.health) {
    return { success: false, message: 'Health channel not configured' };
  }

  // Check if we should send a check-in
  const { send, reason } = shouldSendCheckin();
  if (!send) {
    return { success: true, message: reason };
  }

  const { text: message, protocol, daysSinceLog } = buildHealthCheckinMessage(ctx.vaultPath);

  // Send to channel
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  try {
    await client.login(ctx.discordToken);

    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once('ready', () => resolve());
      }
    });

    const channel = await client.channels.fetch(ctx.channels.health!);
    if (!channel || !(channel instanceof TextChannel)) {
      return { success: false, message: 'Could not fetch health channel' };
    }

    await channel.send(message);

    // Record that we sent a check-in
    recordCheckinSent();

    return {
      success: true,
      message: `Health check-in sent to ${channel.name}`,
      data: {
        protocolActive: protocol.active,
        protocolDay: protocol.dayNumber,
        daysSinceLog,
      },
    };
  } catch (error: any) {
    return { success: false, message: error?.message || String(error) };
  } finally {
    client.destroy();
  }
}
