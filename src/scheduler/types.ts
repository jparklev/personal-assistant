export interface SchedulerContext {
  vaultPath: string;
  assistantDir: string;
  discordToken: string;
  channels: {
    morningCheckin?: string;
    questions?: string;
    blips?: string;
    captures?: string;
  };
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: TaskSchedule;
  run: (ctx: SchedulerContext) => Promise<TaskResult>;
}

export interface TaskSchedule {
  type: 'cron' | 'interval' | 'once';
  // For cron: "30 4 * * *" (4:30am daily)
  // For interval: milliseconds
  // For once: ISO timestamp
  value: string;
}

export interface TaskResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export type TaskName = 'morning-checkin' | 'weekly-reconsolidation' | 'vault-sync' | 'process-clipper' | 'periodic-nudge';
