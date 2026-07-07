import { describe, expect, it } from 'vitest';
import { buildCalendarViewUrl, eventMatchesQuery, extractTeamsUrl, parseCalendarView } from './graphCalendar';

describe('buildCalendarViewUrl', () => {
  it('sets the date window, a generous page size, and chronological order', () => {
    const u = new URL(buildCalendarViewUrl('2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z'));
    expect(u.pathname).toBe('/v1.0/me/calendarView');
    expect(u.searchParams.get('startDateTime')).toBe('2026-03-01T00:00:00Z');
    expect(u.searchParams.get('endDateTime')).toBe('2026-03-08T00:00:00Z');
    expect(u.searchParams.get('$orderby')).toBe('start/dateTime');
    expect(u.searchParams.get('$select')).toContain('body');
  });

  it('drops the full body field (but keeps bodyPreview) when includeBody is false', () => {
    const u = new URL(buildCalendarViewUrl('2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z', false));
    const fields = (u.searchParams.get('$select') ?? '').split(',');
    expect(fields).toContain('bodyPreview');
    expect(fields).not.toContain('body');
  });
});

describe('extractTeamsUrl', () => {
  it('finds a Teams meeting link in free text', () => {
    expect(extractTeamsUrl('Join here: https://teams.microsoft.com/l/meetup-join/abc123.')).toBe(
      'https://teams.microsoft.com/l/meetup-join/abc123',
    );
  });
  it('returns undefined when there is none', () => {
    expect(extractTeamsUrl('No link here')).toBeUndefined();
  });
});

describe('parseCalendarView', () => {
  const raw = {
    value: [
      {
        id: 'evt-1',
        subject: 'Budget review',
        start: { dateTime: '2026-03-02T09:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-03-02T09:30:00.0000000', timeZone: 'UTC' },
        location: { displayName: 'Room 4' },
        organizer: { emailAddress: { name: 'Brian Ray', address: 'brian@contoso.com' } },
        attendees: [
          { emailAddress: { name: 'Me', address: 'me@contoso.com' }, type: 'required' },
          { emailAddress: { address: 'observer@contoso.com' }, type: 'optional' },
        ],
        bodyPreview: 'Quick sync',
        body: { contentType: 'html', content: '<p>Agenda: <b>RCN</b></p>' },
        webLink: 'https://outlook.office.com/calendar/item/evt-1',
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz' },
      },
    ],
  };

  it('projects a Graph event into the shared calendar-event shape', () => {
    const [event] = parseCalendarView(raw);
    expect(event.id).toBe('evt-1');
    expect(event.subject).toBe('Budget review');
    expect(event.start).toBe('2026-03-02T09:00:00.0000000Z');
    expect(event.end).toBe('2026-03-02T09:30:00.0000000Z');
    expect(event.location).toBe('Room 4');
    expect(event.organizer).toBe('Brian Ray <brian@contoso.com>');
    expect(event.requiredAttendees).toEqual(['Me <me@contoso.com>']);
    expect(event.optionalAttendees).toEqual(['observer@contoso.com']);
    expect(event.bodyText).toBe('Agenda: RCN');
    expect(event.teamsUrl).toBe('https://teams.microsoft.com/l/meetup-join/xyz');
    expect(event.url).toBe('https://outlook.office.com/calendar/item/evt-1');
  });

  it('filters out events missing id/start/end', () => {
    expect(parseCalendarView({ value: [{ subject: 'no id' }] })).toEqual([]);
    expect(parseCalendarView({})).toEqual([]);
    expect(parseCalendarView(null)).toEqual([]);
  });
});

describe('eventMatchesQuery', () => {
  const event = {
    id: '1',
    subject: 'Budget review',
    start: '',
    end: '',
    location: 'Room 4',
    organizer: 'Brian Ray',
    url: '',
  };

  it('matches on subject/location/organizer terms (all terms required)', () => {
    expect(eventMatchesQuery(event, 'budget room')).toBe(true);
    expect(eventMatchesQuery(event, 'budget nomatch')).toBe(false);
  });

  it('is true for an empty query', () => {
    expect(eventMatchesQuery(event, undefined)).toBe(true);
    expect(eventMatchesQuery(event, '  ')).toBe(true);
  });
});
