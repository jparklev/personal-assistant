/**
 * Apple Reminders Integration
 *
 * Uses AppleScript via osascript to read reminders.
 * macOS only - will gracefully fail on other platforms.
 */

import { execSync } from 'child_process';

export interface Reminder {
  name: string;
  dueDate?: string;
  list: string;
  completed: boolean;
}

/**
 * Get all reminders due today (or overdue)
 */
export function getTodayReminders(): Reminder[] {
  if (process.platform !== 'darwin') return [];

  try {
    // AppleScript to get incomplete reminders
    const script = `
tell application "Reminders"
  set output to ""
  repeat with reminderList in lists
    set listName to name of reminderList
    repeat with r in (reminders of reminderList whose completed is false)
      set rName to name of r
      set rDue to ""
      try
        set rDue to (due date of r) as text
      end try
      set output to output & listName & "|||" & rName & "|||" & rDue & "
"
    end repeat
  end repeat
  return output
end tell
`;

    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });

    const reminders: Reminder[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    for (const line of result.trim().split('\n')) {
      if (!line.trim()) continue;

      const [list, name, dueStr] = line.split('|||');
      if (!name) continue;

      const reminder: Reminder = {
        name: name.trim(),
        list: list.trim(),
        completed: false,
      };

      if (dueStr && dueStr.trim()) {
        reminder.dueDate = dueStr.trim();

        // Parse the date to check if it's today or overdue
        try {
          const dueDate = new Date(dueStr);
          dueDate.setHours(0, 0, 0, 0);

          // Include if due today or overdue
          if (dueDate <= today) {
            reminders.push(reminder);
          }
        } catch {
          // If we can't parse the date, include it anyway
          reminders.push(reminder);
        }
      }
    }

    return reminders;
  } catch (error: any) {
    // Silently fail - Reminders might not be available
    if (process.env.DEBUG) {
      console.error('Failed to get reminders:', error.message);
    }
    return [];
  }
}

/**
 * Get all incomplete reminders (regardless of due date)
 */
export function getAllIncompleteReminders(): Reminder[] {
  if (process.platform !== 'darwin') return [];

  try {
    const script = `
tell application "Reminders"
  set output to ""
  repeat with reminderList in lists
    set listName to name of reminderList
    repeat with r in (reminders of reminderList whose completed is false)
      set rName to name of r
      set rDue to ""
      try
        set rDue to (due date of r) as text
      end try
      set output to output & listName & "|||" & rName & "|||" & rDue & "
"
    end repeat
  end repeat
  return output
end tell
`;

    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });

    const reminders: Reminder[] = [];

    for (const line of result.trim().split('\n')) {
      if (!line.trim()) continue;

      const [list, name, dueStr] = line.split('|||');
      if (!name) continue;

      reminders.push({
        name: name.trim(),
        list: list.trim(),
        completed: false,
        dueDate: dueStr?.trim() || undefined,
      });
    }

    return reminders;
  } catch (error: any) {
    if (process.env.DEBUG) {
      console.error('Failed to get reminders:', error.message);
    }
    return [];
  }
}

/**
 * Get reminder lists
 */
export function getReminderLists(): string[] {
  if (process.platform !== 'darwin') return [];

  try {
    const script = `tell application "Reminders" to get name of every list`;
    const result = execSync(`osascript -e '${script}'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    return result.trim().split(', ');
  } catch {
    return [];
  }
}

/**
 * Format reminders for display
 */
export function formatRemindersForContext(reminders: Reminder[]): string {
  if (reminders.length === 0) return '';

  const byList = new Map<string, Reminder[]>();
  for (const r of reminders) {
    const list = byList.get(r.list) || [];
    list.push(r);
    byList.set(r.list, list);
  }

  const lines: string[] = ['## Reminders Due Today'];
  for (const [list, items] of byList) {
    lines.push(`\n**${list}**`);
    for (const item of items) {
      const due = item.dueDate ? ` (due: ${item.dueDate})` : '';
      lines.push(`- [ ] ${item.name}${due}`);
    }
  }

  return lines.join('\n');
}
