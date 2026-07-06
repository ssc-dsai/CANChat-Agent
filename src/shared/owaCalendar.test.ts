import { describe, expect, it } from 'vitest';
import { buildGetCalendarViewBody, eventMatchesQuery, extractTeamsUrl, parseCalendarView } from './owaCalendar';

describe('owaCalendar helpers', () => {
  it('builds a GetCalendarView request for the calendar folder', () => {
    const body = buildGetCalendarViewBody('2026-07-06T00:00:00Z', '2026-07-13T00:00:00Z') as any;
    expect(body.__type).toBe('GetCalendarViewJsonRequest:#Exchange');
    expect(body.Body.CalendarView.StartDate).toBe('2026-07-06T00:00:00Z');
    expect(body.Body.CalendarView.EndDate).toBe('2026-07-13T00:00:00Z');
    expect(body.Body.ParentFolderIds[0].Id).toBe('calendar');
    expect(body.Body.ItemShape.BodyType).toBe('Text');
  });

  it('can omit body fetching', () => {
    const body = buildGetCalendarViewBody('2026-07-06T00:00:00Z', '2026-07-13T00:00:00Z', false) as any;
    expect(body.Body.ItemShape.BodyType).toBeUndefined();
    expect(body.Body.ItemShape.AdditionalProperties.some((p: any) => p.FieldURI === 'Body')).toBe(false);
  });

  it('extracts Teams links from free text', () => {
    expect(extractTeamsUrl('Join https://teams.microsoft.com/l/meetup-join/abc?x=1.')).toBe(
      'https://teams.microsoft.com/l/meetup-join/abc?x=1',
    );
  });

  it('parses calendar events defensively', () => {
    const events = parseCalendarView(
      {
        Body: {
          ResponseMessages: {
            Items: [
              {
                RootFolder: {
                  Items: [
                    {
                      ItemId: { Id: 'abc' },
                      Subject: 'Project Sync',
                      Start: '2026-07-06T15:00:00Z',
                      End: '2026-07-06T15:30:00Z',
                      Location: { DisplayName: 'Microsoft Teams Meeting' },
                      Organizer: { Mailbox: { Name: 'Ada', EmailAddress: 'ada@example.com' } },
                      RequiredAttendees: [{ Mailbox: { Name: 'Grace', EmailAddress: 'grace@example.com' } }],
                      Preview: 'Discuss launch docs',
                      Body: { Value: '<p>Agenda</p><p>https://teams.microsoft.com/l/meetup-join/abc</p>' },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      'https://outlook.office.com',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'abc',
      subject: 'Project Sync',
      organizer: 'Ada <ada@example.com>',
      requiredAttendees: ['Grace <grace@example.com>'],
      teamsUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
    });
    expect(events[0].bodyText).toContain('Agenda');
    expect(events[0].url).toContain('/calendar/item/abc');
  });

  it('filters events by all query terms', () => {
    const event = {
      id: '1',
      subject: 'Budget review',
      start: '2026-07-06T15:00:00Z',
      end: '2026-07-06T15:30:00Z',
      organizer: 'Ada',
      bodyText: 'Q4 planning',
      url: 'https://outlook.office.com/calendar/item/1',
    };
    expect(eventMatchesQuery(event, 'budget planning')).toBe(true);
    expect(eventMatchesQuery(event, 'budget legal')).toBe(false);
  });
});
