import { describe, expect, it } from 'vitest';
import { validateReadOnlySql } from './sqlGuard';

describe('validateReadOnlySql', () => {
  it('allows a plain SELECT', () => {
    expect(validateReadOnlySql('SELECT * FROM t')).toEqual({ ok: true });
  });

  it('allows a CTE (WITH ... SELECT)', () => {
    expect(validateReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).toEqual({ ok: true });
  });

  it('allows one trailing semicolon', () => {
    expect(validateReadOnlySql('SELECT * FROM t;')).toEqual({ ok: true });
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(validateReadOnlySql('select 1')).toEqual({ ok: true });
  });

  it('rejects an empty query', () => {
    expect(validateReadOnlySql('   ')).toMatchObject({ ok: false });
  });

  it('rejects a query not starting with SELECT/WITH', () => {
    expect(validateReadOnlySql('INSERT INTO t VALUES (1)')).toMatchObject({ ok: false });
    expect(validateReadOnlySql('DROP TABLE t')).toMatchObject({ ok: false });
  });

  it('rejects multiple statements even when the first is a SELECT', () => {
    expect(validateReadOnlySql("SELECT 1; DROP TABLE t")).toMatchObject({ ok: false });
  });

  it('rejects disallowed keywords appearing anywhere in a SELECT', () => {
    expect(validateReadOnlySql('SELECT * FROM t; ')).toEqual({ ok: true }); // trailing semicolon only, sanity check
    expect(validateReadOnlySql("SELECT * FROM t WHERE 1=1; CREATE TABLE x (a INT)")).toMatchObject({ ok: false });
    expect(validateReadOnlySql('ATTACH \'x.db\' AS x')).toMatchObject({ ok: false });
    expect(validateReadOnlySql('SELECT * FROM read_csv_auto(\'x\'); COPY t TO \'out.csv\'')).toMatchObject({ ok: false });
  });

  it('does not false-positive on column/table names that merely contain a keyword as a substring', () => {
    // "created_at" contains "create" but not as a whole word — must pass.
    expect(validateReadOnlySql('SELECT created_at FROM t')).toEqual({ ok: true });
  });
});
