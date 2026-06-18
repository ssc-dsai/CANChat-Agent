import { useRef, useState } from 'preact/hooks';
import type { RepoInfo } from '../shared/messages';
import { UPLOAD_ACCEPT } from '../shared/uploadFile';
import { useT } from './i18n';
import { uploadFilesToRepo } from './repoUploadClient';

/**
 * Add files to a repository: a target-repo selector (existing repos or a new
 * name) plus a file picker / drag-drop. Used in the Repositories settings
 * section; the read/send helper is also reused by the composer drop handler.
 */
export function RepoUpload({ repos, onDone }: { repos: RepoInfo[]; onDone: () => void }) {
  const t = useT();
  const [target, setTarget] = useState<string>(''); // '' = new repo
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const repoName = (): string => (target || newName).trim();

  const ingest = async (fileList: FileList | File[]) => {
    const repo = repoName();
    if (!repo) {
      setResult(t('repos.upload.needName'));
      return;
    }
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setBusy(true);
    setResult(t('repos.upload.working'));
    try {
      const res = await uploadFilesToRepo(repo, files);
      const parts = [t('repos.upload.added', { n: String(res.added), c: String(res.chunks) })];
      if (res.skipped.length) parts.push(t('repos.upload.skipped', { items: res.skipped.join('; ') }));
      setResult(parts.join(' '));
      setNewName('');
      onDone();
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div class="repo-upload">
      <div class="field-row">
        <label class="field">
          <span>{t('repos.upload.target')}</span>
          <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
            <option value="">{t('repos.upload.newRepo')}</option>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {!target && (
          <label class="field">
            <span>{t('repos.upload.newName')}</span>
            <input
              type="text"
              value={newName}
              placeholder={t('repos.upload.newNamePlaceholder')}
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
            />
          </label>
        )}
      </div>
      <div
        class={`repo-drop${dragOver ? ' drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!busy && e.dataTransfer?.files?.length) void ingest(e.dataTransfer.files);
        }}
        onClick={() => !busy && inputRef.current?.click()}
      >
        {t('repos.upload.dropHint')}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          style="display:none"
          onChange={(e) => {
            const fl = (e.target as HTMLInputElement).files;
            if (fl) void ingest(fl);
          }}
        />
      </div>
      <p class="settings-note">{t('repos.upload.note')}</p>
      {result && <p class="settings-note">{result}</p>}
    </div>
  );
}
