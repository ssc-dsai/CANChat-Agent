// Read-only guard for model-generated SQL passed to the `query_data` tool
// (DuckDB, via src/offscreen/duckDb.ts). This is defense-in-depth, not a real
// SQL parser: it rejects the statement shapes that matter (multiple
// statements, DDL/DML/session/extension keywords) using word-boundary regexes
// rather than parsing the grammar. A string literal containing a keyword as a
// whole word (e.g. `WHERE name = 'DROP'`) can false-positive — acceptable for
// an MVP guard that errs toward rejecting over silently allowing a write.

const DISALLOWED_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|attach|detach|copy|pragma|install|load|call|export|import|vacuum|checkpoint|set|grant|revoke)\b/i;

export interface SqlGuardResult {
  ok: boolean;
  error?: string;
}

/** True when `sql` is a single, read-only SELECT/WITH statement. */
export function validateReadOnlySql(sql: string): SqlGuardResult {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: 'Empty query.' };

  // Allow one optional trailing semicolon; reject anything after it or any
  // semicolon before the end (a second statement).
  const withoutTrailingSemicolon = trimmed.replace(/;+\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return { ok: false, error: 'Only a single SQL statement is allowed (no semicolon-separated statements).' };
  }

  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    return { ok: false, error: 'Only read-only SELECT queries are allowed.' };
  }

  if (DISALLOWED_KEYWORDS.test(withoutTrailingSemicolon)) {
    return { ok: false, error: 'Query contains a disallowed keyword — only read-only SELECT queries are allowed.' };
  }

  return { ok: true };
}
