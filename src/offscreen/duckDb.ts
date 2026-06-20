import { unzipSync } from 'fflate';
import type { DuckDbResponse, DuckDbTableInfo } from '../shared/messages';
import { ARCHIVE_MEMBER_EXT, extOf, tableNameFromFile, uniqueTableName } from '../shared/dataFile';

// Bundle DuckDB-WASM's worker + wasm locally and serve them from the extension
// origin. The default jsDelivr bundles load a cross-origin Worker, which the MV3
// content-security-policy (`script-src 'self'`) forbids — so the engine never
// started. Vite emits these `?url` imports as same-origin assets in dist/assets.
// (Compilation also needs `'wasm-unsafe-eval'` in the manifest CSP.)
import type { DuckDBBundles } from '@duckdb/duckdb-wasm';
import mvpWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import mvpWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';

let db: any = null;
let conn: any = null;
let connecting: Promise<any> | null = null;
let restored = false;

interface PersistedMeta {
  columns: string[];
  columnTypes: string[];
  rowCount: number;
}

async function datasetsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('datasets', { create: true });
}

async function datasetDir(name: string): Promise<FileSystemDirectoryHandle> {
  return (await datasetsDir()).getDirectoryHandle(name, { create: true });
}

async function persistMeta(dir: FileSystemDirectoryHandle, meta: PersistedMeta): Promise<void> {
  const handle = await dir.getFileHandle('meta.json', { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(meta));
  await w.close();
}

async function readMeta(dir: FileSystemDirectoryHandle): Promise<PersistedMeta | null> {
  try {
    const handle = await dir.getFileHandle('meta.json');
    return JSON.parse(await (await handle.getFile()).text()) as PersistedMeta;
  } catch {
    return null;
  }
}

/** Save row data (string[][] only — discards nullability). */
async function persistData(dir: FileSystemDirectoryHandle, rows: string[][]): Promise<void> {
  const handle = await dir.getFileHandle('data.json', { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(rows));
  await w.close();
}

async function readData(dir: FileSystemDirectoryHandle): Promise<string[][]> {
  try {
    const handle = await dir.getFileHandle('data.json');
    return JSON.parse(await (await handle.getFile()).text()) as string[][];
  } catch {
    return [];
  }
}

async function listPersisted(): Promise<string[]> {
  const out: string[] = [];
  try {
    const dir = await datasetsDir();
    for await (const [name, handle] of (dir as any).entries()) {
      if (handle.kind === 'directory') out.push(name);
    }
  } catch {
    // no datasets dir yet
  }
  return out;
}

function rowsFromArrow(table: any): string[][] {
  const cols = table.schema.fields.map((f: any) => f.name);
  const out: string[][] = [];
  const data = table.toArray();
  for (const row of data) {
    const r: string[] = cols.map((c: string) => {
      const v = row[c];
      return v === null || v === undefined ? '' : String(v);
    });
    out.push(r);
  }
  return out;
}

function columnsFromArrow(table: any): string[] {
  return table.schema.fields.map((f: any) => f.name);
}

function columnTypesFromArrow(table: any): string[] {
  return table.schema.fields.map((f: any) => f.type.toString());
}

async function ensureDb(): Promise<any> {
  if (conn) return conn;
  // Single-flight: concurrent callers on a cold engine (e.g. the workspace's
  // mount list_tables racing an open) must share one instantiation, or they
  // spawn rival workers and deadlock.
  if (!connecting) {
    connecting = (async () => {
      const duckdb = await import('@duckdb/duckdb-wasm');
      // Local, same-origin bundles (no CDN) so the Worker passes the extension CSP.
      // selectBundle picks `eh` when WebAssembly exceptions are supported, else `mvp`;
      // neither needs cross-origin isolation / SharedArrayBuffer.
      const MANUAL_BUNDLES: DuckDBBundles = {
        mvp: { mainModule: mvpWasmUrl, mainWorker: mvpWorkerUrl },
        eh: { mainModule: ehWasmUrl, mainWorker: ehWorkerUrl },
      };
      const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
      const worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.ConsoleLogger();
      db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await db.open({ path: ':memory:', allowUnsignedExtensions: true });
      conn = await db.connect();
      // Point INSTALL/LOAD at the vendored extensions packaged with this build, so
      // the spatial extension loads fully offline. DuckDB appends
      // `/<engineVersion>/<platform>/<name>.duckdb_extension.wasm` to this base —
      // mirrored under public/duckdb-ext/. (The `INSTALL … FROM <base>` form hits a
      // different, broken code path over `chrome-extension://`; the repository
      // setting is the one that works.)
      try {
        const base = chrome.runtime.getURL('duckdb-ext').replace(/\/+$/, '');
        await conn.query(`SET custom_extension_repository='${base}'`);
      } catch {
        // No chrome.runtime (e.g. tests) — extensions just won't be available.
      }
      await restorePersisted();
      return conn;
    })().catch((e) => {
      connecting = null; // allow a retry after a failed cold start
      throw e;
    });
  }
  return connecting;
}

async function restorePersisted(): Promise<void> {
  if (restored) return;
  restored = true;
  const names = await listPersisted();
  for (const name of names) {
    try {
      const dir = await datasetDir(name);
      const meta = await readMeta(dir);
      if (!meta) continue;
      const data = await readData(dir);
      if (data.length === 0) continue;
      const c = conn;
      await c.query(`DROP TABLE IF EXISTS "${name}"`);
      const sample = data[0].map((_, i) => `col${i} VARCHAR`);
      await c.query(`CREATE TABLE "${name}" (${sample.join(', ')})`);
      if (data.length > 0) {
        for (let i = 0; i < data.length; i += 1000) {
          const batch = data.slice(i, i + 1000);
          const vals = batch.map((r) => `(${r.map((v) => (v === '' ? 'NULL' : `'${v.replace(/'/g, "''")}'`)).join(', ')})`).join(', ');
          await c.query(`INSERT INTO "${name}" VALUES ${vals}`);
        }
      }
    } catch {
      // skip tables that fail to restore
    }
  }
}

/** Dump all rows from a DuckDB table as a string[][] (for persistence). */
async function dumpTable(tableName: string): Promise<{ rows: string[][]; columns: string[]; columnTypes: string[] } | null> {
  try {
    const c = await ensureDb();
    const result = await c.query(`SELECT * FROM "${tableName}"`);
    return { rows: rowsFromArrow(result), columns: columnsFromArrow(result), columnTypes: columnTypesFromArrow(result) };
  } catch {
    return null;
  }
}

async function toResponse(table: any): Promise<DuckDbResponse> {
  return {
    ok: true,
    columns: columnsFromArrow(table),
    columnTypes: columnTypesFromArrow(table),
    rows: rowsFromArrow(table),
    rowCount: table.numRows,
  };
}

export async function query(sql: string): Promise<DuckDbResponse> {
  try {
    const c = await ensureDb();
    const result = await c.query(sql);
    return toResponse(result);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function persistTable(tableName: string): Promise<void> {
  const dump = await dumpTable(tableName);
  if (!dump) return;
  const dir = await datasetDir(tableName);
  await persistMeta(dir, { columns: dump.columns, columnTypes: dump.columnTypes, rowCount: dump.rows.length });
  await persistData(dir, dump.rows);
}

export async function importCsv(tableName: string, csv: string, persist?: boolean): Promise<DuckDbResponse> {
  try {
    await ensureDb();
    const tmpFile = `_import_${tableName}_${Date.now()}.csv`;
    await db.registerFileText(tmpFile, csv);
    const c = conn;
    await c.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await c.query(`CREATE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${tmpFile}')`);
    await db.dropFile(tmpFile);
    if (persist !== false) await persistTable(tableName);
    return { ok: true, rowCount: 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function importJson(tableName: string, json: string, persist?: boolean): Promise<DuckDbResponse> {
  try {
    await ensureDb();
    const tmpFile = `_import_${tableName}_${Date.now()}.json`;
    await db.registerFileText(tmpFile, json);
    const c = conn;
    await c.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await c.query(`CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${tmpFile}')`);
    await db.dropFile(tmpFile);
    if (persist !== false) await persistTable(tableName);
    return { ok: true, rowCount: 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Per-format DuckDB table-function used to read a registered file buffer.
const FORMAT_READER: Record<string, string> = {
  csv: 'read_csv_auto',
  tsv: 'read_csv_auto',
  json: 'read_json_auto',
  ndjson: 'read_json_auto',
  parquet: 'read_parquet',
};

// Single-file geospatial formats read via the locally-bundled spatial extension.
const SPATIAL_EXT = ['geojson', 'kml', 'gpx', 'fgb']; // spatial: ST_Read

// Single-flight INSTALL+LOAD per extension, by name, against the offline
// repository configured in ensureDb (SET custom_extension_repository). The
// vendored binaries must match the engine version — re-vendor on a duckdb-wasm
// bump (see public/duckdb-ext/README.md).
const extLoads: Record<string, Promise<void>> = {};
function ensureExtension(name: 'spatial'): Promise<void> {
  if (!extLoads[name]) {
    extLoads[name] = (async () => {
      const c = await ensureDb();
      await c.query(`INSTALL ${name}`);
      await c.query(`LOAD ${name}`);
    })().catch((e) => {
      delete extLoads[name]; // allow a retry after a failed load
      throw e;
    });
  }
  return extLoads[name];
}

/** Is this file extension openable (core formats + extension-backed spatial)? */
export function isOpenableExt(ext: string): boolean {
  return !!FORMAT_READER[ext] || SPATIAL_EXT.includes(ext);
}

/**
 * Build the `SELECT …` that reads a registered file into a table, loading the
 * backing extension on demand. Spatial reads convert the geometry column to
 * GeoJSON text (`fallback` covers files whose geometry column isn't named `geom`)
 * so the all-VARCHAR persistence layer round-trips cleanly.
 */
async function readerSelect(ext: string, tmp: string): Promise<{ select: string; fallback?: string }> {
  if (FORMAT_READER[ext]) {
    const opts = ext === 'tsv' ? ", delim='\t'" : '';
    return { select: `SELECT * FROM ${FORMAT_READER[ext]}('${tmp}'${opts})` };
  }
  if (SPATIAL_EXT.includes(ext)) {
    await ensureExtension('spatial');
    return {
      select: `SELECT * EXCLUDE (geom), ST_AsGeoJSON(geom) AS geometry FROM ST_Read('${tmp}')`,
      fallback: `SELECT * FROM ST_Read('${tmp}')`,
    };
  }
  throw new Error(`Unsupported data file extension: .${ext}`);
}

/** Names of every table currently in the engine (in-memory + persisted on disk). */
async function existingTableNames(): Promise<Set<string>> {
  const c = await ensureDb();
  const result = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='main'");
  const names = new Set<string>(result.toArray().map((row: any) => String(row.table_name ?? '')));
  for (const n of await listPersisted()) names.add(n);
  return names;
}

/** Build schema + row-count info for a freshly created table. */
async function tableInfo(name: string): Promise<DuckDbTableInfo> {
  const c = await ensureDb();
  const descRows = rowsFromArrow(await c.query(`DESCRIBE "${name}"`));
  const cnt = await c.query(`SELECT COUNT(*) AS n FROM "${name}"`);
  return {
    name,
    columns: descRows.map((r) => r[0]),
    columnTypes: descRows.map((r) => r[1]),
    rowCount: Number(cnt.toArray()[0]?.n ?? 0),
    persisted: true,
  };
}

/** Load one registered buffer (a single tabular file) into a new table. */
async function loadOne(name: string, bytes: Uint8Array, used: Set<string>): Promise<DuckDbTableInfo> {
  const ext = extOf(name);
  if (!isOpenableExt(ext)) throw new Error(`Unsupported data file: ${name}`);
  const c = await ensureDb();
  const table = uniqueTableName(tableNameFromFile(name), used);
  used.add(table);
  // Keep the real extension on the temp name so GDAL (spatial) can pick a driver.
  const tmp = `_open_${table}_${Date.now()}.${ext}`;
  await db.registerFileBuffer(tmp, bytes);
  try {
    await c.query(`DROP TABLE IF EXISTS "${table}"`);
    const spec = await readerSelect(ext, tmp);
    try {
      await c.query(`CREATE TABLE "${table}" AS ${spec.select}`);
    } catch (e) {
      if (!spec.fallback) throw e;
      await c.query(`CREATE TABLE "${table}" AS ${spec.fallback}`);
    }
  } finally {
    await db.dropFile(tmp);
  }
  await persistTable(table);
  return tableInfo(table);
}

/** Recurse into the entries, handling zip members and single files alike. */
async function openInto(name: string, bytes: Uint8Array, used: Set<string>): Promise<DuckDbTableInfo[]> {
  if (extOf(name) === 'zip') {
    const out: DuckDbTableInfo[] = [];
    const entries = unzipSync(bytes);
    for (const [member, data] of Object.entries(entries)) {
      if (member.endsWith('/') || member.startsWith('__MACOSX')) continue;
      if (!ARCHIVE_MEMBER_EXT.includes(extOf(member))) continue;
      out.push(...(await openInto(member, data, used)));
    }
    return out;
  }
  return [await loadOne(name, bytes, used)];
}

/**
 * Open a data file (CSV/TSV/JSON/NDJSON/Parquet, geospatial GeoJSON/KML/GPX/FGB,
 * or a ZIP of those) from its raw bytes into one or more persisted tables; returns
 * info for each created table. Geospatial formats are read through the
 * locally-bundled spatial extension.
 */
export async function openBuffer(name: string, bytes: Uint8Array): Promise<DuckDbTableInfo[]> {
  await ensureDb();
  const used = await existingTableNames();
  const tables = await openInto(name, bytes, used);
  if (tables.length === 0) {
    throw new Error(
      `No supported data files found in ${name}. The data engine opens CSV, TSV, JSON, NDJSON, Parquet, ` +
        `and geospatial GeoJSON/KML/GPX/FGB (and ZIPs of those); XML and SQLite/database files are not supported.`,
    );
  }
  return tables;
}

export async function listTables(): Promise<DuckDbResponse> {
  try {
    const c = await ensureDb();
    const result = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='main'");
    const inMemory = new Set(result.toArray().map((row: any) => row.table_name ?? ''));
    const persisted = await listPersisted();
    const names = [...new Set([...inMemory, ...persisted])] as string[];
    const tables: DuckDbTableInfo[] = [];
    for (const nm of names) {
      const p = persisted.includes(nm);
      try {
        const desc = await c.query(`SELECT COUNT(*) as cnt FROM "${nm}"`);
        const cnt = Number(desc.toArray()[0].cnt ?? 0);
        const colResult = await c.query(`DESCRIBE "${nm}"`);
        tables.push({
          name: nm,
          columns: columnsFromArrow(colResult),
          columnTypes: columnTypesFromArrow(colResult),
          rowCount: cnt,
          persisted: p || undefined,
        });
      } catch {
        tables.push({ name: nm, columns: [], columnTypes: [], rowCount: 0, persisted: true });
      }
    }
    return { ok: true, tables };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function describeTable(tableName: string): Promise<DuckDbResponse> {
  try {
    const c = await ensureDb();
    const result = await c.query(`DESCRIBE "${tableName}"`);
    const cols = columnsFromArrow(result);
    const types = columnTypesFromArrow(result);
    const rows = rowsFromArrow(result);
    const count = await c.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
    const rowCount = Number(count.toArray()[0].cnt ?? 0);
    return {
      ok: true,
      columns: cols,
      columnTypes: types,
      rows,
      rowCount,
      tables: [{ name: tableName, columns: rows.map((r) => r[0]), columnTypes: rows.map((r) => r[1]), rowCount }],
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function persistTableByName(tableName: string): Promise<DuckDbResponse> {
  try {
    await ensureDb();
    const dump = await dumpTable(tableName);
    if (!dump) return { ok: false, error: `Table "${tableName}" not found.` };
    const dir = await datasetDir(tableName);
    await persistMeta(dir, { columns: dump.columns, columnTypes: dump.columnTypes, rowCount: dump.rows.length });
    await persistData(dir, dump.rows);
    return { ok: true, rowCount: dump.rows.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function loadTable(tableName: string): Promise<DuckDbResponse> {
  try {
    const c = await ensureDb();
    const dir = await datasetDir(tableName);
    const meta = await readMeta(dir);
    if (!meta) return { ok: false, error: `No persisted dataset named "${tableName}".` };
    const data = await readData(dir);
    if (data.length === 0) return { ok: false, error: `Persisted dataset "${tableName}" has no data.` };
    await c.query(`DROP TABLE IF EXISTS "${tableName}"`);
    const sample = data[0].map((_, i) => `col${i} VARCHAR`);
    await c.query(`CREATE TABLE "${tableName}" (${sample.join(', ')})`);
    for (let i = 0; i < data.length; i += 1000) {
      const batch = data.slice(i, i + 1000);
      const vals = batch.map((r) => `(${r.map((v) => (v === '' ? 'NULL' : `'${v.replace(/'/g, "''")}'`)).join(', ')})`).join(', ');
      await c.query(`INSERT INTO "${tableName}" VALUES ${vals}`);
    }
    return { ok: true, rowCount: data.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function dropTable(tableName: string): Promise<DuckDbResponse> {
  try {
    const c = await ensureDb();
    await c.query(`DROP TABLE IF EXISTS "${tableName}"`);
    try {
      const dir = await datasetsDir();
      await dir.removeEntry(tableName, { recursive: true });
    } catch {
      // not persisted — no problem
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Drop every in-memory table and remove all persisted datasets from OPFS, so the
 * next conversation starts from an empty engine. Called when the user opens a new
 * conversation — datasets are scoped to a conversation, not the whole profile.
 */
export async function resetAll(): Promise<DuckDbResponse> {
  try {
    // Drop in-memory tables if the engine is already up; don't cold-start it just
    // to clear (restorePersisted would re-load the rows we're about to delete).
    if (conn) {
      const result = await conn.query("SELECT table_name FROM information_schema.tables WHERE table_schema='main'");
      for (const row of result.toArray()) {
        const name = String((row as any).table_name ?? '');
        if (name) await conn.query(`DROP TABLE IF EXISTS "${name}"`);
      }
    }
    // Remove every persisted dataset directory so nothing is auto-restored later.
    try {
      const dir = await datasetsDir();
      for (const name of await listPersisted()) {
        await dir.removeEntry(name, { recursive: true });
      }
    } catch {
      // no datasets dir yet — nothing to remove
    }
    // Force a fresh restore pass the next time the engine cold-starts.
    restored = false;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
