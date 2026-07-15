// Durable "Products" store: named binary outputs (generated .pptx/.docx/etc.)
// produced by scheduled tasks and event triggers, kept in OPFS so they survive
// past the run that made them and can be browsed/downloaded later from the
// Workspace Products page — rather than only ever a click-to-download card in
// a sidebar that may not be open when an unattended run finishes. Runs in the
// offscreen document (Window context), same as repoStore.ts, for the async
// OPFS API.

export interface ProductMeta {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: string; // ISO
  sizeBytes: number;
  /** The scheduled task / trigger name that produced this file, if any. */
  sourceTitle?: string;
  /** The conversation whose transcript this run landed in, for tracing back context. */
  conversationId?: string;
}

async function productsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('products', { create: true });
}

async function productDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  return (await productsDir()).getDirectoryHandle(id, { create });
}

async function writeJson(dir: FileSystemDirectoryHandle, file: string, obj: unknown): Promise<void> {
  const handle = await dir.getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

async function readJson<T>(dir: FileSystemDirectoryHandle, file: string): Promise<T | null> {
  try {
    const handle = await dir.getFileHandle(file);
    return JSON.parse(await (await handle.getFile()).text()) as T;
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** String.fromCharCode(...bytes) in chunks — avoids call-stack limits on large files. */
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export async function productSave(
  filename: string,
  mimeType: string,
  dataBase64: string,
  opts: { sourceTitle?: string; conversationId?: string } = {},
): Promise<ProductMeta> {
  const bytes = base64ToBytes(dataBase64);
  const meta: ProductMeta = {
    id: crypto.randomUUID(),
    filename,
    mimeType,
    createdAt: new Date().toISOString(),
    sizeBytes: bytes.byteLength,
    sourceTitle: opts.sourceTitle,
    conversationId: opts.conversationId,
  };
  const dir = await productDir(meta.id, true);
  await writeJson(dir, 'meta.json', meta);
  const blobHandle = await dir.getFileHandle('blob', { create: true });
  const w = await blobHandle.createWritable();
  await w.write(bytes as unknown as BufferSource);
  await w.close();
  return meta;
}

export async function productList(): Promise<ProductMeta[]> {
  const dir = await productsDir();
  const out: ProductMeta[] = [];
  // @ts-expect-error - entries() exists on FileSystemDirectoryHandle in Chrome
  for await (const [, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    const meta = await readJson<ProductMeta>(handle as FileSystemDirectoryHandle, 'meta.json');
    if (meta) out.push(meta);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function productGet(id: string): Promise<{ meta: ProductMeta; dataBase64: string } | null> {
  try {
    const dir = await productDir(id, false);
    const meta = await readJson<ProductMeta>(dir, 'meta.json');
    if (!meta) return null;
    const blobHandle = await dir.getFileHandle('blob');
    const bytes = new Uint8Array(await (await blobHandle.getFile()).arrayBuffer());
    return { meta, dataBase64: bytesToBase64(bytes) };
  } catch {
    return null;
  }
}

export async function productDelete(id: string): Promise<boolean> {
  try {
    const dir = await productsDir();
    await dir.removeEntry(id, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
