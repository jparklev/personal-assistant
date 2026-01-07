/**
 * Scheduler State Management
 *
 * Stores schedule configuration and last-run times.
 * This state is editable by Claude during conversations
 * (e.g., "I wake up at 7am" → update morningCheckin.time).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface ScheduledTaskConfig {
  enabled: boolean;
  time: string; // "HH:MM" in 24-hour format
  timezone: string; // e.g., "America/Los_Angeles"
  lastRun?: string; // ISO date string (YYYY-MM-DD) - runs once per day
}

export interface WeeklyTaskConfig extends ScheduledTaskConfig {
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
}

export interface ScheduleState {
  version: 1;
  morningCheckin: ScheduledTaskConfig;
  eveningCheckin: ScheduledTaskConfig;
  healthCheckin: ScheduledTaskConfig;
  weeklyReconsolidation: WeeklyTaskConfig;
}

export function defaultScheduleState(): ScheduleState {
  return {
    version: 1,
    morningCheckin: {
      enabled: true,
      time: '08:00',
      timezone: 'America/Los_Angeles',
    },
    eveningCheckin: {
      enabled: true,
      time: '21:00',
      timezone: 'America/Los_Angeles',
    },
    healthCheckin: {
      enabled: true,
      time: '20:00', // 8 PM - before evening checkin
      timezone: 'America/Los_Angeles',
    },
    weeklyReconsolidation: {
      enabled: true,
      dayOfWeek: 0, // Sunday
      time: '10:00',
      timezone: 'America/Los_Angeles',
    },
  };
}

export class SchedulerState {
  private filePath: string;
  private state: ScheduleState;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'scheduler.json');
    this.state = this.loadFromDisk();
  }

  private dateStringInTimeZone(date: Date, timeZone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);

      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;

      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // ignore
    }
    return date.toISOString().split('T')[0];
  }

  private timeMinutesInTimeZone(date: Date, timeZone: string): number {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(date);

      const hour = parts.find((p) => p.type === 'hour')?.value;
      const minute = parts.find((p) => p.type === 'minute')?.value;

      if (hour != null && minute != null) return Number(hour) * 60 + Number(minute);
    } catch {
      // ignore
    }
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }

  private dayOfWeekInTimeZone(date: Date, timeZone: string): number {
    try {
      const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
      const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
      if (idx !== -1) return idx;
    } catch {
      // ignore
    }
    return date.getUTCDay();
  }

  get snapshot(): ScheduleState {
    return this.state;
  }

  /**
   * Update a task's configuration.
   */
  updateTask<K extends keyof Omit<ScheduleState, 'version'>>(
    task: K,
    updates: Partial<ScheduleState[K]>
  ): void {
    this.state[task] = { ...this.state[task], ...updates };
    this.saveToDisk();
  }

  /**
   * Mark a task as having run today.
   */
  markRun(task: keyof Omit<ScheduleState, 'version'>): void {
    const now = new Date();
    const tz = this.state[task].timezone;
    this.state[task].lastRun = this.dateStringInTimeZone(now, tz);
    this.saveToDisk();
  }

  /**
   * Check if a daily task is due.
   * A task is due if:
   * - It's enabled
   * - Current time is past the scheduled time
   * - It hasn't run today
   */
  isDailyTaskDue(task: 'morningCheckin' | 'eveningCheckin' | 'healthCheckin'): boolean {
    const config = this.state[task];
    if (!config.enabled) return false;

    const now = new Date();
    const todayInTz = this.dateStringInTimeZone(now, config.timezone);

    // Already ran today
    if (config.lastRun === todayInTz) return false;

    // Check if current time is past scheduled time (in task's timezone)
    const [hours, minutes] = config.time.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;

    const nowMinutes = this.timeMinutesInTimeZone(now, config.timezone);
    const scheduledMinutes = hours * 60 + minutes;

    return nowMinutes >= scheduledMinutes;
  }

  /**
   * Check if the weekly task is due.
   */
  isWeeklyTaskDue(): boolean {
    const config = this.state.weeklyReconsolidation;
    if (!config.enabled) return false;

    const now = new Date();
    const todayInTz = this.dateStringInTimeZone(now, config.timezone);

    // Already ran today
    if (config.lastRun === todayInTz) return false;

    // Check if it's the right day of week
    if (this.dayOfWeekInTimeZone(now, config.timezone) !== config.dayOfWeek) return false;

    // Check if current time is past scheduled time
    const [hours, minutes] = config.time.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;

    const nowMinutes = this.timeMinutesInTimeZone(now, config.timezone);
    const scheduledMinutes = hours * 60 + minutes;

    return nowMinutes >= scheduledMinutes;
  }

  /**
   * Get a human-readable description of the current schedule.
   */
  describeSchedule(): string {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const lines: string[] = ['**Current Schedule**', ''];

    const { morningCheckin, eveningCheckin, healthCheckin, weeklyReconsolidation } = this.state;

    lines.push(`Morning check-in: ${morningCheckin.enabled ? morningCheckin.time : 'disabled'} (${morningCheckin.timezone})`);
    lines.push(`Health check-in: ${healthCheckin.enabled ? healthCheckin.time : 'disabled'} (${healthCheckin.timezone})`);
    lines.push(`Evening check-in: ${eveningCheckin.enabled ? eveningCheckin.time : 'disabled'} (${eveningCheckin.timezone})`);
    lines.push(`Weekly reconsolidation: ${weeklyReconsolidation.enabled ? `${dayNames[weeklyReconsolidation.dayOfWeek]} ${weeklyReconsolidation.time}` : 'disabled'}`);

    return lines.join('\n');
  }

  private loadFromDisk(): ScheduleState {
    if (!existsSync(this.filePath)) {
      const state = defaultScheduleState();
      this.state = state;
      this.saveToDisk();
      return state;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Merge with defaults to handle missing fields
      const defaults = defaultScheduleState();
      return {
        version: 1,
        morningCheckin: { ...defaults.morningCheckin, ...parsed.morningCheckin },
        eveningCheckin: { ...defaults.eveningCheckin, ...parsed.eveningCheckin },
        healthCheckin: { ...defaults.healthCheckin, ...parsed.healthCheckin },
        weeklyReconsolidation: { ...defaults.weeklyReconsolidation, ...parsed.weeklyReconsolidation },
      };
    } catch {
      return defaultScheduleState();
    }
  }

  private saveToDisk(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.filePath);
  }
}
