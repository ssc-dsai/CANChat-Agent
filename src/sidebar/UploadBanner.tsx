import { useEffect } from 'preact/hooks';

/** A transient success/info banner that auto-dismisses (reuses the .banner style). */
export function UploadBanner({
  text,
  ok = true,
  onDismiss,
  timeoutMs = 4000,
}: {
  text: string;
  ok?: boolean;
  onDismiss: () => void;
  timeoutMs?: number;
}) {
  useEffect(() => {
    const id = setTimeout(onDismiss, timeoutMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <div class={`banner ${ok ? 'banner-ok' : 'banner-error'} upload-banner`} role="status">
      <span>{text}</span>
      <button class="icon-btn" title="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
