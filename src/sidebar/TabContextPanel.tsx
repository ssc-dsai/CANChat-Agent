import { useEffect, useState } from 'preact/hooks';
import type { SidebarCommand } from '../shared/messages';
import type { TabContextSummary } from '../shared/types';

interface Props {
  context: TabContextSummary | null;
  send: (command: SidebarCommand) => void;
}

const STALE_AFTER_MS = 5 * 60 * 1000;

/** Scale a data-URL image down to maxWidth, re-encoding as JPEG. */
async function downscale(dataUrl: string, maxWidth: number): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width <= maxWidth) return dataUrl;
  const scale = maxWidth / bitmap.width;
  const canvas = new OffscreenCanvas(maxWidth, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(out);
  });
}

export function TabContextPanel({ context, send }: Props) {
  // Re-render every 30s so staleness indicators stay honest.
  const [, setTick] = useState(0);
  const [repo, setRepo] = useState('');
  const [repoNames, setRepoNames] = useState<string[]>([]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Populate the repo dropdown with existing repository names.
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'repo_list' })
      .then((list: Array<{ name: string }> | undefined) => {
        if (Array.isArray(list)) setRepoNames(list.map((r) => r.name));
      })
      .catch(() => {});
  }, []);

  const addToRepo = (scope: 'tab' | 'group') => {
    if (!repo.trim()) return;
    send({ type: 'capture_to_repo', repo: repo.trim(), scope });
  };

  const snapshot = async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
    } catch {
      // Restricted pages (chrome://, Web Store) cannot be captured.
      return;
    }
    // Downscale so vision-token and storage costs stay sane.
    const scaled = await downscale(dataUrl, 1280);
    send({ type: 'attach_snapshot', dataUrl: scaled, title: tab.title ?? '', url: tab.url ?? '' });
  };

  const isStale = (capturedAt: string) =>
    Date.now() - new Date(capturedAt).getTime() > STALE_AFTER_MS;

  return (
    <div class="context-panel">
      <div class="context-actions">
        <button
          class="btn btn-small"
          title="Capture the visible part of the current tab as an image for the model — for content text extraction can't see (dashboards, canvases, PDFs)"
          onClick={snapshot}
        >
          Snapshot
        </button>
        <button
          class="btn btn-small"
          title="OCR the WHOLE page by scrolling top to bottom — captures it as images for the vision model to read (opaque/long pages)"
          onClick={() => send({ type: 'capture_page' })}
        >
          OCR Page
        </button>
        <button
          class="btn btn-small"
          onClick={() => send({ type: 'refresh_context' })}
          disabled={!context}
        >
          Refresh
        </button>
      </div>
      <div class="repo-actions">
        <input
          class="repo-input"
          type="text"
          list="repo-names"
          placeholder="Repo name"
          value={repo}
          onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
        />
        <datalist id="repo-names">
          {repoNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button
          class="btn btn-small"
          title="Capture this tab's text into the named on-device repository (OCR fallback for opaque pages)"
          disabled={!repo.trim()}
          onClick={() => addToRepo('tab')}
        >
          + Tab
        </button>
        <button
          class="btn btn-small"
          title="Capture every page in this conversation's tab group into the named repository"
          disabled={!repo.trim()}
          onClick={() => addToRepo('group')}
        >
          + Group
        </button>
      </div>
      {context && (
        <ul class="context-tabs">
          {context.tabs.map((t) => (
            <li key={t.tabId} class="context-tab" title={t.url}>
              <span class={`dot dot-${t.extractionStatus}`} />
              <span class="context-tab-title">{t.title || t.url}</span>
              {isStale(t.capturedAt) && <span class="stale-tag">stale</span>}
              {t.extractionStatus !== 'ok' && t.extractionStatus !== 'partial' && (
                <span class="stale-tag">{t.extractionStatus}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
