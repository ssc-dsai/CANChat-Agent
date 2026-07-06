// =============================================================================
// SharePoint / OneDrive indexer — enumerates files over the existing browser
// SharePoint session (cookie auth), fetches server bytes through the offscreen
// PDF/Office extractors, then stores text in the on-device RAG repository.
// =============================================================================

import type { RepoDoc } from '../shared/messages';
import { classifyUpload } from '../shared/uploadFile';
import type { Settings } from '../shared/types';
import { extractOffice, extractPdf, repoDeleteDoc, repoDocs } from './offscreenClient';
import { storeText } from './repoIngest';

export interface SharePointSyncProgress {
  phase: 'fetching' | 'indexing' | 'done';
  added: number;
  skipped: number;
  failed: number;
  current?: string;
}

interface SharePointFileRef {
  title: string;
  url: string;
  modified?: string;
  mtime?: number;
  size?: number;
}

const SUPPORTED_EXT = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'log']);
const PAGE_SIZE = 50;
const MAX_FILES = 1000;
const TEXT_MAX_CHARS = 5_000_000;

function cleanSummary(raw: string): string {
  return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function fileName(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || url);
  } catch {
    return url.split('/').pop() || url;
  }
}

function extOf(nameOrUrl: string): string {
  const name = fileName(nameOrUrl).split(/[?#]/)[0];
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function kqlSafe(s: string): string {
  return s.replace(/['"]/g, ' ').trim();
}

export function resolveSharePointBase(settings: Settings): string | undefined {
  return settings.sharepointBaseUrl?.trim().replace(/\/+$/, '') || undefined;
}

export function sharePointRepoName(libraryUrl: string): string {
  try {
    const u = new URL(libraryUrl);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    const clean = last.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    return `☁ SharePoint - ${clean || u.hostname}`;
  } catch {
    return '☁ SharePoint';
  }
}

export async function probeSharePointSession(base: string): Promise<{ connected: boolean; base: string; error?: string }> {
  const clean = base.replace(/\/+$/, '');
  try {
    const res = await fetch(`${clean}/_api/web/currentuser`, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
    return res.ok ? { connected: true, base: clean } : { connected: false, base: clean, error: `HTTP ${res.status}` };
  } catch (e) {
    return { connected: false, base: clean, error: String(e) };
  }
}

async function enumerateFiles(base: string, libraryUrl: string, onProgress?: (p: SharePointSyncProgress) => void): Promise<SharePointFileRef[]> {
  const files: SharePointFileRef[] = [];
  const queryText = `IsDocument:1 path:"${kqlSafe(libraryUrl).replace(/"/g, '')}"`;
  const props = 'Title,Path,FileExtension,LastModifiedTime,Size';
  for (let start = 0; files.length < MAX_FILES; start += PAGE_SIZE) {
    const url =
      `${base.replace(/\/+$/, '')}/_api/search/query` +
      `?querytext='${encodeURIComponent(queryText)}'` +
      `&rowlimit=${PAGE_SIZE}` +
      `&startrow=${start}` +
      `&selectproperties='${encodeURIComponent(props)}'` +
      `&trimduplicates=false` +
      `&clienttype='ContentSearchRegular'`;
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json;odata=nometadata' } });
    if (!res.ok) throw new Error(`SharePoint search failed (HTTP ${res.status}). Open ${base} and make sure you are signed in.`);
    const data = await res.json();
    const rows =
      (data as { PrimaryQueryResult?: { RelevantResults?: { Table?: { Rows?: Array<{ Cells?: Array<{ Key: string; Value: string }> }> } } } })
        ?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? [];
    for (const row of rows) {
      const c: Record<string, string> = {};
      for (const cell of row.Cells ?? []) c[cell.Key] = cell.Value;
      const fileUrl = c.Path;
      const ext = (c.FileExtension || extOf(fileUrl)).toLowerCase();
      if (!fileUrl || !SUPPORTED_EXT.has(ext)) continue;
      const mtime = c.LastModifiedTime ? Date.parse(c.LastModifiedTime) : undefined;
      files.push({
        title: cleanSummary(c.Title || fileName(fileUrl)),
        url: fileUrl,
        modified: c.LastModifiedTime || undefined,
        mtime: Number.isFinite(mtime) ? mtime : undefined,
        size: Number.isFinite(Number(c.Size)) ? Number(c.Size) : undefined,
      });
      if (files.length >= MAX_FILES) break;
    }
    onProgress?.({ phase: 'fetching', added: 0, skipped: 0, failed: 0, current: `${files.length} files found` });
    if (rows.length < PAGE_SIZE) break;
  }
  return files;
}

async function fetchTextFile(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Could not fetch text file (HTTP ${res.status}).`);
  const text = await res.text();
  return text.length > TEXT_MAX_CHARS ? text.slice(0, TEXT_MAX_CHARS).trim() : text.trim();
}

async function extractFile(ref: SharePointFileRef): Promise<string> {
  const kind = classifyUpload(ref.title) || classifyUpload(fileName(ref.url));
  if (kind === 'pdf') {
    const pdf = await extractPdf(ref.url);
    if (!pdf.ok || !pdf.text) throw new Error(pdf.error ?? 'Could not read the PDF.');
    return pdf.text.trim();
  }
  if (kind === 'office') {
    const office = await extractOffice(ref.url);
    if (!office.ok || !office.text) throw new Error(office.error ?? 'Could not read the document.');
    return office.text.trim();
  }
  if (kind === 'text') return fetchTextFile(ref.url);
  throw new Error('Unsupported file type.');
}

export async function indexSharePointLibrary(
  settings: Settings,
  repo: string,
  libraryUrl: string,
  onProgress?: (p: SharePointSyncProgress) => void,
): Promise<SharePointSyncProgress> {
  const base = resolveSharePointBase(settings) || new URL(libraryUrl).origin;
  const prog: SharePointSyncProgress = { phase: 'fetching', added: 0, skipped: 0, failed: 0 };
  const refs = await enumerateFiles(base, libraryUrl, onProgress);

  const docsRes = await repoDocs(repo);
  const existing = docsRes.ok && Array.isArray(docsRes.result) ? (docsRes.result as RepoDoc[]) : [];
  const byPath = new Map<string, RepoDoc>();
  for (const d of existing) if (d.path) byPath.set(d.path, d);

  prog.phase = 'indexing';
  for (const ref of refs) {
    const prior = byPath.get(ref.url);
    if (prior && ref.mtime !== undefined && ref.size !== undefined && prior.mtime === ref.mtime && prior.size === ref.size) {
      prog.skipped++;
      continue;
    }
    onProgress?.({ ...prog, current: ref.title });
    try {
      const text = await extractFile(ref);
      if (text.length < 1) throw new Error('No extractable text in the file.');
      if (prior) await repoDeleteDoc(repo, prior.id);
      const res = await storeText(settings, repo, ref.title || fileName(ref.url), ref.url, text, {
        kind: 'sharepoint',
        docExtra: { path: ref.url, mtime: ref.mtime, size: ref.size },
      });
      if (res.ok) prog.added++;
      else prog.failed++;
    } catch {
      prog.failed++;
    }
    onProgress?.({ ...prog });
  }

  prog.phase = 'done';
  onProgress?.(prog);
  return prog;
}
