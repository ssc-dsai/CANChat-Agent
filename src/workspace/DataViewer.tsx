import { useState, useMemo } from 'preact/hooks';
import type { DataExport } from '../shared/types';
import { saveFile } from '../sidebar/download';

interface Props {
  data: DataExport;
  allExports: DataExport[];
  onSelectExport: (d: DataExport) => void;
}

function toCsv(columns: string[], rows: string[][]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\r\n');
}

type SortDir = 'asc' | 'desc' | null;

function sortedRows(
  rows: string[][],
  colIdx: number | null,
  dir: SortDir,
): string[][] {
  if (colIdx === null || dir === null) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const va = (a[colIdx] ?? '').toLowerCase();
    const vb = (b[colIdx] ?? '').toLowerCase();
    const na = parseFloat(va);
    const nb = parseFloat(vb);
    const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : va.localeCompare(vb);
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

const PAGE_SIZES = [10, 25, 50, 100];

export function DataViewer({ data, allExports, onSelectExport }: Props) {
  const [query, setQuery] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const q = query.toLowerCase().trim();

  const filtered = useMemo(() => {
    if (!q) return data.rows;
    return data.rows.filter((row) =>
      row.some((cell) => cell.toLowerCase().includes(q)),
    );
  }, [data.rows, q]);

  const sorted = useMemo(
    () => sortedRows(filtered, sortCol, sortDir),
    [filtered, sortCol, sortDir],
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const handleSort = (colIdx: number) => {
    if (sortCol === colIdx) {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') {
        setSortCol(null);
        setSortDir(null);
      }
    } else {
      setSortCol(colIdx);
      setSortDir('asc');
    }
    setPage(0);
  };

  const handleQuery = (val: string) => {
    setQuery(val);
    setPage(0);
  };

  const handlePageSize = (size: number) => {
    setPageSize(size);
    setPage(0);
  };

  const filterActive = !!q;
  const visibleRows = filterActive ? sorted : data.rows;

  const downloadCsv = () => {
    const csv = toCsv(data.columns, visibleRows);
    saveFile(new Blob([csv], { type: 'text/csv' }), data.filename);
  };
  const downloadJson = () => {
    const json = JSON.stringify(
      visibleRows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i] ?? '']))),
      null, 2,
    );
    saveFile(new Blob([json], { type: 'application/json' }), data.filename.replace(/\.csv$/, '.json'));
  };

  const sortIcon = (i: number) => {
    if (sortCol !== i) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  };

  return (
    <div class="ws-data-viewer">
      <header class="ws-data-header">
        <h2>{data.title}</h2>
        <span class="ws-data-dims">
          {visibleRows.length}{filterActive && ` / ${data.rows.length}`} × {data.columns.length}
        </span>
        {filterActive && <span class="ws-filter-badge">filtered</span>}
        <button class="btn btn-small" onClick={downloadCsv}>
          {filterActive ? 'Filtered CSV' : 'CSV'}
        </button>
        <button class="btn btn-small" onClick={downloadJson}>
          {filterActive ? 'Filtered JSON' : 'JSON'}
        </button>
      </header>

      <div class="ws-data-toolbar">
        <input
          class="ws-data-filter"
          type="text"
          placeholder="Filter rows…"
          value={query}
          onInput={(e) => handleQuery((e.target as HTMLInputElement).value)}
        />
        <span class="ws-data-count">{visibleRows.length} row{visibleRows.length !== 1 ? 's' : ''}</span>
        <span class="ws-data-page-size">
          <select
            value={pageSize}
            onChange={(e) => handlePageSize(Number((e.target as HTMLSelectElement).value))}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s} / page</option>
            ))}
          </select>
        </span>
      </div>

      {allExports.length > 1 && (
        <div class="ws-data-export-list">
          {allExports.map((d, i) => (
            <button
              key={i}
              class={`ws-data-export-chip${d === data ? ' is-active' : ''}`}
              onClick={() => { onSelectExport(d); setPage(0); setQuery(''); setSortCol(null); setSortDir(null); }}
            >
              {d.title} ({d.rows.length}r × {d.columns.length}c)
            </button>
          ))}
        </div>
      )}

      <div class="ws-data-table-wrap">
        <table class="ws-data-table">
          <thead>
            <tr>
              <th class="ws-data-row-num">#</th>
              {data.columns.map((c, i) => (
                <th key={i} class="ws-data-sortable" onClick={() => handleSort(i)}>
                  {c}{sortIcon(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={data.columns.length + 1} class="ws-data-empty">
                  {filterActive ? 'No rows match the filter.' : 'No data.'}
                </td>
              </tr>
            ) : (
              pageRows.map((row, ri) => (
                <tr key={ri}>
                  <td class="ws-data-row-num">{safePage * pageSize + ri + 1}</td>
                  {row.map((cell, ci) => <td key={ci}>{cell}</td>)}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer class="ws-data-footer">
        <button
          class="btn btn-small"
          disabled={safePage === 0}
          onClick={() => setPage(safePage - 1)}
        >
          Prev
        </button>
        <span class="ws-data-page-info">
          Page {safePage + 1} of {totalPages}
        </span>
        <button
          class="btn btn-small"
          disabled={safePage >= totalPages - 1}
          onClick={() => setPage(safePage + 1)}
        >
          Next
        </button>
        <span class="ws-data-total-rows">{data.rows.length} total rows</span>
      </footer>
    </div>
  );
}
