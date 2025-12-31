#!/usr/bin/env bun

/**
 * Scheduler Runner
 *
 * This is a standalone script that can be invoked by launchd/cron.
 *
 * Usage:
 *   bun run src/scheduler/runner.ts <task-name>
 *
 * Tasks:
 *   - morning-checkin: Send morning check-in to Discord
 *   - vault-sync: Sync vault and process new blips
 *   - process-clipper: Process clipper highlights
 */

import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import type { SchedulerContext, TaskName, TaskResult } from './types';
import { runMorningCheckin } from './tasks/morning-checkin';
import { runVaultSync } from './tasks/vault-sync';
import { runWeeklyReconsolidation } from './tasks/weekly-reconsolidation';

// Load environment variables from .env if present
function loadEnv() {
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) {
        let value = match[2].trim();
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      }
    }
  }
}

// Load state to get channel IDs
function loadChannels(): SchedulerContext['channels'] {
  const statePath = join(process.cwd(), 'state/assistant.json');
  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const content = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content);
    return state.assistant?.channels || {};
  } catch {
    return {};
  }
}

// Build scheduler context
function buildContext(): SchedulerContext {
  const home = homedir();

  return {
    vaultPath: process.env.OBSIDIAN_VAULT_PATH || join(home, 'Library/Mobile Documents/iCloud~md~Obsidian/Documents/Personal'),
    assistantDir: process.env.ASSISTANT_DIR || join(home, '.assistant'),
    discordToken: process.env.DISCORD_BOT_TOKEN || '',
    channels: loadChannels(),
  };
}

// Task registry
const tasks: Record<TaskName, (ctx: SchedulerContext) => Promise<TaskResult>> = {
  'morning-checkin': runMorningCheckin,
  'vault-sync': runVaultSync,
  'weekly-reconsolidation': runWeeklyReconsolidation,
  'process-clipper': runVaultSync, // Uses same logic as vault-sync for now
  'periodic-nudge': async () => ({ success: true, message: 'Nudge not implemented yet' }),
};

async function main() {
  const taskName = process.argv[2] as TaskName;

  if (!taskName) {
    console.error('Usage: bun run src/scheduler/runner.ts <task-name>');
    console.error('Available tasks:', Object.keys(tasks).join(', '));
    process.exit(1);
  }

  const taskFn = tasks[taskName];
  if (!taskFn) {
    console.error(`Unknown task: ${taskName}`);
    console.error('Available tasks:', Object.keys(tasks).join(', '));
    process.exit(1);
  }

  loadEnv();

  const ctx = buildContext();

  if (!ctx.discordToken) {
    console.error('DISCORD_BOT_TOKEN not set');
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] Running task: ${taskName}`);

  try {
    const result = await taskFn(ctx);

    if (result.success) {
      console.log(`[${new Date().toISOString()}] Task completed: ${result.message}`);
      if (result.data) {
        console.log('Data:', JSON.stringify(result.data, null, 2));
      }
    } else {
      console.error(`[${new Date().toISOString()}] Task failed: ${result.message}`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Task error:`, error?.message || error);
    process.exit(1);
  }
}

main();
