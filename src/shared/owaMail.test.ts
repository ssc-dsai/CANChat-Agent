import { describe, expect, it } from 'vitest';
import {
  buildFindFolderBody,
  buildFindItemBody,
  buildGetItemBody,
  isMailFolder,
  messageToMailDoc,
  messageUrl,
  parseFindItem,
  parseFolders,
  parseGetItem,
  type OwaMessage,
} from './owaMail';

// Helper to reach into the deep request envelopes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (o: unknown) => (o as any).Body;

describe('buildFindFolderBody', () => {
  it('enumerates the whole mailbox from msgfolderroot, deep', () => {
    const b = body(buildFindFolderBody());
    expect(b.__type).toBe('FindFolderRequest:#Exchange');
    expect(b.Traversal).toBe('Deep');
    expect(b.ParentFolderIds[0].Id).toBe('msgfolderroot');
    const props = b.FolderShape.AdditionalProperties.map((p: { FieldURI: string }) => p.FieldURI);
    expect(props).toContain('FolderClass');
  });
});

describe('parseFolders + isMailFolder', () => {
  const json = {
    Body: {
      ResponseMessages: {
        Items: [
          {
            RootFolder: {
              Folders: [
                { FolderId: { Id: 'AAA' }, DisplayName: 'Inbox', FolderClass: 'IPF.Note' },
                { FolderId: { Id: 'BBB' }, DisplayName: 'Sent', FolderClass: 'IPF.Note' },
                { FolderId: { Id: 'CCC' }, DisplayName: 'Calendar', FolderClass: 'IPF.Appointment' },
                { DisplayName: 'no-id-skipped', FolderClass: 'IPF.Note' },
              ],
            },
          },
        ],
      },
    },
  };

  it('extracts folders with ids and drops id-less entries', () => {
    const folders = parseFolders(json);
    expect(folders.map((f) => f.id)).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('keeps only IPF.Note mail folders', () => {
    const mail = parseFolders(json).filter(isMailFolder);
    expect(mail.map((f) => f.displayName)).toEqual(['Inbox', 'Sent']);
  });

  it('returns [] on a malformed response', () => {
    expect(parseFolders({})).toEqual([]);
    expect(parseFolders(null)).toEqual([]);
  });
});

describe('buildFindItemBody', () => {
  it('targets a specific folder, paginates, sorts newest-first', () => {
    const b = body(buildFindItemBody('FID', 50, 100));
    expect(b.ParentFolderIds[0].__type).toBe('FolderId:#Exchange');
    expect(b.ParentFolderIds[0].Id).toBe('FID');
    expect(b.Paging.Offset).toBe(50);
    expect(b.Paging.MaxEntriesReturned).toBe(100);
    expect(b.SortOrder[0].Order).toBe('Descending');
  });

  it('clamps a negative offset and floors fractions', () => {
    const b = body(buildFindItemBody('FID', -3, 49.9));
    expect(b.Paging.Offset).toBe(0);
    expect(b.Paging.MaxEntriesReturned).toBe(49);
  });
});

describe('parseFindItem', () => {
  const json = {
    Body: {
      ResponseMessages: {
        Items: [
          {
            RootFolder: {
              TotalItemsInView: 2,
              IncludesLastItemInRange: true,
              Items: [
                { ItemId: { Id: 'M1' }, Subject: 'Hello', DateTimeReceived: '2026-06-01T10:00:00Z' },
                { ItemId: { Id: 'M2' }, Subject: 'World', DateTimeReceived: '2026-05-01T10:00:00Z' },
                { Subject: 'no-id-skipped' },
              ],
            },
          },
        ],
      },
    },
  };

  it('extracts item refs with epoch mtimes and paging flags', () => {
    const page = parseFindItem(json);
    expect(page.items.map((i) => i.id)).toEqual(['M1', 'M2']);
    expect(page.items[0].mtime).toBe(Date.parse('2026-06-01T10:00:00Z'));
    expect(page.total).toBe(2);
    expect(page.includesLast).toBe(true);
  });

  it('treats string IncludesLastItemInRange and missing fields gracefully', () => {
    const page = parseFindItem({
      Body: { ResponseMessages: { Items: [{ RootFolder: { Items: [], IncludesLastItemInRange: 'true' } }] } },
    });
    expect(page.items).toEqual([]);
    expect(page.includesLast).toBe(true);
  });
});

describe('buildGetItemBody', () => {
  it('requests plain-text bodies for a batch of ids', () => {
    const b = body(buildGetItemBody(['M1', 'M2']));
    expect(b.ItemShape.BodyType).toBe('Text');
    expect(b.ItemIds.map((x: { Id: string }) => x.Id)).toEqual(['M1', 'M2']);
    const props = b.ItemShape.AdditionalProperties.map((p: { FieldURI: string }) => p.FieldURI);
    expect(props).toEqual(expect.arrayContaining(['Subject', 'From', 'ToRecipients', 'Body']));
  });
});

describe('parseGetItem', () => {
  const json = {
    Body: {
      ResponseMessages: {
        Items: [
          {
            Items: [
              {
                ItemId: { Id: 'M1' },
                Subject: 'Quarterly budget',
                DateTimeReceived: '2026-06-01T10:00:00Z',
                From: { Mailbox: { Name: 'Alice', EmailAddress: 'alice@corp.com' } },
                ToRecipients: [{ Mailbox: { Name: 'Bob', EmailAddress: 'bob@corp.com' } }],
                Body: { BodyType: 'Text', Value: 'The budget exceeded projected costs.' },
              },
            ],
          },
          { Items: [{ Subject: 'no-id-skipped' }] },
        ],
      },
    },
  };

  it('flattens per-item response messages into messages', () => {
    const msgs = parseGetItem(json);
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.id).toBe('M1');
    expect(m.from).toBe('Alice <alice@corp.com>');
    expect(m.to).toBe('Bob <bob@corp.com>');
    expect(m.bodyText).toBe('The budget exceeded projected costs.');
    expect(m.mtime).toBe(Date.parse('2026-06-01T10:00:00Z'));
  });

  it('strips HTML if the server returned an HTML body despite BodyType:Text', () => {
    const msgs = parseGetItem({
      Body: {
        ResponseMessages: {
          Items: [{ Items: [{ ItemId: { Id: 'X' }, Body: { Value: '<p>Hi&nbsp;<b>there</b></p>' } }] }],
        },
      },
    });
    expect(msgs[0].bodyText).toBe('Hi there');
    expect(msgs[0].subject).toBe('(no subject)');
  });
});

describe('messageToMailDoc + messageUrl', () => {
  const m: OwaMessage = {
    id: 'ITEM/ID=with+chars',
    subject: 'Invoice AB-1234',
    from: 'Alice <alice@corp.com>',
    to: 'Bob <bob@corp.com>',
    received: '2026-06-01T10:00:00Z',
    mtime: Date.parse('2026-06-01T10:00:00Z'),
    bodyText: 'Please approve.',
  };

  it('builds an OWA deep-link with the encoded item id', () => {
    const url = messageUrl('https://outlook.office.com/', m.id);
    expect(url).toContain('ItemID=ITEM%2FID%3Dwith%2Bchars');
    expect(url).toContain('viewmodel=ReadMessageItem');
    expect(url).not.toContain('.com//'); // trailing slash trimmed
  });

  it('projects a header block + body into a RAG doc', () => {
    const doc = messageToMailDoc(m, 'https://outlook.office.com');
    expect(doc.id).toBe(m.id);
    expect(doc.mtime).toBe(m.mtime);
    expect(doc.text).toContain('From: Alice <alice@corp.com>');
    expect(doc.text).toContain('Subject: Invoice AB-1234');
    expect(doc.text.endsWith('Please approve.')).toBe(true);
  });
});
