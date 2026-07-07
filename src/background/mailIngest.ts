// =============================================================================
// Mailbox indexer — pages the user's Office 365 mailbox via Microsoft Graph and
// feeds each message into the same RAG pipeline as folders: messageToDoc →
// storeText (chunk → on-device embed → OPFS, with the model lock). Incremental
// on repeat via a high-water-mark on receivedDateTime; messages already indexed
// (by Graph id) are skipped. Runs in the service worker (cross-origin fetch
// allowed). Requires the mailbox to be connected (graphAuth.connectMailbox) —
// callers should connect before calling indexMailbox.
// =============================================================================

import { buildMessagesUrl, messageToDoc, type GraphMessagePage } from '../shared/graphMail';
import type { RepoDoc } from '../shared/messages';
import type { Settings } from '../shared/types';
import { getAccessToken } from './graphAuth';
import { graphGet } from './graphClient';
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

/**
 * Bring `repo` into sync with the mailbox via Microsoft Graph. Throws if the
 * mailbox isn't connected (or the connection has expired past refresh).
 * Reports progress as each message is embedded.
 */
export async function indexMailbox(
  settings: Settings,
  repo: string,
  onProgress?: (p: MailSyncProgress) => void,
): Promise<MailSyncProgress> {
  const clientId = settings.graphClientId ?? '';
  const tenant = settings.graphTenant || 'organizations';
  const prog: MailSyncProgress = { phase: 'fetching', added: 0, skipped: 0, failed: 0 };

  // Already-indexed message ids + high-water-mark (incremental refresh).
  const docsRes = await repoDocs(repo);
  const existing = docsRes.ok && Array.isArray(docsRes.result) ? (docsRes.result as RepoDoc[]) : [];
  const have = new Set(existing.map((d) => d.path).filter((p): p is string => Boolean(p)));
  let highWater = 0;
  for (const d of existing) if (d.mtime && d.mtime > highWater) highWater = d.mtime;
  const since = highWater ? new Date(highWater).toISOString() : undefined;

  const token = await getAccessToken(clientId, tenant);
  let url: string | undefined = buildMessagesUrl({ since });
  prog.phase = 'indexing';
  while (url) {
    const page: GraphMessagePage = await graphGet<GraphMessagePage>(url, token);
    for (const m of page.value ?? []) {
      const doc = messageToDoc(m);
      if (have.has(doc.id)) {
        prog.skipped++;
        continue;
      }
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
    url = page['@odata.nextLink'];
  }

  prog.phase = 'done';
  onProgress?.(prog);
  return prog;
}
