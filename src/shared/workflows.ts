// =============================================================================
// Workflows — a named, ordered chain of existing skills. Pure logic only (no
// chrome.*); background/automation.ts owns storage, agentRuntime.ts's existing
// use_skill tool does the actual per-skill work. A workflow is not a new
// execution engine: running one just tells the model, in plain language, to
// work through the named skills in order via the tool it already has.
// =============================================================================

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  /** Skill /names, in run order. Must be non-empty to be runnable. */
  skillNames: string[];
  createdAt: string;
}

/**
 * Build the task prompt for running a workflow: an explicit instruction to
 * call the existing `use_skill` tool once per named skill, in order,
 * finishing one before starting the next. Deliberately prose (not a new
 * tool/parameter) so it flows through the exact same approval-gated loop as
 * any other task — a workflow adds no new capability, only a saved shortcut
 * for "do these skills in this order."
 */
export function buildWorkflowPrompt(workflow: Workflow): string {
  const steps = workflow.skillNames.map((name, i) => `${i + 1}. Call use_skill for "${name}" and fully follow its instructions before moving on.`);
  return (
    `Run the "${workflow.name}" workflow: complete these steps in order, one at a time:\n` +
    steps.join('\n')
  );
}
