import { describe, expect, it } from 'vitest';
import {
  buildGraphDraftMessage,
  buildGraphMailFilter,
  buildGraphMailSearchUrl,
  buildMessagesUrl,
  createMessageUrl,
  htmlToText,
  messageToDoc,
  parseGraphDraftResponse,
  parseGraphMailSearch,
  type GraphMessage,
} from './graphMail';

describe('buildMessagesUrl', () => {
  it('selects fields, caps $top, and orders newest-first', () => {
    const u = new URL(buildMessagesUrl({ top: 500 }));
    expect(u.pathname).toBe('/v1.0/me/messages');
    expect(u.searchParams.get('$select')).toContain('receivedDateTime');
    expect(u.searchParams.get('$top')).toBe('100'); // clamped
    expect(u.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(u.searchParams.get('$filter')).toBeNull();
  });

  it('adds the high-water-mark $filter for incremental refresh', () => {
    const u = new URL(buildMessagesUrl({ since: '2026-01-01T00:00:00Z' }));
    expect(u.searchParams.get('$filter')).toBe('receivedDateTime gt 2026-01-01T00:00:00Z');
  });
});

describe('htmlToText', () => {
  it('strips tags, drops scripts, and decodes entities', () => {
    const out = htmlToText('<p>Hi&nbsp;<b>Bob</b></p><script>x()</script><div>Line&amp;2</div>');
    expect(out).toBe('Hi Bob\nLine&2');
  });
});

describe('messageToDoc', () => {
  const base: GraphMessage = {
    id: 'AAMk-1',
    subject: 'Quarterly RCN update',
    from: { emailAddress: { name: 'Brian Ray', address: 'brian@contoso.com' } },
    toRecipients: [
      { emailAddress: { name: 'Me', address: 'me@contoso.com' } },
      { emailAddress: { address: 'team@contoso.com' } },
    ],
    receivedDateTime: '2026-03-02T12:00:00Z',
    webLink: 'https://outlook.office.com/mail/id/AAMk-1',
    body: { contentType: 'text', content: 'The RCN figure is finalized.' },
  };

  it('projects headers + body into a RAG doc keyed by id', () => {
    const doc = messageToDoc(base);
    expect(doc.id).toBe('AAMk-1');
    expect(doc.url).toBe('https://outlook.office.com/mail/id/AAMk-1');
    expect(doc.mtime).toBe(Date.parse('2026-03-02T12:00:00Z'));
    expect(doc.text).toContain('From: Brian Ray <brian@contoso.com>');
    expect(doc.text).toContain('To: Me <me@contoso.com>, team@contoso.com');
    expect(doc.text).toContain('Subject: Quarterly RCN update');
    expect(doc.text).toContain('The RCN figure is finalized.');
  });

  it('converts HTML bodies to text', () => {
    const doc = messageToDoc({ ...base, body: { contentType: 'html', content: '<p>Net <b>RCN</b></p>' } });
    expect(doc.text).toContain('Net RCN');
    expect(doc.text).not.toContain('<b>');
  });

  it('handles a missing subject and empty body without throwing', () => {
    const doc = messageToDoc({ id: 'x', receivedDateTime: '2026-01-01T00:00:00Z' });
    expect(doc.subject).toBe('(no subject)');
    expect(doc.url).toContain('outlook.office.com');
    expect(doc.text).toContain('Subject: (no subject)');
  });
});

describe('buildGraphMailFilter', () => {
  it('combines subject, sender, and date-range clauses', () => {
    const filter = buildGraphMailFilter({ query: 'budget', from: 'Brian Ray', since: '2026-01-01', until: '2026-01-31' });
    expect(filter).toContain("contains(subject,'budget')");
    expect(filter).toContain("contains(from/emailAddress/name,'Brian Ray')");
    expect(filter).toContain('receivedDateTime ge 2026-01-01T00:00:00Z');
    expect(filter).toContain('receivedDateTime le 2026-01-31T23:59:59Z');
    expect(filter.split(' and ')).toHaveLength(4);
  });

  it('returns an empty string with no filters', () => {
    expect(buildGraphMailFilter({})).toBe('');
  });

  it('ignores malformed dates and escapes embedded quotes', () => {
    const filter = buildGraphMailFilter({ query: "o'brien", since: 'not-a-date' });
    expect(filter).toBe("contains(subject,'o''brien')");
  });
});

describe('buildGraphMailSearchUrl', () => {
  it('selects fields, clamps top, and orders newest-first', () => {
    const u = new URL(buildGraphMailSearchUrl({ top: 500 }));
    expect(u.pathname).toBe('/v1.0/me/messages');
    expect(u.searchParams.get('$top')).toBe('25'); // clamped
    expect(u.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(u.searchParams.get('$filter')).toBeNull();
  });

  it('includes the $filter when a query/from/date is given', () => {
    const u = new URL(buildGraphMailSearchUrl({ from: 'Brian Ray' }));
    expect(u.searchParams.get('$filter')).toContain('Brian Ray');
  });
});

describe('parseGraphMailSearch', () => {
  it('maps messages into the search-hit shape', () => {
    const hits = parseGraphMailSearch({
      value: [
        {
          subject: 'Budget update',
          from: { emailAddress: { name: 'Brian Ray', address: 'brian@contoso.com' } },
          receivedDateTime: '2026-03-02T12:00:00Z',
          webLink: 'https://outlook.office.com/mail/id/1',
          bodyPreview: '  The figures are final.  ',
        },
      ],
    });
    expect(hits).toEqual([
      {
        subject: 'Budget update',
        from: 'Brian Ray <brian@contoso.com>',
        received: '2026-03-02T12:00:00Z',
        url: 'https://outlook.office.com/mail/id/1',
        preview: 'The figures are final.',
      },
    ]);
  });

  it('returns [] for a malformed response', () => {
    expect(parseGraphMailSearch({})).toEqual([]);
    expect(parseGraphMailSearch(null)).toEqual([]);
  });
});

describe('createMessageUrl', () => {
  it('points at /me/messages', () => {
    expect(createMessageUrl()).toBe('https://graph.microsoft.com/v1.0/me/messages');
  });
});

describe('draft builders', () => {
  it('builds a Graph message body with lowercase importance and recipients', () => {
    const body = buildGraphDraftMessage({
      to: ['a@x.com'],
      cc: ['b@x.com'],
      subject: 'Hi',
      body: 'Text body',
      importance: 'High',
    }) as Record<string, unknown>;
    expect(body.subject).toBe('Hi');
    expect(body.importance).toBe('high');
    expect(body.body).toEqual({ contentType: 'Text', content: 'Text body' });
    expect(body.toRecipients).toEqual([{ emailAddress: { address: 'a@x.com' } }]);
    expect(body.ccRecipients).toEqual([{ emailAddress: { address: 'b@x.com' } }]);
    expect(body.bccRecipients).toBeUndefined();
  });

  it('parses the created-message response', () => {
    const result = parseGraphDraftResponse({ id: 'AAMk-2', changeKey: 'CK', webLink: 'https://outlook.office.com/mail/id/2' });
    expect(result).toEqual({ id: 'AAMk-2', changeKey: 'CK', url: 'https://outlook.office.com/mail/id/2' });
  });

  it('throws when the response has no id', () => {
    expect(() => parseGraphDraftResponse({})).toThrow(/did not return a draft/);
  });
});
