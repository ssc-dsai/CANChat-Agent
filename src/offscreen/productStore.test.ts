import { beforeEach, describe, expect, it, vi } from 'vitest';
import { productDelete, productExportAll, productGet, productImportAll, productList, productSave } from './productStore';

// ---- minimal in-memory OPFS fake (only the surface productStore uses) ----

class FakeWritable {
  constructor(private file: FakeFileHandle) {
    file.bytes = new Uint8Array(0);
  }
  async write(input: string | BufferSource): Promise<void> {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input as ArrayBuffer);
    this.file.bytes = data;
  }
  async close(): Promise<void> {}
}

class FakeFileHandle {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async getFile() {
    const bytes = this.bytes;
    return {
      size: bytes.length,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this);
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new Error('NotFound');
      d = new FakeDirHandle(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new Error('NotFound');
      f = new FakeFileHandle(name);
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string) {
    this.dirs.delete(name);
    this.files.delete(name);
  }
  async *entries(): AsyncGenerator<[string, FakeDirHandle | FakeFileHandle]> {
    for (const [n, d] of this.dirs) yield [n, d];
    for (const [n, f] of this.files) yield [n, f];
  }
}

beforeEach(() => {
  const root = new FakeDirHandle('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
});

describe('productStore backup / restore', () => {
  it('round-trips products through export/import, preserving id, meta, and bytes', async () => {
    const dataBase64 = btoa('hello product');
    const saved = await productSave('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64, {
      sourceTitle: 'Weekly report',
      conversationId: 'conv-1',
    });

    const exported = await productExportAll();
    expect(exported).toHaveLength(1);
    expect(exported[0].meta).toEqual(saved);
    expect(exported[0].dataB64).toBe(dataBase64);

    await productDelete(saved.id);
    expect(await productList()).toEqual([]);

    const { imported } = await productImportAll(exported);
    expect(imported).toBe(1);

    const restored = await productGet(saved.id);
    expect(restored?.meta).toEqual(saved);
    expect(restored?.dataBase64).toBe(dataBase64);
  });

  it('overwrites an existing product with the same id on import', async () => {
    const saved = await productSave('a.txt', 'text/plain', btoa('first'));
    await productImportAll([{ meta: saved, dataB64: btoa('second') }]);
    const restored = await productGet(saved.id);
    expect(restored?.dataBase64).toBe(btoa('second'));
    expect(await productList()).toHaveLength(1);
  });
});
