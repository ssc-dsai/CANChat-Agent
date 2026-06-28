import { describe, expect, it } from 'vitest';
import { buildMessagesUrl, htmlToText, messageToDoc, type GraphMessage } from './graphMail';

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
