import { describe, expect, it } from 'vitest';
import { buildRunNotificationMessage, computeNextRunAt, nextRunFromSchedule, parseLocalTimeOfDay } from './scheduledTasks';

describe('buildRunNotificationMessage', () => {
  it('mentions saved product file names on success', () => {
    expect(buildRunNotificationMessage('ok', undefined, ['headlines.pptx'])).toContain('Saved to Products: headlines.pptx');
  });

  it('omits the Products line when nothing was generated', () => {
    expect(buildRunNotificationMessage('ok', undefined, undefined)).not.toContain('Products');
    expect(buildRunNotificationMessage('ok', undefined, [])).not.toContain('Products');
  });

  it('surfaces the error text on failure', () => {
    expect(buildRunNotificationMessage('error', 'Model request timed out', undefined)).toBe('Failed: Model request timed out');
  });

  it('flags the approval-needed case distinctly', () => {
    expect(buildRunNotificationMessage('needs_approval', undefined, undefined)).toContain('approval');
  });
});

describe('scheduled task helpers', () => {
  it('parses HH:mm local times', () => {
    expect(parseLocalTimeOfDay('08:05')).toEqual({ hours: 8, minutes: 5 });
    expect(parseLocalTimeOfDay('24:00')).toBeNull();
  });

  it('computes the next daily run today when the time is still future', () => {
    const from = new Date('2026-07-06T07:00:00').getTime();
    const next = computeNextRunAt({ kind: 'daily', timeOfDay: '08:00' }, from)!;
    const d = new Date(next);
    expect(d.getDate()).toBe(6);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it('rolls daily runs to tomorrow when the time has passed', () => {
    const from = new Date('2026-07-06T09:00:00').getTime();
    const next = computeNextRunAt({ kind: 'daily', timeOfDay: '08:00' }, from)!;
    const d = new Date(next);
    expect(d.getDate()).toBe(7);
    expect(d.getHours()).toBe(8);
  });

  it('computes weekly runs on allowed days', () => {
    const from = new Date('2026-07-06T09:00:00').getTime(); // Monday
    const next = computeNextRunAt({ kind: 'weekly', timeOfDay: '08:00', daysOfWeek: [1, 3] }, from)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(3); // Wednesday, because Monday 08:00 passed
    expect(d.getHours()).toBe(8);
  });

  it('computes interval schedules from the current time', () => {
    const from = Date.parse('2026-07-06T10:00:00Z');
    expect(computeNextRunAt({ kind: 'interval', intervalMinutes: 120 }, from)).toBe(from + 120 * 60_000);
  });

  it('rejects one-shot runs in the past', () => {
    const now = Date.parse('2026-07-06T10:00:00Z');
    expect(nextRunFromSchedule('2026-07-06T09:00:00Z', undefined, now)).toBeNull();
  });
});
