export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

// Josh's "day" rolls over at 5am local time (i.e. 00:00–04:59 counts as the previous day).
export const DEFAULT_DAY_ROLLOVER_HOUR = 5;

function partsInTimeZone(
  date: Date,
  timeZone: string,
  opts?: { includeTime?: boolean }
): Record<string, string> {
  const includeTime = opts?.includeTime === true;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).formatToParts(date);

    const out: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    return out;
  } catch {
    return {};
  }
}

export function isoDateInTimeZone(date: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = partsInTimeZone(date, timeZone);
  const year = parts.year || '';
  const month = parts.month || '';
  const day = parts.day || '';

  if (!year || !month || !day) return new Date().toISOString().split('T')[0];
  return `${year}-${month}-${day}`;
}

export function hourInTimeZone(date: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): number {
  const parts = partsInTimeZone(date, timeZone, { includeTime: true });
  const hour = parts.hour;
  const n = typeof hour === 'string' ? Number(hour) : NaN;
  if (!Number.isFinite(n)) return date.getUTCHours();
  return n === 24 ? 0 : n;
}

export function addDaysIsoDate(isoDate: string, days: number): string {
  // Use noon UTC to avoid DST edge cases when converting to a Date.
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Josh's "assistant day" date string in YYYY-MM-DD.
 *
 * Uses Pacific time and a 5am rollover by default:
 * - 00:00–04:59 PT counts as the previous day.
 */
export function isoDateForAssistant(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
  dayRolloverHour: number = DEFAULT_DAY_ROLLOVER_HOUR
): string {
  const iso = isoDateInTimeZone(date, timeZone);
  const hour = hourInTimeZone(date, timeZone);
  return hour < dayRolloverHour ? addDaysIsoDate(iso, -1) : iso;
}

export function formatTimeInTimeZone(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  try {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone,
    });
  } catch {
    return date.toISOString().slice(11, 16);
  }
}
