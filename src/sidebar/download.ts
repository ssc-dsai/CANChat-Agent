// =============================================================================
// Centralized file-saving. Every file the extension writes (CSV/JSON exports,
// generated Word docs, conversation HTML, backups) goes through saveFile, which
// always opens a "Save as…" dialog (chrome.downloads + saveAs) so the user can
// rename the file or pick a folder rather than having it dropped silently into
// the default Downloads directory.
//
// Requires the "downloads" permission in the manifest. Falls back to a plain
// anchor download in non-extension contexts (e.g. unit tests).
// =============================================================================

/** Offer `blob` to the user as a download, always prompting for a location. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const downloads =
    typeof chrome !== 'undefined' && chrome.downloads && typeof chrome.downloads.download === 'function'
      ? chrome.downloads
      : null;

  if (!downloads) {
    // Non-extension fallback: a normal anchor download (no Save As dialog).
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  downloads.download({ url, filename, saveAs: true }, (downloadId?: number) => {
    // Dialog canceled or failed to start → revoke the object URL right away.
    if (chrome.runtime.lastError || downloadId === undefined) {
      URL.revokeObjectURL(url);
      return;
    }
    // Otherwise keep the blob alive until the download settles — the user may
    // still be choosing a location — then revoke once it completes or aborts.
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        URL.revokeObjectURL(url);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}
