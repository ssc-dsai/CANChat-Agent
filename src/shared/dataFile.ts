// Pure helpers for opening data files into the DuckDB engine. Classify a picked
// file by extension/MIME, bound its size for the base64 data transfer, and derive
// a safe SQL table name from a filename (incl. zip-member paths). Free of chrome.*
// so it can be unit-tested and shared between the UI and the background.

// Core (built-in) formats plus single-file geospatial formats read via the
// locally-bundled `spatial` extension. See src/offscreen/duckDb.ts for the readers.
const CORE_EXT = ['csv', 'tsv', 'json', 'ndjson', 'parquet'];
const GEO_EXT = ['geojson', 'kml', 'gpx', 'fgb'];

/** Tabular members the engine extracts from inside a zip archive. */
export const ARCHIVE_MEMBER_EXT = [...CORE_EXT, ...GEO_EXT];

/** Files the data engine can open directly (archive members + zip). */
export const DATA_EXT = [...ARCHIVE_MEMBER_EXT, 'zip'];

/** Files larger than this are rejected (base64 transfer guardrail). */
export const MAX_DATA_BYTES = 64 * 1024 * 1024; // 64 MB

/** The `accept` attribute value for the data-file inputs. */
export const DATA_ACCEPT = DATA_EXT.map((e) => `.${e}`).join(',');

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * True when this file can be opened by the DuckDB engine. Extension is
 * authoritative; MIME is a fallback for tabular content with no/odd extension.
 */
export function classifyDataFile(name: string, mime = ''): 'duckdb' | null {
  if (DATA_EXT.includes(extOf(name))) return 'duckdb';
  if (mime === 'text/csv' || mime === 'application/json' || mime === 'application/x-ndjson') return 'duckdb';
  if (mime === 'application/zip' || mime === 'application/vnd.apache.parquet') return 'duckdb';
  if (mime === 'application/geo+json') return 'duckdb';
  return null;
}

/**
 * Derive a safe SQL identifier from a filename: drop directory + extension,
 * lowercase, non-alphanumeric → `_`, collapse/trim underscores, and ensure it
 * starts with a letter. Empty/odd names fall back to `data`. Callers dedupe.
 */
export function tableNameFromFile(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).replace(/\.[^.]+$/, '');
  let t = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!t) t = 'data';
  if (/^[0-9]/.test(t)) t = `t_${t}`;
  return t;
}

/** Dedupe a candidate table name against names already in use (adds `_2`, `_3`…). */
export function uniqueTableName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate;
  let n = 2;
  while (used.has(`${candidate}_${n}`)) n++;
  return `${candidate}_${n}`;
}
