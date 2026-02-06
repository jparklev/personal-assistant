/**
 * Background Scheduler Loop
 *
 * Runs in the main bot process, checking every 15 minutes
 * for tasks that are due. This replaces external cron/systemd timers.
 */

import type { Client, TextChannel } from 'discord.js';
import type { AppConfig } from '../config';
import type { StateStore } from '../state';
import { execSync } from 'child_process';
import { SchedulerState } from './state';
import { getDueQuestions, markQuestionAsked } from '../memory';
import { getTodayReminders } from '../integrations/reminders';
import { buildAssistantContext } from '../assistant/invoke';
import { invokeClaude } from '../assistant/runner';
import {
  buildHealthCheckinMessage,
  shouldSendCheckin,
  recordCheckinSent,
} from '../health';
import { isoDateForAssistant, addDaysIsoDate, DEFAULT_TIME_ZONE } from '../time';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export interface SchedulerContext {
  client: Client;
  cfg: AppConfig;
  state: StateStore;
  scheduler: SchedulerState;
}

export function buildTaskDateContext(now: Date, timeZone: string) {
  const tz = timeZone || DEFAULT_TIME_ZONE;
  const todayIso = isoDateForAssistant(now, tz);
  const yesterdayIso = addDaysIsoDate(todayIso, -1);
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  });
  return { timeZone: tz, todayIso, yesterdayIso, dateStr };
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

  // Pull latest vault changes (fast-forward only to avoid conflicts)
  try {
    execSync('git fetch && git pull --ff-only', {
      cwd: ctx.cfg.vaultPath,
      stdio: 'ignore',
      timeout: 30_000,
    });
  } catch {
    // Ignore failures - vault may have local changes or network issues
  }

  // Check morning check-in
  if (scheduler.isDailyTaskDue('morningCheckin')) {
    console.log('[Scheduler] Morning check-in is due');
    try {
      const didSend = await runMorningCheckinTask(ctx);
      if (didSend) {
        scheduler.markRun('morningCheckin');
        console.log('[Scheduler] Morning check-in completed');
      } else {
        console.log('[Scheduler] Morning check-in skipped (not sent)');
      }
    } catch (err) {
      console.error('[Scheduler] Morning check-in failed:', err);
    }
  }

  // Check health check-in (before evening check-in)
  if (scheduler.isDailyTaskDue('healthCheckin')) {
    console.log('[Scheduler] Health check-in is due');
    try {
      const result = await runHealthCheckinTask(ctx);
      if (result.ok) {
        scheduler.markRun('healthCheckin');
        console.log(
          result.sent
            ? '[Scheduler] Health check-in sent'
            : `[Scheduler] Health check-in skipped: ${result.message}`
        );
      } else {
        console.error('[Scheduler] Health check-in failed:', result.message);
      }
    } catch (err) {
      console.error('[Scheduler] Health check-in failed:', err);
    }
  }

  // Check evening check-in
  if (scheduler.isDailyTaskDue('eveningCheckin')) {
    console.log('[Scheduler] Evening check-in is due');
    try {
      const didSend = await runEveningCheckinTask(ctx);
      if (didSend) {
        scheduler.markRun('eveningCheckin');
        console.log('[Scheduler] Evening check-in completed');
      } else {
        console.log('[Scheduler] Evening check-in skipped (not sent)');
      }
    } catch (err) {
      console.error('[Scheduler] Evening check-in failed:', err);
    }
  }

  // Check weekly reconsolidation
  if (scheduler.isWeeklyTaskDue()) {
    console.log('[Scheduler] Weekly reconsolidation is due');
    try {
      const didSend = await runWeeklyReconsolidationTask(ctx);
      if (didSend) {
        scheduler.markRun('weeklyReconsolidation');
        console.log('[Scheduler] Weekly reconsolidation completed');
      } else {
        console.log('[Scheduler] Weekly reconsolidation skipped (not sent)');
      }
    } catch (err) {
      console.error('[Scheduler] Weekly reconsolidation failed:', err);
    }
  }
}

/**
 * Morning check-in task.
 */
export async function runMorningCheckinTask(ctx: SchedulerContext): Promise<boolean> {
  const channelId = ctx.state.snapshot.assistant.channels.morningCheckin;
  if (!channelId) {
    console.log('[Scheduler] Morning check-in channel not configured');
    return false;
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    console.error('[Scheduler] Could not fetch morning check-in channel');
    return false;
  }

  // Gather context
  const dueQuestions = getDueQuestions();
  const reminders = getTodayReminders();

  const timeCtx = buildTaskDateContext(
    new Date(),
    ctx.scheduler.snapshot.morningCheckin.timezone || DEFAULT_TIME_ZONE
  );

  const prompt = `You are the personal assistant. Generate a morning check-in message for Discord.

Today is ${timeCtx.dateStr} (${timeCtx.timeZone}).

${buildAssistantContext()}

## Sources to Synthesize

1. **Yesterday's daily note** (${timeCtx.yesterdayIso}.md)
   - Read it from the vault at ${ctx.cfg.vaultPath}/Daily/
   - Look for incomplete checkbox items (- [ ])
   - Look for #followups tags

2. **Apple Reminders due today**: ${
    reminders.length > 0
      ? reminders.map((r) => `"${r.name}" (${r.list})`).join(', ')
      : '(none)'
  }

3. **Standing question**: ${dueQuestions[0]?.question || '(none due today)'}

## Message Guidelines

- Greet warmly but concisely ("Good morning!" not "Good morning, Josh!")
- Mention reminders if any are due today
- If there are incomplete followups from yesterday, ask about them (accountable partner mode)
- End with the standing question if there is one

  Remember: encourage thinking, don't just list things. Be concise. No emojis.
  Feel like a thoughtful partner checking in, not a bot generating a report.

  Output ONLY the message to send, nothing else.`;

  const fallback = `**Good morning!** Here's your check-in for ${timeCtx.dateStr}.\n\nWhat's your main focus for today?`;
  let message = fallback;

  try {
    const result = await invokeClaude(prompt, { model: 'opus' });
    if (result.ok && result.text) message = result.text;
  } catch (err) {
    console.error('[Scheduler] Failed to generate morning check-in:', err);
  }

  try {
    await (channel as TextChannel).send(message.slice(0, 2000));

    // Mark question as asked
    if (dueQuestions[0]) {
      markQuestionAsked(dueQuestions[0].id);
    }

    return true;
  } catch (err) {
    console.error('[Scheduler] Failed to send morning check-in:', err);
    return false;
  }
}

/**
 * Evening check-in task.
 */
export async function runEveningCheckinTask(ctx: SchedulerContext): Promise<boolean> {
  const channelId = ctx.state.snapshot.assistant.channels.morningCheckin; // Use same channel
  if (!channelId) {
    console.log('[Scheduler] Evening check-in channel not configured');
    return false;
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    console.error('[Scheduler] Could not fetch evening check-in channel');
    return false;
  }

  const timeCtx = buildTaskDateContext(
    new Date(),
    ctx.scheduler.snapshot.eveningCheckin.timezone || DEFAULT_TIME_ZONE
  );

  const prompt = `You are the personal assistant. Generate an evening check-in message for Discord.

Today is ${timeCtx.dateStr} (${timeCtx.timeZone}).

${buildAssistantContext()}

## Your Task

Read today's daily note from the vault at ${ctx.cfg.vaultPath}/Daily/${timeCtx.todayIso}.md

Look for:
- What was accomplished today
- Any incomplete items (- [ ])
- Voice notes or meditation entries logged
- Anything that seems unresolved

## Message Guidelines

- Acknowledge what was done (without empty praise)
- Surface any loose threads: "You mentioned X but didn't close the loop"
- Ask one reflective question: "What's one thing you'd do differently?"

Be brief. This is a wind-down, not a debrief. No emojis.

  Output ONLY the message to send, nothing else.`;

  const fallback = `**Good evening!** How did today go?`;
  let message = fallback;

  try {
    const result = await invokeClaude(prompt, { model: 'opus' });
    if (result.ok && result.text) message = result.text;
  } catch (err) {
    console.error('[Scheduler] Failed to generate evening check-in:', err);
  }

  try {
    await (channel as TextChannel).send(message.slice(0, 2000));
    return true;
  } catch (err) {
    console.error('[Scheduler] Failed to send evening check-in:', err);
    return false;
  }
}

/**
 * Weekly reconsolidation task.
 */
export async function runWeeklyReconsolidationTask(ctx: SchedulerContext): Promise<boolean> {
  const channelId = ctx.state.snapshot.assistant.channels.morningCheckin;
  if (!channelId) {
    console.log('[Scheduler] Weekly reconsolidation channel not configured');
    return false;
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    console.error('[Scheduler] Could not fetch channel for weekly reconsolidation');
    return false;
  }

  const timeCtx = buildTaskDateContext(
    new Date(),
    ctx.scheduler.snapshot.weeklyReconsolidation.timezone || DEFAULT_TIME_ZONE
  );
  const weekAgoIso = addDaysIsoDate(timeCtx.todayIso, -7);

  const prompt = `You are the personal assistant. Generate a weekly reconsolidation message for Discord.

${buildAssistantContext()}

## Your Task

1. Read the daily notes from the past week in ${ctx.cfg.vaultPath}/Daily/
   - Dates: ${weekAgoIso} through ${timeCtx.todayIso}

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

  const fallback =
    `**Weekly check-in**\n\nLet's take a moment to reflect on the past week. What patterns did you notice? What do you want to carry forward?`;
  let message = fallback;

  try {
    const result = await invokeClaude(prompt, { model: 'sonnet' }); // Use sonnet for deeper analysis
    if (result.ok && result.text) message = result.text;
  } catch (err) {
    console.error('[Scheduler] Failed to generate weekly reconsolidation:', err);
  }

  try {
    await (channel as TextChannel).send(message.slice(0, 2000));
    return true;
  } catch (err) {
    console.error('[Scheduler] Failed to send weekly reconsolidation:', err);
    return false;
  }
}

/**
 * Health check-in task.
 *
 * Sends to the health channel with protocol awareness.
 * Respects anti-spam logic from health state.
 */
type HealthCheckinResult = { ok: boolean; sent: boolean; message: string };

export async function runHealthCheckinTask(ctx: SchedulerContext): Promise<HealthCheckinResult> {

  const channelId = ctx.state.snapshot.assistant.channels.health;
  if (!channelId) {
    return { ok: true, sent: false, message: 'Health channel not configured' };
  }

  // Check anti-spam logic
  const { send, reason } = shouldSendCheckin();
  if (!send) {
    return { ok: true, sent: false, message: reason };
  }

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    return { ok: false, sent: false, message: 'Could not fetch health channel' };
  }

  const { text: message } = buildHealthCheckinMessage(ctx.cfg.vaultPath);

  try {
    await (channel as any).send(message);
    recordCheckinSent();
    return { ok: true, sent: true, message: 'Sent' };
  } catch (err) {
    console.error('[Scheduler] Failed to send health check-in:', err);
    return { ok: false, sent: false, message: err instanceof Error ? err.message : String(err) };
  }
}
