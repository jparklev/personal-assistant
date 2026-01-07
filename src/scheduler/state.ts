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
    const today = new Date().toISOString().split('T')[0];
    this.state[task].lastRun = today;
    this.saveToDisk();
  }

  /**
   * Check if a daily task is due.
   * A task is due if:
   * - It's enabled
   * - Current time is past the scheduled time
   * - It hasn't run today
   */
  isDailyTaskDue(task: 'morningCheckin' | 'eveningCheckin'): boolean {
    const config = this.state[task];
    if (!config.enabled) return false;

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Already ran today
    if (config.lastRun === today) return false;

    // Check if current time is past scheduled time
    const [hours, minutes] = config.time.split(':').map(Number);
    const scheduledTime = new Date(now);

    // Convert to task's timezone
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
    const scheduledInTz = new Date(nowInTz);
    scheduledInTz.setHours(hours, minutes, 0, 0);

    return nowInTz >= scheduledInTz;
  }

  /**
   * Check if the weekly task is due.
   */
  isWeeklyTaskDue(): boolean {
    const config = this.state.weeklyReconsolidation;
    if (!config.enabled) return false;

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Already ran today
    if (config.lastRun === today) return false;

    // Check if it's the right day of week
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
    if (nowInTz.getDay() !== config.dayOfWeek) return false;

    // Check if current time is past scheduled time
    const [hours, minutes] = config.time.split(':').map(Number);
    const scheduledInTz = new Date(nowInTz);
    scheduledInTz.setHours(hours, minutes, 0, 0);

    return nowInTz >= scheduledInTz;
  }

  /**
   * Get a human-readable description of the current schedule.
   */
  describeSchedule(): string {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const lines: string[] = ['**Current Schedule**', ''];

    const { morningCheckin, eveningCheckin, weeklyReconsolidation } = this.state;

    lines.push(`Morning check-in: ${morningCheckin.enabled ? morningCheckin.time : 'disabled'} (${morningCheckin.timezone})`);
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
