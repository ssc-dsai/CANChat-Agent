import { useEffect, useState } from 'preact/hooks';
import { parseBackup } from '../../src/shared/backupFormat';
import type { Settings, Skill } from '../../src/shared/types';
import type { SearchHit } from '../../src/shared/vectorSearch';
import { ask } from './rag';
import { importBackup, listRepos, loadSettings, loadSkills, saveSettings } from './store';
import { findSkill, isBrowserSkill, parseRepoMention, parseSlashCommand } from './skills';
import { getDocumentText, getSelectionText, inWord, insertAtSelection } from './wordDoc';

interface RepoRow {
  name: string;
  docs: number;
  chunks: number;
}

export function TaskPane() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [repo, setRepo] = useState('');
  const [query, setQuery] = useState('');
  const [groundInDoc, setGroundInDoc] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = async () => {
    setSettings((await loadSettings()) ?? null);
    setSkills(await loadSkills());
    setRepos(await listRepos());
  };
  useEffect(() => {
    void refresh();
  }, []);

  const onImport = async (file: File) => {
    setStatus('Importing…');
    try {
      const parsed = parseBackup(JSON.parse(await file.text()));
      await importBackup(parsed);
      await refresh();
      setStatus(
        `Imported ${parsed.skills.length} skill(s) and ${parsed.repos.length} knowledge base(s)` +
          (parsed.settings?.model ? ` · model ${parsed.settings.model}` : ''),
      );
    } catch (e) {
      setStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onAsk = async () => {
    if (!settings) {
      setStatus('Import a backup first (or set the endpoint in Settings).');
      return;
    }
    if (!query.trim() || busy) return;
    setBusy(true);
    setAnswer('');
    setCitations([]);
    setStatus('Thinking…');
    try {
      // A leading /name invokes a skill; #repo overrides the picked repository.
      const slash = parseSlashCommand(query);
      const skill = slash ? findSkill(skills, slash.name) : undefined;
      const mentionRepo = parseRepoMention(query);
      const repoName = mentionRepo || repo || undefined;
      const effectiveQuery = slash ? slash.rest || query : query;
      const documentText = groundInDoc && inWord() ? (await getSelectionText()) || (await getDocumentText()) : undefined;

      if (skill && isBrowserSkill(skill)) {
        setStatus(`Note: /${skill.name} was written to drive the browser — applied here as guidance only.`);
      }

      const result = await ask({
        settings,
        query: effectiveQuery,
        repoName,
        documentText,
        skillBody: skill?.body,
      });
      setAnswer(result.answer);
      setCitations(result.citations);
      if (!skill || !isBrowserSkill(skill)) setStatus('');
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onInsert = async () => {
    if (!answer) return;
    if (!inWord()) {
      setStatus('Insert works inside Word; copy the answer for now.');
      return;
    }
    try {
      await insertAtSelection(answer);
      setStatus('Inserted into the document.');
    } catch (e) {
      setStatus(`Insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div class="pane">
      <header class="pane-head">
        <strong>CANChat for Word</strong>
        <button class="link" onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? 'Close' : 'Settings'}
        </button>
      </header>

      {showSettings ? (
        <SettingsView
          settings={settings}
          onSave={async (s) => {
            await saveSettings(s);
            setSettings(s);
            setShowSettings(false);
            setStatus('Settings saved.');
          }}
        />
      ) : (
        <>
          <section class="card">
            <label class="btn">
              Import backup…
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) void onImport(f);
                  (e.target as HTMLInputElement).value = '';
                }}
              />
            </label>
            <p class="hint">
              Export a backup from the CANChat Agent browser extension (Settings → Data &amp; privacy →
              Backup &amp; Restore), then load it here to use your model, skills, and knowledge bases.
            </p>
          </section>

          <section class="card">
            <div class="row">
              <label>Knowledge base</label>
              <select value={repo} onChange={(e) => setRepo((e.target as HTMLSelectElement).value)}>
                <option value="">None (model only)</option>
                {repos.map((r) => (
                  <option value={r.name} key={r.name}>
                    {r.name} ({r.docs} docs, {r.chunks} chunks)
                  </option>
                ))}
              </select>
            </div>
            <label class="check">
              <input type="checkbox" checked={groundInDoc} onChange={(e) => setGroundInDoc((e.target as HTMLInputElement).checked)} />
              Use the selected text / document as context
            </label>
            <textarea
              rows={3}
              placeholder="Ask anything… use /skill to apply a skill, #name to target a knowledge base"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)}
            />
            <div class="actions">
              <button class="btn primary" disabled={busy} onClick={() => void onAsk()}>
                {busy ? 'Working…' : 'Ask'}
              </button>
              <button class="btn" disabled={!answer} onClick={() => void onInsert()}>
                Insert answer
              </button>
            </div>
          </section>

          {status && <p class="status">{status}</p>}

          {answer && (
            <section class="card answer">
              <pre>{answer}</pre>
              {citations.length > 0 && (
                <ul class="cites">
                  {citations.map((c, i) => (
                    <li key={i}>
                      [{i + 1}] {c.name} — <span class="url">{c.url}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SettingsView({ settings, onSave }: { settings: Settings | null; onSave: (s: Settings) => void }) {
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(settings?.apiKey ?? '');
  const [model, setModel] = useState(settings?.model ?? '');
  return (
    <section class="card">
      <p class="hint">
        These come from your imported backup; override the endpoint here if you need to point at a
        CORS-enabled host or a local proxy.
      </p>
      <label>Endpoint base URL</label>
      <input value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} placeholder="https://… /v1" />
      <label>API key</label>
      <input type="password" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} placeholder="key" />
      <label>Model</label>
      <input value={model} onInput={(e) => setModel((e.target as HTMLInputElement).value)} placeholder="model name" />
      <div class="actions">
        <button
          class="btn primary"
          disabled={!baseUrl.trim() || !apiKey.trim() || !model.trim()}
          onClick={() => onSave({ ...(settings ?? {}), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() })}
        >
          Save
        </button>
      </div>
    </section>
  );
}
