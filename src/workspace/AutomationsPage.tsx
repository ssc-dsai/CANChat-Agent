import { useEffect, useState } from 'preact/hooks';
import type { EventTrigger, TriggerRun } from '../shared/eventTriggers';
import type { ScheduledRun, ScheduledTask } from '../shared/scheduledTasks';
import type { Skill } from '../shared/types';
import type { Workflow } from '../shared/workflows';

function fmt(ts: number | string | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'OK',
  error: 'Error',
  deferred: 'Deferred',
  needs_approval: 'Needs approval',
  running: 'Running…',
};

// The pre-existing scheduled-task system (previously tool-only, no UI) plus
// the two Phase 6 additions — Workflows (named ordered skill chains) and
// Event triggers (fire an unattended run when a matching site is opened).
// Every run here goes through AgentRuntime.runScheduledTask, so the existing
// unattended-approval gate (state-changing tools blocked, not silently run)
// applies exactly as it does to scheduled tasks today.
export function AutomationsPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskRuns, setTaskRuns] = useState<ScheduledRun[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [triggers, setTriggers] = useState<EventTrigger[]>([]);
  const [triggerRuns, setTriggerRuns] = useState<TriggerRun[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  const [showWorkflowForm, setShowWorkflowForm] = useState(false);
  const [wfName, setWfName] = useState('');
  const [wfDescription, setWfDescription] = useState('');
  const [wfSkills, setWfSkills] = useState('');
  const [wfError, setWfError] = useState<string | null>(null);

  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [trName, setTrName] = useState('');
  const [trHost, setTrHost] = useState('');
  const [trTargetKind, setTrTargetKind] = useState<'skill' | 'workflow'>('skill');
  const [trTargetValue, setTrTargetValue] = useState('');
  const [trCooldown, setTrCooldown] = useState('');
  const [trError, setTrError] = useState<string | null>(null);

  const reload = () => {
    chrome.runtime.sendMessage({ type: 'scheduled_tasks_get' }).then((r: ScheduledTask[]) => setTasks(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'scheduled_runs_get' }).then((r: ScheduledRun[]) => setTaskRuns(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'workflow_list' }).then((r: Workflow[]) => setWorkflows(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'event_trigger_list' }).then((r: EventTrigger[]) => setTriggers(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'trigger_runs_get' }).then((r: TriggerRun[]) => setTriggerRuns(Array.isArray(r) ? r : []));
    chrome.storage.local.get('ba_skills').then((r) => setSkills(Array.isArray(r.ba_skills) ? (r.ba_skills as Skill[]) : []));
  };

  useEffect(() => {
    reload();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.ba_scheduled_tasks || changes.ba_scheduled_runs || changes.ba_workflows || changes.ba_event_triggers || changes.ba_trigger_runs || changes.ba_skills) {
        reload();
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const toggleTask = async (id: string, enabled: boolean) => {
    await chrome.runtime.sendMessage({ type: 'scheduled_task_set_enabled', id, enabled });
    reload();
  };
  const deleteTask = async (id: string) => {
    await chrome.runtime.sendMessage({ type: 'scheduled_task_delete', id });
    reload();
  };

  const createWorkflow = async () => {
    setWfError(null);
    const skillNames = wfSkills.split(',').map((s) => s.trim()).filter(Boolean);
    const res = (await chrome.runtime.sendMessage({
      type: 'workflow_create',
      name: wfName,
      description: wfDescription || undefined,
      skillNames,
    })) as { ok: boolean; error?: string };
    if (!res.ok) {
      setWfError(res.error ?? 'Could not create workflow.');
      return;
    }
    setWfName('');
    setWfDescription('');
    setWfSkills('');
    setShowWorkflowForm(false);
    reload();
  };
  const deleteWorkflow = async (id: string) => {
    await chrome.runtime.sendMessage({ type: 'workflow_delete', id });
    reload();
  };

  const createTrigger = async () => {
    setTrError(null);
    if (!trTargetValue.trim()) {
      setTrError(trTargetKind === 'skill' ? 'Pick a skill.' : 'Pick a workflow.');
      return;
    }
    const target = trTargetKind === 'skill' ? { kind: 'skill' as const, name: trTargetValue } : { kind: 'workflow' as const, workflowId: trTargetValue };
    const cooldownMinutes = trCooldown.trim() ? Number(trCooldown) : undefined;
    const res = (await chrome.runtime.sendMessage({
      type: 'event_trigger_create',
      name: trName,
      hostPattern: trHost,
      target,
      cooldownMinutes,
    })) as { ok: boolean; error?: string };
    if (!res.ok) {
      setTrError(res.error ?? 'Could not create trigger.');
      return;
    }
    setTrName('');
    setTrHost('');
    setTrTargetValue('');
    setTrCooldown('');
    setShowTriggerForm(false);
    reload();
  };
  const toggleTrigger = async (id: string, enabled: boolean) => {
    await chrome.runtime.sendMessage({ type: 'event_trigger_update', id, patch: { enabled } });
    reload();
  };
  const deleteTrigger = async (id: string) => {
    await chrome.runtime.sendMessage({ type: 'event_trigger_delete', id });
    reload();
  };

  const workflowName = (id: string) => workflows.find((w) => w.id === id)?.name ?? '(deleted workflow)';
  const targetLabel = (t: EventTrigger) => (t.target.kind === 'skill' ? `/${t.target.name}` : workflowName(t.target.workflowId));

  const recentTaskRuns = [...taskRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);
  const recentTriggerRuns = [...triggerRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);

  return (
    <div class="ws-automations-page">
      <h2>Automations</h2>
      <p class="settings-note">
        Background work the agent does without you watching — scheduled tasks, saved workflows, and
        site-triggered runs. Every run here goes through the same unattended-approval gate as a
        scheduled task: it can read and search freely, but a state-changing action (clicking,
        filling a form, sending mail) still waits for you.
      </p>

      <h3>Scheduled tasks</h3>
      {tasks.length === 0 ? (
        <p class="settings-note">
          None yet — ask the agent to "schedule a task that…" and it will appear here.
        </p>
      ) : (
        <ul class="sites-list">
          {tasks.map((t) => (
            <li key={t.id} class="site-row" title={t.prompt}>
              <span class={`approval-tag trust-badge ${t.enabled ? 'trust-local' : 'trust-public'}`}>{t.enabled ? 'enabled' : 'paused'}</span>
              <span class="site-name">{t.title}</span>
              <span class="site-desc">
                Next: {fmt(t.enabled ? t.nextRunAt : undefined)} · Last: {fmt(t.lastRunAt)}
                {t.lastStatus ? ` (${STATUS_LABEL[t.lastStatus] ?? t.lastStatus})` : ''}
              </span>
              <button class="btn btn-small" onClick={() => toggleTask(t.id, !t.enabled)}>{t.enabled ? 'Pause' : 'Resume'}</button>
              <button class="icon-btn" title="Delete" onClick={() => deleteTask(t.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {recentTaskRuns.length > 0 && (
        <>
          <p class="settings-note">Recent runs</p>
          <ul class="sites-list ws-run-list">
            {recentTaskRuns.map((r) => (
              <li key={r.id} class="ws-run-item">
                <div class="ws-run-header">
                  <span class="site-name">{tasks.find((t) => t.id === r.taskId)?.title ?? '(deleted task)'}</span>
                  <span class="site-desc">{fmt(r.startedAt)} — {STATUS_LABEL[r.status] ?? r.status}</span>
                </div>
                {(r.summary || r.error) && <p class="ws-run-detail">{r.error ?? r.summary}</p>}
                {r.fileArtifactNames && r.fileArtifactNames.length > 0 && (
                  <p class="ws-run-detail ws-dim">📎 Saved to Downloads: {r.fileArtifactNames.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Workflows</h3>
      <p class="settings-note">A named, ordered chain of existing skills — run them in sequence from one request.</p>
      {workflows.length > 0 && (
        <ul class="sites-list">
          {workflows.map((w) => (
            <li key={w.id} class="site-row" title={w.description}>
              <span class="site-name">{w.name}</span>
              <span class="site-desc">{w.skillNames.map((n) => `/${n}`).join(' → ')}</span>
              <button class="icon-btn" title="Delete" onClick={() => deleteWorkflow(w.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {showWorkflowForm ? (
        <div class="site-form">
          <label class="field">
            <span>Name</span>
            <input type="text" value={wfName} onInput={(e) => setWfName((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Description (optional)</span>
            <input type="text" value={wfDescription} onInput={(e) => setWfDescription((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Skills, in order (comma-separated /names) — known: {skills.map((s) => s.name).join(', ') || 'none saved yet'}</span>
            <input type="text" placeholder="research, search-mail" value={wfSkills} onInput={(e) => setWfSkills((e.target as HTMLInputElement).value)} />
          </label>
          {wfError && <div class="banner banner-error">{wfError}</div>}
          <div class="settings-actions">
            <button class="btn" onClick={() => setShowWorkflowForm(false)}>Cancel</button>
            <button class="btn btn-primary" onClick={createWorkflow} disabled={!wfName.trim() || !wfSkills.trim()}>Create workflow</button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowWorkflowForm(true)}>Add workflow</button>
        </div>
      )}

      <h3>Event triggers</h3>
      <p class="settings-note">Run a skill or workflow unattended the next time you open a matching site.</p>
      {triggers.length > 0 && (
        <ul class="sites-list">
          {triggers.map((t) => (
            <li key={t.id} class="site-row">
              <span class={`approval-tag trust-badge ${t.enabled ? 'trust-local' : 'trust-public'}`}>{t.enabled ? 'enabled' : 'paused'}</span>
              <span class="site-name">{t.name}</span>
              <span class="site-desc">
                {t.hostPattern} → {targetLabel(t)} · cooldown {t.cooldownMinutes ?? 60}min · last fired {fmt(t.lastFiredAt)}
              </span>
              <button class="btn btn-small" onClick={() => toggleTrigger(t.id, !t.enabled)}>{t.enabled ? 'Pause' : 'Resume'}</button>
              <button class="icon-btn" title="Delete" onClick={() => deleteTrigger(t.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {showTriggerForm ? (
        <div class="site-form">
          <label class="field">
            <span>Name</span>
            <input type="text" value={trName} onInput={(e) => setTrName((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Site (hostname, subdomains included)</span>
            <input type="text" placeholder="jira.example.com" value={trHost} onInput={(e) => setTrHost((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Run</span>
            <select value={trTargetKind} onChange={(e) => { setTrTargetKind((e.target as HTMLSelectElement).value as 'skill' | 'workflow'); setTrTargetValue(''); }}>
              <option value="skill">A skill</option>
              <option value="workflow">A workflow</option>
            </select>
          </label>
          {trTargetKind === 'skill' ? (
            <label class="field">
              <span>Skill</span>
              <select value={trTargetValue} onChange={(e) => setTrTargetValue((e.target as HTMLSelectElement).value)}>
                <option value="">Choose a skill…</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.name}>/{s.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <label class="field">
              <span>Workflow</span>
              <select value={trTargetValue} onChange={(e) => setTrTargetValue((e.target as HTMLSelectElement).value)}>
                <option value="">Choose a workflow…</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </label>
          )}
          <label class="field">
            <span>Cooldown minutes (optional, default 60)</span>
            <input type="number" min="1" placeholder="60" value={trCooldown} onInput={(e) => setTrCooldown((e.target as HTMLInputElement).value)} />
          </label>
          {trError && <div class="banner banner-error">{trError}</div>}
          <div class="settings-actions">
            <button class="btn" onClick={() => setShowTriggerForm(false)}>Cancel</button>
            <button class="btn btn-primary" onClick={createTrigger} disabled={!trName.trim() || !trHost.trim()}>Create trigger</button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowTriggerForm(true)}>Add trigger</button>
        </div>
      )}
      {recentTriggerRuns.length > 0 && (
        <>
          <p class="settings-note">Recent trigger runs</p>
          <ul class="sites-list ws-run-list">
            {recentTriggerRuns.map((r) => (
              <li key={r.id} class="ws-run-item">
                <div class="ws-run-header">
                  <span class="site-name">{triggers.find((t) => t.id === r.triggerId)?.name ?? '(deleted trigger)'}</span>
                  <span class="site-desc">{fmt(r.startedAt)} — {STATUS_LABEL[r.status] ?? r.status} ({r.url})</span>
                </div>
                {(r.summary || r.error) && <p class="ws-run-detail">{r.error ?? r.summary}</p>}
                {r.fileArtifactNames && r.fileArtifactNames.length > 0 && (
                  <p class="ws-run-detail ws-dim">📎 Saved to Downloads: {r.fileArtifactNames.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
