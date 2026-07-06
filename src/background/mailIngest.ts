// =============================================================================
// Mailbox indexer — pages the user's Office 365 mailbox through their EXISTING
// Outlook-on-the-web session (cookie auth, no Graph/OAuth/Azure app) and feeds
// each message into the same RAG pipeline as folders: messageToMailDoc →
// storeText (chunk → on-device embed → OPFS, with the model lock). Walks every
// mail folder (FindFolder), pages message ids (FindItem), then fetches full
// plain-text bodies (GetItem, batched). Incremental on repeat via a high-water-
// mark on receivedDateTime; messages already indexed (by EWS ItemId) are skipped.
// Runs in the service worker (cross-origin cookie fetch allowed).
// =============================================================================

import type { RepoDoc } from '../shared/messages';
import { isMailFolder, messageToMailDoc, type OwaItemRef } from '../shared/owaMail';
import type { Settings } from '../shared/types';
import { GET_BATCH_SIZE, owaFindFolders, owaFindItemsPage, owaGetItems, readCanary } from './owaClient';
import { repoDocs } from './offscreenClient';
import { storeText } from './repoIngest';

export interface MailSyncProgress {
  phase: 'fetching' | 'indexing' | 'done';
  added: number;
  skipped: number;
  failed: number;
  /** Subject of the message currently being indexed, for a live status line. */
  current?: string;
}

/** The Outlook-on-the-web origin to ride: the setting, else the public default. */
export function resolveOutlookBase(settings: Settings): string {
  return (settings.outlookBaseUrl?.trim() || 'https://outlook.office.com').replace(/\/+$/, '');
}

/**
 * Bring `repo` into sync with the mailbox over the user's Outlook web session.
 * Throws `OwaSessionError` (from readCanary) if not signed in. Reports progress
 * as each message is embedded.
 */
export async function indexMailbox(
  settings: Settings,
  repo: string,
  onProgress?: (p: MailSyncProgress) => void,
): Promise<MailSyncProgress> {
  const base = resolveOutlookBase(settings);
  const prog: MailSyncProgress = { phase: 'fetching', added: 0, skipped: 0, failed: 0 };

  // Already-indexed message ids + high-water-mark (incremental refresh).
  const docsRes = await repoDocs(repo);
  const existing = docsRes.ok && Array.isArray(docsRes.result) ? (docsRes.result as RepoDoc[]) : [];
  const have = new Set(existing.map((d) => d.path).filter((p): p is string => Boolean(p)));
  let highWater = 0;
  for (const d of existing) if (d.mtime && d.mtime > highWater) highWater = d.mtime;

  const canary = await readCanary(base);

  // 1) Enumerate mail folders, then page each for new message ids (newest-first,
  //    so we can stop a folder early once we pass the high-water-mark).
  const folders = (await owaFindFolders(base, canary)).filter(isMailFolder);
  const newRefs: OwaItemRef[] = [];
  for (const folder of folders) {
    let offset = 0;
    for (;;) {
      const page = await owaFindItemsPage(base, canary, folder.id, offset);
      let reachedOld = false;
      for (const ref of page.items) {
        if (highWater && ref.mtime && ref.mtime <= highWater) {
          reachedOld = true; // older than last sync — and everything after is older too
          break;
        }
        if (!have.has(ref.id)) newRefs.push(ref);
      }
      onProgress?.({ ...prog });
      if (reachedOld || page.includesLast || page.items.length === 0) break;
      offset += page.items.length;
    }
  }

  // 2) Fetch full bodies in batches and store each message into the RAG repo.
  prog.phase = 'indexing';
  for (let i = 0; i < newRefs.length; i += GET_BATCH_SIZE) {
    const batch = newRefs.slice(i, i + GET_BATCH_SIZE).map((r) => r.id);
    const messages = await owaGetItems(base, canary, batch);
    for (const m of messages) {
      if (have.has(m.id)) {
        prog.skipped++;
        continue;
      }
      const doc = messageToMailDoc(m, base);
      onProgress?.({ ...prog, current: doc.subject });
      const r = await storeText(settings, repo, doc.subject, doc.url, doc.text, {
        kind: 'mail',
        docExtra: { path: doc.id, mtime: doc.mtime, size: doc.text.length },
      });
      if (r.ok) {
        prog.added++;
        have.add(doc.id);
      } else {
        prog.failed++;
      }
    }
    onProgress?.({ ...prog });
  }

  prog.phase = 'done';
  onProgress?.(prog);
  return prog;
}
