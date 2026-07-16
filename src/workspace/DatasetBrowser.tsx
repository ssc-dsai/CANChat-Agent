import { useEffect, useRef, useState } from 'preact/hooks';
import type { DuckDbOp, DuckDbResponse, DuckDbTableInfo } from '../shared/messages';
import { DATA_ACCEPT } from '../shared/dataFile';
import { openDataFiles } from '../sidebar/dataOpenClient';
import { visibleToProject } from '../shared/memoryGraph';

// Drive the built-in DuckDB engine straight from the workspace. The service
// worker owns the offscreen document, so we route every op through a `duckdb`
// RuntimeRequest rather than messaging the offscreen page directly.
function duckdb(op: DuckDbOp, extra?: { sql?: string; tableName?: string; data?: string; projectId?: string }): Promise<DuckDbResponse> {
  return chrome.runtime.sendMessage({ type: 'duckdb', op, ...extra }) as Promise<DuckDbResponse>;
}

/** Guess CSV vs JSON from the pasted text so the user doesn't have to pick. */
function detectFormat(text: string): 'json' | 'csv' {
  const t = text.trim();
  return t.startsWith('[') || t.startsWith('{') ? 'json' : 'csv';
}

export function DatasetBrowser() {
  const [tables, setTables] = useState<DuckDbTableInfo[]>([]);
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<DuckDbResponse | null>(null);
  const [importName, setImportName] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<DuckDbTableInfo | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const r = await duckdb('list_tables');
    if (r.ok) setTables(r.tables ?? []);
    else setError(r.error ?? 'Could not reach the data engine.');
  };
  useEffect(() => { void refresh(); }, []);

  // Scoping is a filter, not a partition (see shared/memoryGraph.ts
  // visibleToProject) — mirrors ProjectSwitcher.tsx's read pattern.
  useEffect(() => {
    const load = () =>
      chrome.storage.local.get('ba_active_project').then((r) => {
        const id = r.ba_active_project;
        setActiveProjectId(typeof id === 'string' && id ? id : null);
      });
    load();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.ba_active_project) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const visibleTables = tables.filter((t) => visibleToProject(t.projectId, activeProjectId));

  const runSql = async (query?: string) => {
    const q = (query ?? sql).trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    if (query) setSql(query);
    const r = await duckdb('query', { sql: q });
    if (r.ok) setResult(r);
    else setError(r.error ?? 'Query failed.');
    setBusy(false);
  };

  const preview = (name: string) => runSql(`SELECT * FROM "${name}" LIMIT 100`);

  const profileTable = async (name: string) => {
    setBusy(true);
    setError(null);
    const r = await duckdb('describe_table', { tableName: name });
    if (r.ok) setProfile(r.tables?.[0] ?? null);
    else setError(r.error ?? 'Could not profile table.');
    setBusy(false);
  };

  const importData = async () => {
    const name = importName.trim();
    if (!name || !importText.trim()) return;
    setBusy(true);
    setError(null);
    const op: DuckDbOp = detectFormat(importText) === 'json' ? 'import_json' : 'import_csv';
    const r = await duckdb(op, { tableName: name, data: importText, projectId: activeProjectId ?? undefined });
    if (r.ok) {
      setImportText('');
      await refresh();
      await runSql(`SELECT * FROM "${name}" LIMIT 100`);
    } else {
      setError(r.error ?? 'Import failed.');
    }
    setBusy(false);
  };

  const drop = async (name: string) => {
    await duckdb('drop_table', { tableName: name });
    await refresh();
  };

  const onPickFiles = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { results } = await openDataFiles(files, activeProjectId ?? undefined);
      const failed = results.find((r) => !r.ok);
      if (failed) setError(`${failed.name}: ${failed.error ?? 'failed'}`);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="ws-ds">
      <section class="ws-ds-list">
        <div class="ws-ds-head">
          <strong>Datasets</strong>
          <span style="display:flex; gap:6px;">
            <button class="ws-btn ws-btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>Open file…</button>
            <button class="ws-btn" disabled={busy} onClick={refresh}>Refresh</button>
          </span>
          <input ref={fileRef} type="file" multiple accept={DATA_ACCEPT} style="display:none" onChange={onPickFiles} />
        </div>
        {visibleTables.length === 0 && <p class="ws-dim">No datasets loaded. Import CSV or JSON below — or ask the agent to import data.</p>}
        {visibleTables.map((t) => (
          <div key={t.name} class="ws-ds-row">
            <button class="ws-link" onClick={() => preview(t.name)}>{t.name}</button>
            <span class="ws-dim">{t.rowCount} rows · {t.columns.length} cols{t.persisted ? ' · saved' : ''}</span>
            <button class="ws-btn ws-btn-quiet" onClick={() => profileTable(t.name)} title="Profile columns">Profile</button>
            <button class="ws-btn ws-btn-quiet" onClick={() => drop(t.name)} title="Drop dataset">✕</button>
          </div>
        ))}
      </section>

      <section class="ws-ds-query">
        <label class="ws-ds-label">SQL</label>
        <textarea
          class="ws-ds-sql"
          value={sql}
          placeholder={'SELECT * FROM my_table WHERE CAST(value AS DOUBLE) > 10'}
          onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
        />
        <button class="ws-btn ws-btn-primary" disabled={busy || !sql.trim()} onClick={() => runSql()}>Run query</button>
      </section>

      {error && <div class="ws-ds-error">{error}</div>}

      {profile && (
        <section class="ws-ds-result">
          <div class="ws-ds-head">
            <strong>Profile: {profile.name}</strong>
            <button class="ws-btn ws-btn-quiet" onClick={() => setProfile(null)}>Close</button>
          </div>
          <div class="ws-ds-scroll">
            <table class="ws-ds-table">
              <thead>
                <tr><th>Column</th><th>Type</th><th>Null %</th><th>Approx distinct</th><th>Min</th><th>Max</th></tr>
              </thead>
              <tbody>
                {profile.columns.map((name, i) => {
                  const cp = profile.columnProfiles?.find((p) => p.name === name);
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{profile.columnTypes[i]}</td>
                      <td>{cp ? `${(cp.nullRatio * 100).toFixed(1)}%` : '—'}</td>
                      <td>{cp?.approxDistinct ?? '—'}</td>
                      <td>{cp?.min ?? '—'}</td>
                      <td>{cp?.max ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result?.ok && result.columns && (
        <section class="ws-ds-result">
          <div class="ws-dim">
            {result.rowCount ?? result.rows?.length ?? 0} row(s)
            {result.truncated ? ` — showing the first ${result.rows?.length ?? 0}; narrow with WHERE/LIMIT/aggregation` : ''}
          </div>
          <div class="ws-ds-scroll">
            <table class="ws-ds-table">
              <thead>
                <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {(result.rows ?? []).slice(0, 500).map((row, i) => (
                  <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section class="ws-ds-import">
        <label class="ws-ds-label">Import data</label>
        <input
          class="ws-ds-name"
          value={importName}
          placeholder="table name (e.g. vessels)"
          onInput={(e) => setImportName((e.target as HTMLInputElement).value)}
        />
        <textarea
          class="ws-ds-paste"
          value={importText}
          placeholder={'Paste CSV or JSON here…'}
          onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
        />
        <button class="ws-btn ws-btn-primary" disabled={busy || !importName.trim() || !importText.trim()} onClick={importData}>
          Import {importText.trim() ? `as ${detectFormat(importText).toUpperCase()}` : ''}
        </button>
      </section>
    </div>
  );
}
