/**
 * Weekly Reconsolidation Task
 *
 * Runs weekly (Sunday evening) to:
 * - Review and archive stale blips
 * - Extract patterns from captures
 * - Update memory.md with learnings
 * - Generate week-in-review summary
 */

import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SchedulerContext, TaskResult } from '../types';
import { listBlips, readBlip, archiveBlip, type BlipSummary } from '../../blips';
import { getRecentCaptures, formatCapturesForContext } from '../../captures';
import { invokeClaudeCode, buildAssistantContext } from '../../assistant/invoke';

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
  // Can use any channel that's configured
  const targetChannel = ctx.channels.morningCheckin || ctx.channels.blips;

  if (!targetChannel) {
    return { success: false, message: 'No assistant channel configured for reconsolidation report' };
  }

  const blips = listBlips();
  const recentCaptures = getRecentCaptures(7);
  const state = getReconsolidationState();

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Find stale blips (>30 days old)
  const staleBlips = blips.filter((b: BlipSummary) => {
    if (b.status === 'archived' || b.status === 'bumped') return false;
    const created = new Date(b.created);
    const daysSinceCreated = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceCreated > 30;
  });

  // Build prompt for Claude Code to do the analysis
  const prompt = `You are the personal assistant performing weekly reconsolidation.
Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.

${buildAssistantContext()}

## This Week's Captures (${recentCaptures.length})

${recentCaptures.length > 0
  ? recentCaptures.map((c) => `- [${c.type}] ${c.title} (${c.tags?.join(', ') || 'no tags'})`).join('\n')
  : '(no captures this week)'}

## Stale Blips (${staleBlips.length} older than 30 days)

${staleBlips.length > 0
  ? staleBlips.map((b: BlipSummary) => `- ${b.filename} (${b.status}): ${b.title}`).join('\n')
  : '(no stale blips)'}

## Your Tasks

1. **Review stale blips**: For each stale blip, decide:
   - ARCHIVE: No longer relevant, can be archived
   - KEEP: Still valuable, should stay
   - CONNECT: Could connect to another blip or vault note

   To archive a blip, note it in your response. I'll handle the actual archiving.

2. **Extract patterns from captures**: Look at this week's captures and identify:
   - Recurring themes or interests
   - Potential connections to existing blips
   - Insights worth adding to memory.md

3. **Update memory.md**: If you notice patterns worth remembering:
   - Read the current ~/.assistant/memory.md
   - Add new patterns or preferences under the appropriate section
   - Keep it concise - only add genuinely useful observations

4. **Generate summary**: Create a brief "Week in Review" that:
   - Notes key themes from captures
   - Mentions any blips archived or connected
   - Highlights one thought-provoking question for the coming week

## Output Format

Respond with a JSON object:
\`\`\`json
{
  "blipsToArchive": ["id1", "id2"],
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
    blipsToArchive?: string[];
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

  // Archive stale blips
  const archived: string[] = [];
  for (const filename of analysis.blipsToArchive || []) {
    // Find the blip by filename
    const blip = blips.find((b: BlipSummary) => b.filename.includes(filename) || b.title.toLowerCase().includes(filename.toLowerCase()));
    if (blip) {
      try {
        archiveBlip(blip.path);
        archived.push(filename);
      } catch {
        // Skip if archive fails
      }
    }
  }

  // Update memory.md if there are updates
  if (analysis.memoryUpdates) {
    const memoryPath = join(ASSISTANT_DIR, 'memory.md');
    if (existsSync(memoryPath)) {
      let memory = readFileSync(memoryPath, 'utf-8');

      // Find the Patterns section and append
      if (memory.includes('## Patterns')) {
        const date = now.toISOString().split('T')[0];
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
    archived.length > 0 ? `Archived ${archived.length} stale blip(s).` : '',
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
      blipsArchived: archived.length,
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
  blipsIndex: { filename: string; status: string; title: string }[];
  recentCaptures: { title: string; type: string }[];
  staleBlipCount: number;
}> {
  const blips = listBlips();
  const recentCaptures = getRecentCaptures(7);

  const now = new Date();
  const staleBlips = blips.filter((b: BlipSummary) => {
    if (b.status === 'archived' || b.status === 'bumped') return false;
    const created = new Date(b.created);
    const daysSinceCreated = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceCreated > 30;
  });

  return {
    blipsIndex: blips.map((b: BlipSummary) => ({ filename: b.filename, status: b.status, title: b.title })),
    recentCaptures: recentCaptures.map((c) => ({ title: c.title, type: c.type })),
    staleBlipCount: staleBlips.length,
  };
}
