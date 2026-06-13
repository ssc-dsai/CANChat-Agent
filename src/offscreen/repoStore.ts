// On-device RAG store: named repositories in OPFS holding chunk text + int8-
// quantized embedding vectors. Runs in the offscreen document (Window context),
// so it uses the async OPFS API (no sync access handles, which are Worker-only).

const QUANT = 127;

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

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function quantize(v: number[], scale: number[]): Int8Array {
  const out = new Int8Array(v.length);
  for (let d = 0; d < v.length; d++) {
    const s = scale[d] || 1;
    out[d] = Math.max(-QUANT, Math.min(QUANT, Math.round((v[d] / s) * QUANT)));
  }
  return out;
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
  const normed = vectors.map(normalize);
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
  normed.forEach((v, i) => packed.set(quantize(v, meta.perDimScale), i * meta.dim));
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
): Promise<{ results: Array<{ text: string; name: string; url: string; score: number }> }> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta || meta.chunkCount === 0) return { results: [] };
  if (queryVector.length !== meta.dim) {
    throw new Error(`Query embedding dimension ${queryVector.length} does not match repo dimension ${meta.dim}.`);
  }
  const q = quantize(normalize(queryVector), meta.perDimScale);
  const dim = meta.dim;
  // Fold the query-constant factors (q[d] and the per-dim scale²) into one
  // weight vector so the hot per-vector loop is a single multiply-add.
  const qw = new Float32Array(dim);
  for (let d = 0; d < dim; d++) qw[d] = q[d] * meta.perDimScale[d] * meta.perDimScale[d];
  const vecs = await readVectors(dir);
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const top: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const base = i * dim;
    let score = 0;
    for (let d = 0; d < dim; d++) score += vecs[base + d] * qw[d];
    if (top.length < k) {
      top.push({ i, score });
      if (top.length === k) top.sort((a, b) => a.score - b.score);
    } else if (score > top[0].score) {
      top[0] = { i, score };
      top.sort((a, b) => a.score - b.score);
    }
  }
  top.sort((a, b) => b.score - a.score);
  return {
    results: top
      .map(({ i, score }) => {
        const c = chunks[i];
        return c ? { text: c.text, name: c.name, url: c.url, score } : null;
      })
      .filter((r): r is { text: string; name: string; url: string; score: number } => r !== null),
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
