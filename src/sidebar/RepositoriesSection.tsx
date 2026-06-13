import { useEffect, useState } from 'preact/hooks';
import type { RepoInfo } from '../shared/messages';

export function RepositoriesSection() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = (await chrome.runtime.sendMessage({ type: 'repo_list' })) as RepoInfo[];
      setRepos(Array.isArray(list) ? list : []);
    } catch {
      setRepos([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const remove = async (name: string) => {
    await chrome.runtime.sendMessage({ type: 'repo_delete', repo: name });
    void load();
  };

  return (
    <div class="sites-section">
      <div class="settings-header">
        <strong>Repositories</strong>
        <span class="sites-count">{repos.length}</span>
      </div>
      <p class="settings-note">
        On-device document stores (OPFS). The agent fills these with <code>add_to_repo</code> and
        answers from them with <code>search_repo</code>; embeddings use the endpoint above. Stored
        only on this device.
      </p>
      {loading ? (
        <p class="settings-note">Loading…</p>
      ) : repos.length === 0 ? (
        <p class="settings-note">No repositories yet.</p>
      ) : (
        <ul class="sites-list">
          {repos.map((r) => (
            <li key={r.name} class="site-row">
              <span class="site-name">{r.name}</span>
              <span class="site-desc">
                {r.docs} doc{r.docs === 1 ? '' : 's'}, {r.chunks} chunk{r.chunks === 1 ? '' : 's'}
              </span>
              <button class="icon-btn" title="Delete repository" onClick={() => remove(r.name)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
