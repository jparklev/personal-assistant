/**
 * Background Scheduler Loop
 *
 * Runs in the main bot process, checking every 15 minutes
 * for tasks that are due. This replaces external cron/systemd timers.
 */

import type { Client, TextChannel } from 'discord.js';
import type { AppConfig } from '../config';
import type { StateStore } from '../state';
import { SchedulerState } from './state';
import { getBlipsToSurface, readBlip, touchBlip } from '../blips';
import { getDueQuestions, markQuestionAsked } from '../memory';
import { getTodayReminders } from '../integrations/reminders';
import { buildAssistantContext } from '../assistant/invoke';
import { invokeClaude } from '../assistant/runner';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export interface SchedulerContext {
  client: Client;
  cfg: AppConfig;
  state: StateStore;
  scheduler: SchedulerState;
}

/**
 * Start the background scheduler loop.
 * Call this after the Discord client is ready.
 */
export function startSchedulerLoop(ctx: SchedulerContext): void {
  console.log('[Scheduler] Starting background loop (checking every 15 minutes)');
  console.log(ctx.scheduler.describeSchedule());

  // Run immediately on startup (will check if due)
  runSchedulerTick(ctx).catch((err) => {
    console.error('[Scheduler] Error on startup tick:', err);
  });

  // Then run every 15 minutes
  setInterval(() => {
    runSchedulerTick(ctx).catch((err) => {
      console.error('[Scheduler] Error on tick:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Single tick of the scheduler loop.
 */
async function runSchedulerTick(ctx: SchedulerContext): Promise<void> {
  const { scheduler } = ctx;

  // Check morning check-in
  if (scheduler.isDailyTaskDue('morningCheckin')) {
    console.log('[Scheduler] Morning check-in is due');
    try {
      await runMorningCheckin(ctx);
      scheduler.markRun('morningCheckin');
      console.log('[Scheduler] Morning check-in completed');
    } catch (err) {
      console.error('[Scheduler] Morning check-in failed:', err);
    }
  }

  // Check evening check-in
  if (scheduler.isDailyTaskDue('eveningCheckin')) {
    console.log('[Scheduler] Evening check-in is due');
    try {
      await runEveningCheckin(ctx);
      scheduler.markRun('eveningCheckin');
      console.log('[Scheduler] Evening check-in completed');
    } catch (err) {
      console.error('[Scheduler] Evening check-in failed:', err);
    }
  }

  // Check weekly reconsolidation
  if (scheduler.isWeeklyTaskDue()) {
    console.log('[Scheduler] Weekly reconsolidation is due');
    try {
      await runWeeklyReconsolidation(ctx);
      scheduler.markRun('weeklyReconsolidation');
      console.log('[Scheduler] Weekly reconsolidation completed');
    } catch (err) {
      console.error('[Scheduler] Weekly reconsolidation failed:', err);
    }
  }
}

/**
 * Morning check-in task.
 */
async function runMorningCheckin(ctx: SchedulerContext): Promise<void> {
  const channelId = ctx.state.snapshot.assistant.channels.morningCheckin;
  if (!channelId) {
    console.log('[Scheduler] Morning check-in channel not configured');
    return;
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    console.error('[Scheduler] Could not fetch morning check-in channel');
    return;
  }

  // Gather context
  const blipSummaries = getBlipsToSurface(3);
  const blipsToSurface = blipSummaries
    .map((summary) => {
      const blip = readBlip(summary.path);
      return { summary, blip, reason: `Not touched since ${summary.touched}` };
    })
    .filter((b) => b.blip !== null);
  const dueQuestions = getDueQuestions();
  const reminders = getTodayReminders();

  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const prompt = `You are the personal assistant. Generate a morning check-in message for Discord.

Today is ${dateStr}.

${buildAssistantContext()}

## Sources to Synthesize

1. **Yesterday's daily note** (${yesterday.toISOString().split('T')[0]}.md)
   - Read it from the vault at ${ctx.cfg.vaultPath}/Daily/
   - Look for incomplete checkbox items (- [ ])
   - Look for #followups tags

2. **Apple Reminders due today**: ${
    reminders.length > 0
      ? reminders.map((r) => `"${r.name}" (${r.list})`).join(', ')
      : '(none)'
  }

3. **Blips to surface**:
${
  blipsToSurface.length > 0
    ? blipsToSurface
        .map((r) => `   - ${r.blip!.title}: ${r.blip!.content.slice(0, 100)}... (${r.reason})`)
        .join('\n')
    : '   (none ready)'
}

4. **Standing question**: ${dueQuestions[0]?.question || '(none due today)'}

## Message Guidelines

- Greet warmly but concisely ("Good morning!" not "Good morning, Josh!")
- Mention reminders if any are due today
- If there are incomplete followups from yesterday, ask about them (accountable partner mode)
- If there are blips to surface, pick ONE and ask a thought-provoking question about it
- End with the standing question if there is one

Remember: encourage thinking, don't just list things. Be concise. No emojis.
Feel like a thoughtful partner checking in, not a bot generating a report.

Output ONLY the message to send, nothing else.`;

  try {
    const result = await invokeClaude(prompt, { model: 'haiku' });
    const message = result.ok && result.text
      ? result.text
      : `**Good morning!** Here's your check-in for ${dateStr}.\n\nWhat's your main focus for today?`;

    await (channel as TextChannel).send(message.slice(0, 2000));

    // Mark blips as surfaced
    blipsToSurface.forEach((r) => touchBlip(r.summary.path));

    // Mark question as asked
    if (dueQuestions[0]) {
      markQuestionAsked(dueQuestions[0].id);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to generate morning check-in:', err);
    await (channel as TextChannel).send(
      `**Good morning!** Here's your check-in for ${dateStr}.\n\nWhat's your main focus for today?`
    );
  }
}

/**
 * Evening check-in task.
 */
async function runEveningCheckin(ctx: SchedulerContext): Promise<void> {
  const channelId = ctx.state.snapshot.assistant.channels.morningCheckin; // Use same channel
  if (!channelId) {
    console.log('[Scheduler] Evening check-in channel not configured');
    return;
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    console.error('[Scheduler] Could not fetch evening check-in channel');
    return;
  }

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const prompt = `You are the personal assistant. Generate an evening check-in message for Discord.

Today is ${dateStr}.

${buildAssistantContext()}

## Your Task

Read today's daily note from the vault at ${ctx.cfg.vaultPath}/Daily/${today.toISOString().split('T')[0]}.md

Look for:
- What was accomplished today
- Any incomplete items (- [ ])
- Voice notes or meditation entries logged
- Anything that seems unresolved

## Message Guidelines

- Acknowledge what was done (without empty praise)
- Surface any loose threads: "You mentioned X but didn't close the loop"
- Ask one reflective question: "What's one thing you'd do differently?"
- If appropriate, prompt for anything worth capturing as a blip

Be brief. This is a wind-down, not a debrief. No emojis.

Output ONLY the message to send, nothing else.`;

  try {
    const result = await invokeClaude(prompt, { model: 'haiku' });
    const message = result.ok && result.text
      ? result.text
      : `**Good evening!** How did today go?\n\nAnything worth capturing before you wind down?`;

    await (channel as TextChannel).send(message.slice(0, 2000));
  } catch (err) {
    console.error('[Scheduler] Failed to generate evening check-in:', err);
    await (channel as TextChannel).send(
      `**Good evening!** How did today go?\n\nAnything worth capturing before you wind down?`
    );
  }
}

/**
 * Weekly reconsolidation task.
 */
async function runWeeklyReconsolidation(ctx: SchedulerContext): Promise<void> {
  const channelId = ctx.state.snapshot.assistant.channels.morningCheckin;
  if (!channelId) {
    console.log('[Scheduler] Weekly reconsolidation channel not configured');
    return;
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    console.error('[Scheduler] Could not fetch channel for weekly reconsolidation');
    return;
  }

  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  const prompt = `You are the personal assistant. Generate a weekly reconsolidation message for Discord.

${buildAssistantContext()}

## Your Task

1. Read the daily notes from the past week in ${ctx.cfg.vaultPath}/Daily/
   - Dates: ${weekAgo.toISOString().split('T')[0]} through ${today.toISOString().split('T')[0]}

2. Read the Goals 2026 note if it exists

3. Look for:
   - Recurring themes or topics
   - Intentions mentioned but not acted on
   - Patterns in energy/productivity
   - Items mentioned multiple times (potential goals)
   - Gaps between stated goals and actual activity

## Message Guidelines

- Summarize the week in 2-3 sentences (what was the overall arc?)
- Surface 1-2 patterns you noticed: "You mentioned X three times this week"
- Note any goal/intention gaps: "You said you wanted to Y but I didn't see progress"
- Ask one forward-looking question: "What's the one thing you want to carry into next week?"

This is a gentle weekly reflection, not a performance review. Be direct but kind. No emojis.

Output ONLY the message to send, nothing else.`;

  try {
    const result = await invokeClaude(prompt, { model: 'sonnet' }); // Use sonnet for deeper analysis
    const message = result.ok && result.text
      ? result.text
      : `**Weekly check-in**\n\nLet's take a moment to reflect on the past week. What patterns did you notice? What do you want to carry forward?`;

    await (channel as TextChannel).send(message.slice(0, 2000));
  } catch (err) {
    console.error('[Scheduler] Failed to generate weekly reconsolidation:', err);
    await (channel as TextChannel).send(
      `**Weekly check-in**\n\nLet's take a moment to reflect on the past week. What patterns did you notice? What do you want to carry forward?`
    );
  }
}
