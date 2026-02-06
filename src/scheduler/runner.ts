#!/usr/bin/env bun

/**
 * Scheduler Runner (standalone)
 *
 * Runs a single scheduler task using the same task implementations as the
 * in-process scheduler loop.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { Events } from 'discord.js';
import { loadConfig } from '../config';
import { defaultState, StateStore } from '../state';
import { SchedulerState } from './state';
import type { TaskName, TaskResult } from './types';
import { createDiscordClient } from '../discord/client';
import {
  runMorningCheckinTask,
  runWeeklyReconsolidationTask,
  runHealthCheckinTask,
  type SchedulerContext as LoopSchedulerContext,
} from './loop';

function loadEnv(): void {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

async function runTask(taskName: TaskName, ctx: LoopSchedulerContext): Promise<TaskResult> {
  if (taskName === 'morning-checkin') {
    const sent = await runMorningCheckinTask(ctx);
    if (sent) ctx.scheduler.markRun('morningCheckin');
    return {
      success: true,
      message: sent ? 'Morning check-in sent' : 'Morning check-in skipped',
      data: { sent },
    };
  }

  if (taskName === 'weekly-reconsolidation') {
    const sent = await runWeeklyReconsolidationTask(ctx);
    if (sent) ctx.scheduler.markRun('weeklyReconsolidation');
    return {
      success: true,
      message: sent ? 'Weekly reconsolidation sent' : 'Weekly reconsolidation skipped',
      data: { sent },
    };
  }

  if (taskName === 'health-checkin') {
    const result = await runHealthCheckinTask(ctx);
    if (result.ok) ctx.scheduler.markRun('healthCheckin');
    return {
      success: result.ok,
      message: result.message,
      data: { sent: result.sent },
    };
  }

  return { success: true, message: 'Nudge not implemented yet' };
}

async function main() {
  const taskName = process.argv[2] as TaskName | undefined;
  const allowed: TaskName[] = ['morning-checkin', 'weekly-reconsolidation', 'periodic-nudge', 'health-checkin'];

  if (!taskName || !allowed.includes(taskName)) {
    console.error('Usage: bun run src/scheduler/runner.ts <task-name>');
    console.error('Available tasks:', allowed.join(', '));
    process.exit(1);
  }

  loadEnv();

  const cfg = loadConfig();
  if (!cfg.discordToken) {
    console.error('DISCORD_BOT_TOKEN not set');
    process.exit(1);
  }
  if (!existsSync(cfg.vaultPath)) {
    console.error(`Obsidian vault not found at: ${cfg.vaultPath}`);
    console.error('Set OBSIDIAN_VAULT_PATH to your vault directory (recommended on VPS).');
    process.exit(1);
  }

  const state = new StateStore(cfg.stateFile, defaultState());
  const scheduler = new SchedulerState(dirname(cfg.stateFile));

  const client = createDiscordClient();
  try {
    await client.login(cfg.discordToken);
    await new Promise<void>((resolve) => {
      if (client.isReady()) return resolve();
      client.once(Events.ClientReady, () => resolve());
    });

    const ctx: LoopSchedulerContext = { client, cfg, state, scheduler };

    console.log(`[${new Date().toISOString()}] Running task: ${taskName}`);
    const result = await runTask(taskName, ctx);

    if (!result.success) {
      console.error(`[${new Date().toISOString()}] Task failed: ${result.message}`);
      process.exit(1);
    }

    console.log(`[${new Date().toISOString()}] Task completed: ${result.message}`);
    if (result.data) {
      console.log('Data:', JSON.stringify(result.data, null, 2));
    }
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Task error:`, error?.message || error);
    process.exit(1);
  } finally {
    client.destroy();
  }
}

main();
