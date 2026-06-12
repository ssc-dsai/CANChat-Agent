import type { PlanStepStatus, PlanView } from '../shared/types';

const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  in_progress: '»',
  done: '✓',
  skipped: '–',
};

export function PlanPanel({ plan }: { plan: PlanView | null }) {
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return (
    <div class="plan-panel">
      <div class="plan-header">
        Plan ({done}/{plan.steps.length})
      </div>
      <ul class="plan-list">
        {plan.steps.map((s, i) => (
          <li key={i} class={`plan-step plan-${s.status}`}>
            <span class="plan-icon">{STATUS_ICON[s.status]}</span>
            <span class="plan-text">{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
