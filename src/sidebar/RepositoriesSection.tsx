import { useEffect, useState } from 'preact/hooks';
import type { RepoDoc, RepoInfo } from '../shared/messages';
import { useT } from './i18n';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function RepositoriesSection() {
  const t = useT();
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
        <strong>{t('repos.title')}</strong>
        <span class="sites-count">{repos.length}</span>
      </div>
      <p class="settings-note">{t('repos.note')}</p>
      {loading ? (
        <p class="settings-note">{t('repos.loading')}</p>
      ) : repos.length === 0 ? (
        <p class="settings-note">{t('repos.empty')}</p>
      ) : (
        <ul class="sites-list">
          {repos.map((r) => (
            <li key={r.name} class="repo-block">
              <div class="site-row">
                <button
                  class="repo-toggle"
                  title={expanded === r.name ? t('repos.hideDocs') : t('repos.showDocs')}
                  onClick={() => toggle(r.name)}
                >
                  {expanded === r.name ? '▾' : '▸'} {r.name}
                </button>
                <span class="site-desc">
                  {r.docs} {t('repos.docs')}, {r.chunks} {t('repos.chunks')}
                </span>
                <button class="icon-btn" aria-label={t('repos.deleteRepo')} title={t('repos.deleteRepo')} onClick={() => remove(r.name)}>
                  ✕
                </button>
              </div>
              {expanded === r.name && (
                <ul class="repo-docs">
                  {docsLoading ? (
                    <li class="settings-note">{t('repos.loading')}</li>
                  ) : docs.length === 0 ? (
                    <li class="settings-note">{t('repos.noDocs')}</li>
                  ) : (
                    docs.map((d) => (
                      <li key={d.id} class="repo-doc-row" title={d.url}>
                        <span class="repo-doc-name">{d.name || hostOf(d.url)}</span>
                        <span class="repo-doc-meta">
                          {hostOf(d.url)} · {d.chunkCount} {t('repos.chunks')}
                        </span>
                        <button
                          class="icon-btn"
                          aria-label={t('repos.deleteDoc')}
                          title={t('repos.deleteDoc')}
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
