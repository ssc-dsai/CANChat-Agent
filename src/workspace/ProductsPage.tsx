import { useEffect, useState } from 'preact/hooks';
import type { ProductMeta } from '../shared/messages';
import { saveFile } from '../sidebar/download';
import { useT } from '../sidebar/i18n';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Files scheduled tasks and event triggers generate (e.g. a PowerPoint from a
 * "check this site every morning" job) land here durably in OPFS — see
 * `productStore.ts` — instead of only ever firing an OS download prompt for
 * every unattended run, or a click-to-download card no sidebar was open to see.
 */
export function ProductsPage() {
  const t = useT();
  const [products, setProducts] = useState<ProductMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    chrome.runtime.sendMessage({ type: 'products_list' }).then((r: ProductMeta[]) => setProducts(Array.isArray(r) ? r : []));
  };

  useEffect(reload, []);

  const download = async (p: ProductMeta) => {
    setError(null);
    setBusyId(p.id);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'product_get', id: p.id })) as { meta: ProductMeta; dataBase64: string } | null;
      if (!res) {
        setError(t('products.loadFailed', { filename: p.filename }));
        return;
      }
      saveFile(base64ToBlob(res.dataBase64, res.meta.mimeType), res.meta.filename);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await chrome.runtime.sendMessage({ type: 'product_delete', id });
      reload();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class="ws-products-page">
      <h2>{t('products.title')}</h2>
      <p class="settings-note">{t('products.note')}</p>
      {error && <div class="banner banner-error">{error}</div>}
      {products.length === 0 ? (
        <div class="ws-empty">
          <strong>{t('products.emptyTitle')}</strong>
          <span>{t('products.emptyHint')}</span>
        </div>
      ) : (
        <ul class="ws-item-list">
          {products.map((p) => (
            <li key={p.id} class="ws-item">
              <span class="ws-file-glyph" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
              </span>
              <div class="ws-item-main">
                <span class="ws-item-title">{p.filename}</span>
                <span class="ws-item-meta">
                  {fmt(p.createdAt)} · {fmtSize(p.sizeBytes)}
                  {p.sourceTitle ? ` · ${t('products.from', { title: p.sourceTitle })}` : ''}
                </span>
              </div>
              <div class="ws-item-actions">
                <button class="btn btn-small" disabled={busyId === p.id} onClick={() => download(p)}>{t('products.download')}</button>
                <button class="icon-btn" title={t('common.delete')} disabled={busyId === p.id} onClick={() => remove(p.id)}>✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
