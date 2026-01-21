/**
 * Weekly Reconsolidation Task
 *
 * Runs weekly (Sunday evening) to:
 * - Extract patterns from captures
 * - Update memory.md with learnings
 * - Generate week-in-review summary
 */

import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SchedulerContext, TaskResult } from '../types';
import { getRecentCaptures, formatCapturesForContext } from '../../captures';
import { invokeClaudeCode, buildAssistantContext } from '../../assistant/invoke';
import { isoDateForAssistant, DEFAULT_TIME_ZONE } from '../../time';

const ASSISTANT_DIR = join(homedir(), '.assistant');
const RECONSOLIDATION_STATE = join(ASSISTANT_DIR, 'state', 'reconsolidation.json');

interface ReconsolidationState {
  lastRun?: string;
  lastWeekSummary?: string;
}

function getReconsolidationState(): ReconsolidationState {
  try {
    if (existsSync(RECONSOLIDATION_STATE)) {
      return JSON.parse(readFileSync(RECONSOLIDATION_STATE, 'utf-8'));
    }
  } catch {}
  return {};
}

function updateReconsolidationState(updates: Partial<ReconsolidationState>): void {
  const current = getReconsolidationState();
  const next = { ...current, ...updates };
  const dir = join(ASSISTANT_DIR, 'state');
  const { mkdirSync } = require('fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(RECONSOLIDATION_STATE, JSON.stringify(next, null, 2));
}

export async function runWeeklyReconsolidation(ctx: SchedulerContext): Promise<TaskResult> {
  const targetChannel = ctx.channels.morningCheckin;

  if (!targetChannel) {
    return { success: false, message: 'No assistant channel configured for reconsolidation report' };
  }

  const recentCaptures = getRecentCaptures(7);
  const state = getReconsolidationState();

  const now = new Date();

  // Build prompt for Claude Code to do the analysis
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: DEFAULT_TIME_ZONE,
  });
  const prompt = `You are the personal assistant performing weekly reconsolidation.
Today is ${dateStr}.

${buildAssistantContext()}

## This Week's Captures (${recentCaptures.length})

${recentCaptures.length > 0
  ? recentCaptures.map((c) => `- [${c.type}] ${c.title} (${c.tags?.join(', ') || 'no tags'})`).join('\n')
  : '(no captures this week)'}

## Your Tasks

1. **Extract patterns from captures**: Look at this week's captures and identify:
   - Recurring themes or interests
   - Insights worth adding to memory.md

2. **Update memory.md**: If you notice patterns worth remembering:
   - Read the current ~/.assistant/memory.md
   - Add new patterns or preferences under the appropriate section
   - Keep it concise - only add genuinely useful observations

3. **Generate summary**: Create a brief "Week in Review" that:
   - Notes key themes from captures
   - Highlights one thought-provoking question for the coming week

## Output Format

Respond with a JSON object:
\`\`\`json
{
  "patternsNoticed": ["pattern 1", "pattern 2"],
  "memoryUpdates": "text to append to memory.md Patterns section (or null)",
  "weekSummary": "The summary message to send to Discord",
  "thoughtQuestion": "A question to ponder for next week"
}
\`\`\`

Be thoughtful but concise. This is about consolidation, not exhaustive analysis.`;

  const result = await invokeClaudeCode({
    prompt,
    timeout: 180000, // 3 minutes - this is a bigger task
  });

  if (!result.success) {
    return {
      success: false,
      message: `Reconsolidation failed: ${result.error}`,
    };
  }

  // Parse the response
  let analysis: {
    patternsNoticed?: string[];
    memoryUpdates?: string | null;
    weekSummary?: string;
    thoughtQuestion?: string;
  } = {};

  try {
    // Extract JSON from response (might be wrapped in markdown code block)
    const jsonMatch = result.text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, result.text];
    analysis = JSON.parse(jsonMatch[1] || '{}');
  } catch {
    // If parsing fails, use the raw response as summary
    analysis = { weekSummary: result.text };
  }

  // Update memory.md if there are updates
  if (analysis.memoryUpdates) {
    const memoryPath = join(ASSISTANT_DIR, 'memory.md');
    if (existsSync(memoryPath)) {
      let memory = readFileSync(memoryPath, 'utf-8');

      // Find the Patterns section and append
      if (memory.includes('## Patterns')) {
        const date = isoDateForAssistant();
        const update = `\n- ${date}: ${analysis.memoryUpdates}`;
        memory = memory.replace('## Patterns', `## Patterns${update}`);
        writeFileSync(memoryPath, memory);
      }
    }
  }

  // Build the Discord message
  const summaryMessage = [
    `**Week in Review** (${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
    '',
    analysis.weekSummary || 'Reconsolidation complete.',
    '',
    analysis.patternsNoticed?.length ? `Patterns: ${analysis.patternsNoticed.join(', ')}` : '',
    '',
    analysis.thoughtQuestion ? `*${analysis.thoughtQuestion}*` : '',
  ].filter(Boolean).join('\n');

  // Send to Discord
  const sendResult = await sendMessage(ctx, targetChannel, summaryMessage);

  // Update state
  updateReconsolidationState({
    lastRun: now.toISOString(),
    lastWeekSummary: analysis.weekSummary,
  });

  if (!sendResult.success) {
    return sendResult;
  }

  return {
    success: true,
    message: `Weekly reconsolidation complete`,
    data: {
      capturesReviewed: recentCaptures.length,
      patternsFound: analysis.patternsNoticed?.length || 0,
      memoryUpdated: !!analysis.memoryUpdates,
    },
  };
}

async function sendMessage(
  ctx: SchedulerContext,
  channelId: string,
  message: string
): Promise<TaskResult> {
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

    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return { success: false, message: 'Could not fetch channel' };
    }

    await channel.send(message);

    return { success: true, message: `Sent to ${channel.name}` };
  } catch (error: any) {
    return { success: false, message: error?.message || String(error) };
  } finally {
    client.destroy();
  }
}

// For testing - generate without sending
export async function generateReconsolidationContent(): Promise<{
  recentCaptures: { title: string; type: string }[];
}> {
  const recentCaptures = getRecentCaptures(7);

  return {
    recentCaptures: recentCaptures.map((c) => ({ title: c.title, type: c.type })),
  };
}
