import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import type { SchedulerContext, TaskResult } from '../types';
import { getDueQuestions, markQuestionAsked, updateMorningCheckin } from '../../memory';
import { invokeClaudeCode, buildAssistantContext } from '../../assistant/invoke';
import { getTodayReminders } from '../../integrations/reminders';
import { isoDateForAssistant, addDaysIsoDate, DEFAULT_TIME_ZONE } from '../../time';

export async function runMorningCheckin(ctx: SchedulerContext): Promise<TaskResult> {
  if (!ctx.channels.morningCheckin) {
    return { success: false, message: 'Morning check-in channel not configured' };
  }

  // Gather context from all sources
  const dueQuestions = getDueQuestions();
  const reminders = getTodayReminders();

  // Use Pacific timezone with 5am rollover for "today" and "yesterday"
  const todayIso = isoDateForAssistant();
  const yesterdayIso = addDaysIsoDate(todayIso, -1);
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: DEFAULT_TIME_ZONE,
  });

  // Build prompt for Claude Code - let it read the vault directly
  const prompt = `You are the personal assistant. Generate a morning check-in message for Discord.

Today is ${dateStr}.

${buildAssistantContext()}

## Sources to Synthesize

1. **Yesterday's daily note** (${yesterdayIso}.md)
   - Read it from the vault
   - Look for incomplete checkbox items (- [ ])
   - Look for #followups tags

2. **Apple Reminders due today**: ${reminders.length > 0
    ? reminders.map(r => `"${r.name}" (${r.list})`).join(', ')
    : '(none)'}

3. **Standing question**: ${dueQuestions[0]?.question || '(none due today)'}

## Message Guidelines

- Greet warmly but concisely ("Good morning!" not "Good morning, Josh!")
- Mention reminders if any are due today
- If there are incomplete followups from yesterday, ask about them (accountable partner mode)
- End with the standing question if there is one

Remember: encourage thinking, don't just list things. Be concise. No emojis.
Feel like a thoughtful partner checking in, not a bot generating a report.

Output ONLY the message to send, nothing else.`;

  // Invoke Claude Code
  const result = await invokeClaudeCode({
    prompt,
    timeout: 90000, // More time since it may read files
  });

  const morningContext: MorningContext = {
    dueQuestions,
    remindersCount: reminders.length,
  };

  if (!result.success) {
    // Fallback to simple message
    const fallback = `**Good morning!** Here's your check-in for ${dateStr}.\n\nWhat's your main focus for today?`;
    return await sendMessage(ctx, fallback, morningContext);
  }

  return await sendMessage(ctx, result.text, morningContext);
}

interface MorningContext {
  dueQuestions: { id: string }[];
  remindersCount: number;
}

async function sendMessage(
  ctx: SchedulerContext,
  message: string,
  morning: MorningContext
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

    const channel = await client.channels.fetch(ctx.channels.morningCheckin!);
    if (!channel || !(channel instanceof TextChannel)) {
      return { success: false, message: 'Could not fetch morning check-in channel' };
    }

    await channel.send(message);

    // Mark question as asked
    if (morning.dueQuestions[0]) {
      markQuestionAsked(morning.dueQuestions[0].id);
    }

    // Update state
    updateMorningCheckin(channel.id);

    return {
      success: true,
      message: `Morning check-in sent to ${channel.name}`,
      data: {
        remindersCount: morning.remindersCount,
        questionAsked: morning.dueQuestions[0]?.id,
        usedClaudeCode: true,
      },
    };
  } catch (error: any) {
    return { success: false, message: error?.message || String(error) };
  } finally {
    client.destroy();
  }
}

// For testing - generate without sending
export async function generateMorningCheckinContent(): Promise<{
  message: string;
  remindersCount: number;
  dueQuestion?: { id: string; question: string };
}> {
  const dueQuestions = getDueQuestions();
  const reminders = getTodayReminders();

  // Use Pacific timezone with 5am rollover for "today" and "yesterday"
  const todayIso = isoDateForAssistant();
  const yesterdayIso = addDaysIsoDate(todayIso, -1);
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: DEFAULT_TIME_ZONE,
  });

  const prompt = `You are the personal assistant. Generate a morning check-in message.

Today is ${dateStr}.

${buildAssistantContext()}

## Sources to Synthesize

1. **Yesterday's daily note** (${yesterdayIso}.md)
   - Read it from the vault
   - Look for incomplete checkbox items (- [ ])
   - Look for #followups tags

2. **Apple Reminders due today**: ${reminders.length > 0
    ? reminders.map(r => `"${r.name}" (${r.list})`).join(', ')
    : '(none)'}

3. **Standing question**: ${dueQuestions[0]?.question || '(none due today)'}

## Message Guidelines

- Greet warmly but concisely
- Mention reminders if any are due today
- If there are incomplete followups from yesterday, ask about them
- End with the standing question if there is one

Remember: encourage thinking, don't just list things. Be concise. No emojis.
Output ONLY the message, nothing else.`;

  const result = await invokeClaudeCode({
    prompt,
    timeout: 90000,
  });

  const message = result.success
    ? result.text
    : `**Good morning!** Here's your check-in for ${dateStr}.\n\nWhat's your main focus for today?`;

  return {
    message,
    remindersCount: reminders.length,
    dueQuestion: dueQuestions[0] ? { id: dueQuestions[0].id, question: dueQuestions[0].question } : undefined,
  };
}
