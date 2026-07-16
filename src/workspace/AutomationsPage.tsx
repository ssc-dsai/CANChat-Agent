import { useEffect, useState } from 'preact/hooks';
import type { EventTrigger, TriggerRun } from '../shared/eventTriggers';
import type { ScheduledRun, ScheduledTask } from '../shared/scheduledTasks';
import type { Skill } from '../shared/types';
import type { Workflow } from '../shared/workflows';
import { useT } from '../sidebar/i18n';

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
  const t = useT();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskRuns, setTaskRuns] = useState<ScheduledRun[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [triggers, setTriggers] = useState<EventTrigger[]>([]);
  const [triggerRuns, setTriggerRuns] = useState<TriggerRun[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  const [showWorkflowForm, setShowWorkflowForm] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [wfName, setWfName] = useState('');
  const [wfDescription, setWfDescription] = useState('');
  const [wfSkills, setWfSkills] = useState('');
  const [wfError, setWfError] = useState<string | null>(null);

  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [trName, setTrName] = useState('');
  const [trHost, setTrHost] = useState('');
  const [trTargetKind, setTrTargetKind] = useState<'skill' | 'workflow'>('skill');
  const [trTargetValue, setTrTargetValue] = useState('');
  const [trCooldown, setTrCooldown] = useState('');
  const [trMatchSubPages, setTrMatchSubPages] = useState(true);
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
    const req = editingWorkflowId
      ? {
          type: 'workflow_update' as const,
          id: editingWorkflowId,
          patch: { name: wfName, description: wfDescription || undefined, skillNames },
        }
      : {
          type: 'workflow_create' as const,
          name: wfName,
          description: wfDescription || undefined,
          skillNames,
        };
    const res = (await chrome.runtime.sendMessage(req)) as { ok: boolean; error?: string };
    if (!res.ok) {
      setWfError(res.error ?? 'Could not create workflow.');
      return;
    }
    setWfName('');
    setWfDescription('');
    setWfSkills('');
    setShowWorkflowForm(false);
    setEditingWorkflowId(null);
    reload();
  };
  const deleteWorkflow = async (id: string) => {
    await chrome.runtime.sendMessage({ type: 'workflow_delete', id });
    reload();
  };
  const editWorkflow = (w: Workflow) => {
    setWfError(null);
    setEditingWorkflowId(w.id);
    setWfName(w.name);
    setWfDescription(w.description ?? '');
    setWfSkills(w.skillNames.join(', '));
    setShowWorkflowForm(true);
  };
  const newWorkflow = () => {
    setWfError(null);
    setEditingWorkflowId(null);
    setWfName('');
    setWfDescription('');
    setWfSkills('');
    setShowWorkflowForm(true);
  };

  const createTrigger = async () => {
    setTrError(null);
    if (!trTargetValue.trim()) {
      setTrError(trTargetKind === 'skill' ? 'Pick a skill.' : 'Pick a workflow.');
      return;
    }
    const target = trTargetKind === 'skill' ? { kind: 'skill' as const, name: trTargetValue } : { kind: 'workflow' as const, workflowId: trTargetValue };
    const cooldownMinutes = trCooldown.trim() ? Number(trCooldown) : undefined;
    const req = editingTriggerId
      ? {
          type: 'event_trigger_update' as const,
          id: editingTriggerId,
          patch: { name: trName, hostPattern: trHost, matchSubPages: trMatchSubPages, target, cooldownMinutes },
        }
      : {
          type: 'event_trigger_create' as const,
          name: trName,
          hostPattern: trHost,
          matchSubPages: trMatchSubPages,
          target,
          cooldownMinutes,
        };
    const res = (await chrome.runtime.sendMessage(req)) as { ok: boolean; error?: string };
    if (!res.ok) {
      setTrError(res.error ?? 'Could not create trigger.');
      return;
    }
    setTrName('');
    setTrHost('');
    setTrTargetValue('');
    setTrCooldown('');
    setTrMatchSubPages(true);
    setShowTriggerForm(false);
    setEditingTriggerId(null);
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
  const editTrigger = (t: EventTrigger) => {
    setTrError(null);
    setEditingTriggerId(t.id);
    setTrName(t.name);
    setTrHost(t.hostPattern);
    setTrTargetKind(t.target.kind);
    setTrTargetValue(t.target.kind === 'skill' ? t.target.name : t.target.workflowId);
    setTrCooldown(t.cooldownMinutes ? String(t.cooldownMinutes) : '');
    setTrMatchSubPages(t.matchSubPages ?? true);
    setShowTriggerForm(true);
  };
  const newTrigger = () => {
    setTrError(null);
    setEditingTriggerId(null);
    setTrName('');
    setTrHost('');
    setTrTargetKind('skill');
    setTrTargetValue('');
    setTrCooldown('');
    setTrMatchSubPages(true);
    setShowTriggerForm(true);
  };

  const workflowName = (id: string) => workflows.find((w) => w.id === id)?.name ?? t('automations.deletedWorkflow');
  const targetLabel = (t: EventTrigger) => (t.target.kind === 'skill' ? `/${t.target.name}` : workflowName(t.target.workflowId));

  const recentTaskRuns = [...taskRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);
  const recentTriggerRuns = [...triggerRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);

  return (
    <div class="ws-automations-page">
      <h2>{t('automations.title')}</h2>
      <p class="settings-note">{t('automations.note')}</p>

      <details class="settings-acc" open>
        <summary class="settings-acc-summary">
          <strong>{t('automations.scheduledTasks')}</strong>
        </summary>
        <p class="settings-note">{t('automations.scheduledTasksNote')}</p>
        {tasks.length === 0 ? (
          <p class="settings-note">{t('automations.noneYet')}</p>
        ) : (
          <ul class="sites-list">
            {tasks.map((task) => (
              <li key={task.id} class="site-row" title={task.prompt}>
                <span class={`approval-tag trust-badge ${task.enabled ? 'trust-local' : 'trust-public'}`}>{task.enabled ? t('automations.enabled') : t('automations.paused')}</span>
                <span class="site-name">{task.title}</span>
                <span class="site-desc">
                  {t('automations.next')}: {fmt(task.enabled ? task.nextRunAt : undefined)} · {t('automations.last')}: {fmt(task.lastRunAt)}
                  {task.lastStatus ? ` (${STATUS_LABEL[task.lastStatus] ?? task.lastStatus})` : ''}
                </span>
                <button class="btn btn-small" onClick={() => toggleTask(task.id, !task.enabled)}>{task.enabled ? t('automations.pause') : t('automations.resume')}</button>
                <button class="icon-btn" title={t('automations.delete')} onClick={() => deleteTask(task.id)}>✕</button>
              </li>
            ))}
          </ul>
        )}
        {recentTaskRuns.length > 0 && (
          <>
            <p class="settings-note">{t('automations.recentRuns')}</p>
            <ul class="sites-list ws-run-list">
              {recentTaskRuns.map((r) => (
                <li key={r.id} class="ws-run-item">
                  <div class="ws-run-header">
                    <span class="site-name">{tasks.find((t) => t.id === r.taskId)?.title ?? t('automations.deletedWorkflow')}</span>
                    <span class="site-desc">{fmt(r.startedAt)} — {STATUS_LABEL[r.status] ?? r.status}</span>
                  </div>
                  {(r.summary || r.error) && <p class="ws-run-detail">{r.error ?? r.summary}</p>}
                    {r.fileArtifactNames && r.fileArtifactNames.length > 0 && (
                     <p class="ws-run-detail ws-dim">📎 {t('automations.savedToProducts')}: {r.fileArtifactNames.join(', ')}</p>
                   )}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>

      <details class="settings-acc">
        <summary class="settings-acc-summary">
          <strong>{t('automations.workflows')}</strong>
        </summary>
        <p class="settings-note">{t('automations.workflowsNote')}</p>
        {workflows.length > 0 && (
          <ul class="sites-list">
            {workflows.map((w) => (
              <li key={w.id} class="site-row" title={w.description}>
                <span class="site-name">{w.name}</span>
                <span class="site-desc">{w.skillNames.map((n) => `/${n}`).join(' → ')}</span>
                <button class="icon-btn" title={t('automations.edit')} onClick={() => editWorkflow(w)}>✎</button>
                <button class="icon-btn" title={t('automations.delete')} onClick={() => deleteWorkflow(w.id)}>✕</button>
              </li>
            ))}
          </ul>
        )}
        {showWorkflowForm ? (
          <div class="site-form">
            <label class="field">
              <span>{t('automations.workflowName')}</span>
              <input type="text" value={wfName} onInput={(e) => setWfName((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>{t('automations.workflowDescription')}</span>
              <input type="text" value={wfDescription} onInput={(e) => setWfDescription((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>{t('automations.workflowSkills')} — {t('automations.workflowSkillsKnown').replace('{skills}', skills.map((s) => s.name).join(', ') || t('automations.workflowSkillsNone'))}</span>
              <input type="text" placeholder="research, search-mail" value={wfSkills} onInput={(e) => setWfSkills((e.target as HTMLInputElement).value)} />
            </label>
            {wfError && <div class="banner banner-error">{wfError}</div>}
            <div class="settings-actions">
              <button
                class="btn"
                onClick={() => {
                  setShowWorkflowForm(false);
                  setEditingWorkflowId(null);
                  setWfError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button class="btn btn-primary" onClick={createWorkflow} disabled={!wfName.trim() || !wfSkills.trim()}>
                {editingWorkflowId ? t('automations.updateWorkflow') : t('automations.createWorkflow')}
              </button>
            </div>
          </div>
        ) : (
          <div class="context-actions">
            <button class="btn btn-small" onClick={newWorkflow}>{t('automations.addWorkflow')}</button>
          </div>
        )}
      </details>

      <details class="settings-acc">
        <summary class="settings-acc-summary">
          <strong>{t('automations.eventTriggers')}</strong>
        </summary>
        <p class="settings-note">{t('automations.eventTriggersNote')}</p>
        {triggers.length > 0 && (
          <ul class="sites-list">
            {triggers.map((trigger) => (
              <li key={trigger.id} class="site-row">
                <span class={`approval-tag trust-badge ${trigger.enabled ? 'trust-local' : 'trust-public'}`}>{trigger.enabled ? t('automations.enabled') : t('automations.paused')}</span>
                <span class="site-name">{trigger.name}</span>
                <span class="site-desc">
                  {trigger.hostPattern} → {targetLabel(trigger)} · {trigger.matchSubPages ? t('automations.allPages') : t('automations.cooldown')} · {t('automations.cooldown')}: {trigger.cooldownMinutes ?? 60}min · {t('automations.last')} fired {fmt(trigger.lastFiredAt)}
                </span>
                <button class="icon-btn" title={t('automations.edit')} onClick={() => editTrigger(trigger)}>✎</button>
                <button class="btn btn-small" onClick={() => toggleTrigger(trigger.id, !trigger.enabled)}>{trigger.enabled ? t('automations.pause') : t('automations.resume')}</button>
                <button class="icon-btn" title={t('automations.delete')} onClick={() => deleteTrigger(trigger.id)}>✕</button>
              </li>
            ))}
          </ul>
        )}
        {showTriggerForm ? (
          <div class="site-form">
            <label class="field">
              <span>{t('automations.triggerName')}</span>
              <input type="text" value={trName} onInput={(e) => setTrName((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>{t('automations.triggerSite')}</span>
              <input type="text" placeholder="jira.example.com" value={trHost} onInput={(e) => setTrHost((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>{t('automations.triggerRun')}</span>
              <select value={trTargetKind} onChange={(e) => { setTrTargetKind((e.target as HTMLSelectElement).value as 'skill' | 'workflow'); setTrTargetValue(''); }}>
                <option value="skill">{t('automations.triggerSkill')}</option>
                <option value="workflow">{t('automations.triggerWorkflow')}</option>
              </select>
            </label>
            {trTargetKind === 'skill' ? (
              <label class="field">
                <span>{t('automations.triggerSkill')}</span>
                <select value={trTargetValue} onChange={(e) => setTrTargetValue((e.target as HTMLSelectElement).value)}>
                  <option value="">{t('automations.chooseSkill')}</option>
                  {skills.map((s) => (
                    <option key={s.id} value={s.name}>/{s.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label class="field">
                <span>{t('automations.triggerWorkflow')}</span>
                <select value={trTargetValue} onChange={(e) => setTrTargetValue((e.target as HTMLSelectElement).value)}>
                  <option value="">{t('automations.chooseWorkflow')}</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </label>
            )}
            <label class="field">
              <span>{t('automations.cooldownMinutes')}</span>
              <input type="number" min="1" placeholder="60" value={trCooldown} onInput={(e) => setTrCooldown((e.target as HTMLInputElement).value)} />
            </label>
            <label class="toggle-row">
              <input
                type="checkbox"
                checked={trMatchSubPages}
                onChange={(e) => setTrMatchSubPages((e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-text">
                <span class="toggle-label">{t('automations.fireEveryPage')}</span>
                <span class="toggle-note">{t('automations.fireEveryPageNote')}</span>
              </span>
            </label>
            {trError && <div class="banner banner-error">{trError}</div>}
            <div class="settings-actions">
              <button
                class="btn"
                onClick={() => {
                  setShowTriggerForm(false);
                  setEditingTriggerId(null);
                  setTrError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button class="btn btn-primary" onClick={createTrigger} disabled={!trName.trim() || !trHost.trim()}>
                {editingTriggerId ? t('automations.updateTrigger') : t('automations.createTrigger')}
              </button>
            </div>
          </div>
        ) : (
          <div class="context-actions">
            <button class="btn btn-small" onClick={newTrigger}>{t('automations.addTrigger')}</button>
          </div>
        )}
        {recentTriggerRuns.length > 0 && (
          <>
            <p class="settings-note">{t('automations.recentRuns')}</p>
            <ul class="sites-list ws-run-list">
              {recentTriggerRuns.map((r) => (
                <li key={r.id} class="ws-run-item">
                  <div class="ws-run-header">
                    <span class="site-name">{triggers.find((t) => t.id === r.triggerId)?.name ?? t('automations.deletedTrigger')}</span>
                    <span class="site-desc">{fmt(r.startedAt)} — {STATUS_LABEL[r.status] ?? r.status} ({r.url})</span>
                  </div>
                  {(r.summary || r.error) && <p class="ws-run-detail">{r.error ?? r.summary}</p>}
                  {r.fileArtifactNames && r.fileArtifactNames.length > 0 && (
                      <p class="ws-run-detail ws-dim">📎 {t('automations.savedToProducts')}: {r.fileArtifactNames.join(', ')}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}
