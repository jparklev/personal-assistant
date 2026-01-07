const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

export function isoDateInTimeZone(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  let year = '';
  let month = '';
  let day = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }

  if (!year || !month || !day) return new Date().toISOString().split('T')[0];
  return `${year}-${month}-${day}`;
}

export { DEFAULT_TIME_ZONE };
