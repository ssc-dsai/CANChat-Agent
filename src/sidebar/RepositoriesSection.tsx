import { useEffect, useState } from 'preact/hooks';
import type { RepoDoc, RepoInfo } from '../shared/messages';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function RepositoriesSection() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [docs, setDocs] = useState<RepoDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);

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

  const loadDocs = async (repo: string) => {
    setDocsLoading(true);
    try {
      const list = (await chrome.runtime.sendMessage({ type: 'repo_docs', repo })) as RepoDoc[];
      setDocs(Array.isArray(list) ? list : []);
    } catch {
      setDocs([]);
    }
    setDocsLoading(false);
  };

  const toggle = async (repo: string) => {
    if (expanded === repo) {
      setExpanded(null);
      setDocs([]);
      return;
    }
    setExpanded(repo);
    await loadDocs(repo);
  };

  const remove = async (name: string) => {
    await chrome.runtime.sendMessage({ type: 'repo_delete', repo: name });
    if (expanded === name) {
      setExpanded(null);
      setDocs([]);
    }
    void load();
  };

  const removeDoc = async (repo: string, docId: string) => {
    await chrome.runtime.sendMessage({ type: 'repo_doc_delete', repo, docId });
    await loadDocs(repo);
    void load(); // refresh doc/chunk counts
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
            <li key={r.name} class="repo-block">
              <div class="site-row">
                <button
                  class="repo-toggle"
                  title={expanded === r.name ? 'Hide documents' : 'Show documents'}
                  onClick={() => toggle(r.name)}
                >
                  {expanded === r.name ? '▾' : '▸'} {r.name}
                </button>
                <span class="site-desc">
                  {r.docs} doc{r.docs === 1 ? '' : 's'}, {r.chunks} chunk{r.chunks === 1 ? '' : 's'}
                </span>
                <button class="icon-btn" title="Delete repository" onClick={() => remove(r.name)}>
                  ✕
                </button>
              </div>
              {expanded === r.name && (
                <ul class="repo-docs">
                  {docsLoading ? (
                    <li class="settings-note">Loading…</li>
                  ) : docs.length === 0 ? (
                    <li class="settings-note">No documents.</li>
                  ) : (
                    docs.map((d) => (
                      <li key={d.id} class="repo-doc-row" title={d.url}>
                        <span class="repo-doc-name">{d.name || hostOf(d.url)}</span>
                        <span class="repo-doc-meta">
                          {hostOf(d.url)} · {d.chunkCount} chunk{d.chunkCount === 1 ? '' : 's'}
                        </span>
                        <button
                          class="icon-btn"
                          title="Delete this document"
                          onClick={() => removeDoc(r.name, d.id)}
                        >
                          ✕
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
