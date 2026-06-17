// On-device RAG store: named repositories in OPFS holding chunk text + int8-
// quantized embedding vectors. Runs in the offscreen document (Window context),
// so it uses the async OPFS API (no sync access handles, which are Worker-only).

import type { ExportedRepo } from '../shared/messages';
import { normalizeVector, quantizeVector, searchVectors, type SearchHit } from '../shared/vectorSearch';

interface DocMeta {
  id: string;
  name: string;
  url: string;
  capturedAt: string;
  chunkStart: number;
  chunkCount: number;
}

interface RepoMeta {
  name: string;
  dim: number;
  bits: number;
  perDimScale: number[]; // calibration, fixed from the first batch
  docs: DocMeta[];
  chunkCount: number;
}

interface ChunkRec {
  docId: string;
  name: string;
  url: string;
  text: string;
}

async function reposDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('repos', { create: true });
}

async function repoDir(name: string): Promise<FileSystemDirectoryHandle> {
  return (await reposDir()).getDirectoryHandle(name, { create: true });
}

async function readJson<T>(dir: FileSystemDirectoryHandle, file: string, fallback: T): Promise<T> {
  try {
    const handle = await dir.getFileHandle(file);
    const text = await (await handle.getFile()).text();
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(dir: FileSystemDirectoryHandle, file: string, obj: unknown): Promise<void> {
  const handle = await dir.getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

async function readVectors(dir: FileSystemDirectoryHandle): Promise<Int8Array> {
  try {
    const handle = await dir.getFileHandle('vectors.bin');
    return new Int8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return new Int8Array(0);
  }
}

async function appendVectors(dir: FileSystemDirectoryHandle, data: Int8Array): Promise<void> {
  const handle = await dir.getFileHandle('vectors.bin', { create: true });
  const existing = (await handle.getFile()).size;
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: existing, data: data as unknown as BufferSource });
  await w.close();
}

/** Overwrite vectors.bin wholesale (truncates) — used when rebuilding after a delete. */
async function writeVectors(dir: FileSystemDirectoryHandle, data: Int8Array): Promise<void> {
  const handle = await dir.getFileHandle('vectors.bin', { create: true });
  const w = await handle.createWritable(); // no keepExistingData → truncates to 0 first
  await w.write({ type: 'write', position: 0, data: data as unknown as BufferSource });
  await w.close();
}

export async function repoAdd(
  repo: string,
  doc: { name: string; url: string },
  chunks: string[],
  vectors: number[][],
): Promise<{ docId: string; chunkCount: number }> {
  if (chunks.length === 0 || vectors.length !== chunks.length) {
    throw new Error('repoAdd: chunk/vector count mismatch.');
  }
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta>(dir, 'meta.json', {
    name: repo,
    dim: 0,
    bits: 8,
    perDimScale: [],
    docs: [],
    chunkCount: 0,
  });
  const normed = vectors.map(normalizeVector);
  if (meta.dim === 0) {
    meta.dim = normed[0].length;
    const scale = new Array(meta.dim).fill(0);
    for (const v of normed) for (let d = 0; d < meta.dim; d++) scale[d] = Math.max(scale[d], Math.abs(v[d]));
    meta.perDimScale = scale.map((s) => s || 1);
  }
  if (normed[0].length !== meta.dim) {
    throw new Error(`Embedding dimension ${normed[0].length} does not match repo dimension ${meta.dim}.`);
  }

  const packed = new Int8Array(normed.length * meta.dim);
  normed.forEach((v, i) => packed.set(quantizeVector(v, meta.perDimScale), i * meta.dim));
  await appendVectors(dir, packed);

  const allChunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  for (const text of chunks) allChunks.push({ docId, name: doc.name, url: doc.url, text });
  await writeJson(dir, 'chunks.json', allChunks);

  meta.docs.push({
    id: docId,
    name: doc.name,
    url: doc.url,
    capturedAt: new Date().toISOString(),
    chunkStart: meta.chunkCount,
    chunkCount: chunks.length,
  });
  meta.chunkCount += chunks.length;
  await writeJson(dir, 'meta.json', meta);
  return { docId, chunkCount: meta.chunkCount };
}

export async function repoSearch(
  repo: string,
  queryVector: number[],
  k: number,
): Promise<{ results: SearchHit[] }> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta || meta.chunkCount === 0) return { results: [] };
  const vectors = await readVectors(dir);
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  return {
    results: searchVectors({
      dim: meta.dim,
      perDimScale: meta.perDimScale,
      chunkCount: meta.chunkCount,
      vectors,
      chunks,
      queryVector,
      k,
    }),
  };
}

export async function repoList(): Promise<Array<{ name: string; docs: number; chunks: number }>> {
  const out: Array<{ name: string; docs: number; chunks: number }> = [];
  const dir = await reposDir();
  // @ts-expect-error - entries() exists on FileSystemDirectoryHandle in Chrome
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    const meta = await readJson<RepoMeta | null>(handle as FileSystemDirectoryHandle, 'meta.json', null);
    out.push({ name, docs: meta?.docs.length ?? 0, chunks: meta?.chunkCount ?? 0 });
  }
  return out;
}

export async function repoDelete(repo: string): Promise<void> {
  const dir = await reposDir();
  await dir.removeEntry(repo, { recursive: true });
}

// ----- backup / restore -----

function u8ToB64(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large vectors
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Serialize every repository (meta + chunks + base64 vectors) for backup. */
export async function repoExportAll(): Promise<ExportedRepo[]> {
  const out: ExportedRepo[] = [];
  const dir = await reposDir();
  // @ts-expect-error - entries() exists on FileSystemDirectoryHandle in Chrome
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    const d = handle as FileSystemDirectoryHandle;
    const meta = await readJson<RepoMeta | null>(d, 'meta.json', null);
    if (!meta) continue;
    const chunks = await readJson<ChunkRec[]>(d, 'chunks.json', []);
    const vecs = await readVectors(d);
    const bytes = new Uint8Array(vecs.buffer, vecs.byteOffset, vecs.byteLength);
    out.push({ name, meta, chunks, vectorsB64: u8ToB64(bytes) });
  }
  return out;
}

/** Restore repositories from a backup, overwriting any with the same name. */
export async function repoImportAll(repos: ExportedRepo[]): Promise<{ imported: number }> {
  const root = await reposDir();
  let imported = 0;
  for (const r of repos) {
    if (!r?.name) continue;
    try {
      await root.removeEntry(r.name, { recursive: true });
    } catch {
      // no existing repo by that name
    }
    const d = await root.getDirectoryHandle(r.name, { create: true });
    await writeJson(d, 'meta.json', r.meta);
    await writeJson(d, 'chunks.json', Array.isArray(r.chunks) ? r.chunks : []);
    const u8 = b64ToU8(r.vectorsB64 ?? '');
    await writeVectors(d, new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength));
    imported++;
  }
  return { imported };
}

/** List the documents in a repo (for duplicate detection and the Settings UI). */
export async function repoDocs(repo: string): Promise<DocMeta[]> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  return meta?.docs ?? [];
}

/** Remove one document from a repo, rebuilding vectors.bin + chunks.json + meta. */
export async function repoDeleteDoc(repo: string, docId: string): Promise<{ removed: number; chunkCount: number }> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) return { removed: 0, chunkCount: 0 };
  const doc = meta.docs.find((d) => d.id === docId);
  if (!doc) return { removed: 0, chunkCount: meta.chunkCount };

  const dim = meta.dim;
  const start = doc.chunkStart;
  const end = doc.chunkStart + doc.chunkCount;

  // Rebuild vectors.bin: drop the doc's contiguous [start,end) rows of `dim` bytes.
  const vecs = await readVectors(dir);
  const kept = new Int8Array((meta.chunkCount - doc.chunkCount) * dim);
  kept.set(vecs.subarray(0, start * dim), 0);
  kept.set(vecs.subarray(end * dim, meta.chunkCount * dim), start * dim);
  await writeVectors(dir, kept);

  // Rebuild chunks.json by index.
  const allChunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  allChunks.splice(start, doc.chunkCount);
  await writeJson(dir, 'chunks.json', allChunks);

  // Drop the doc and re-sequence every remaining doc's chunkStart.
  meta.docs = meta.docs.filter((d) => d.id !== docId);
  let cursor = 0;
  for (const d of meta.docs) {
    d.chunkStart = cursor;
    cursor += d.chunkCount;
  }
  meta.chunkCount = cursor;
  // Emptied repo: reset calibration so a later add can recalibrate (e.g. new model).
  if (meta.chunkCount === 0) {
    meta.dim = 0;
    meta.perDimScale = [];
  }
  await writeJson(dir, 'meta.json', meta);
  return { removed: doc.chunkCount, chunkCount: meta.chunkCount };
}
