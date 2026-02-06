import { describe, expect, it } from 'bun:test';
import { buildTaskDateContext } from '../src/scheduler/loop';

describe('scheduler timezone context', () => {
  it('uses task timezone and assistant rollover when computing today/yesterday', () => {
    const at = new Date('2026-02-06T07:30:00.000Z'); // 11:30pm previous day in Pacific
    const ctx = buildTaskDateContext(at, 'America/Los_Angeles');

    expect(ctx.todayIso).toBe('2026-02-05');
    expect(ctx.yesterdayIso).toBe('2026-02-04');
    expect(ctx.timeZone).toBe('America/Los_Angeles');
  });
});
