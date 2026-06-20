import { describe, expect, it } from 'vitest';
import { classifyDataFile, tableNameFromFile, uniqueTableName } from './dataFile';

describe('classifyDataFile', () => {
  it('accepts data extensions', () => {
    for (const n of ['a.csv', 'a.tsv', 'a.json', 'a.ndjson', 'a.parquet', 'a.zip', 'DIR/B.CSV']) {
      expect(classifyDataFile(n)).toBe('duckdb');
    }
  });
  it('accepts extension-backed geospatial formats', () => {
    for (const n of ['a.geojson', 'a.kml', 'a.gpx', 'a.fgb']) {
      expect(classifyDataFile(n)).toBe('duckdb');
    }
  });
  it('accepts by MIME when the extension is unhelpful', () => {
    expect(classifyDataFile('blob', 'text/csv')).toBe('duckdb');
    expect(classifyDataFile('blob', 'application/json')).toBe('duckdb');
    expect(classifyDataFile('blob', 'application/zip')).toBe('duckdb');
    expect(classifyDataFile('blob', 'application/geo+json')).toBe('duckdb');
  });
  it('rejects unsupported files', () => {
    expect(classifyDataFile('a.pdf')).toBeNull();
    expect(classifyDataFile('a.docx')).toBeNull();
    expect(classifyDataFile('note.txt')).toBeNull();
    expect(classifyDataFile('blob')).toBeNull();
  });
});

describe('tableNameFromFile', () => {
  it('strips dir + extension, lowercases, sanitizes', () => {
    expect(tableNameFromFile('Reports/Vessel Data.CSV')).toBe('vessel_data');
    expect(tableNameFromFile('a-b.c.json')).toBe('a_b_c');
    expect(tableNameFromFile('data/2024-ships.parquet')).toBe('t_2024_ships');
  });
  it('falls back to data for empty/odd names', () => {
    expect(tableNameFromFile('.csv')).toBe('data');
    expect(tableNameFromFile('___.json')).toBe('data');
  });
});

describe('uniqueTableName', () => {
  it('suffixes collisions', () => {
    const used = new Set(['ships', 'ships_2']);
    expect(uniqueTableName('ships', used)).toBe('ships_3');
    expect(uniqueTableName('ports', used)).toBe('ports');
  });
});
