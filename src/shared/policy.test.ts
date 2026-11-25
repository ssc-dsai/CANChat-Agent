import { describe, expect, it } from 'vitest';
import {
  classifyTool,
  evaluatePolicy,
  isApprovalStillValid,
  sessionApprovalKey,
  TOOL_ACTION_CLASS,
  type ActionClass,
  type PolicyInput,
} from './policy';
import { MEMORY_TOOL_DEFINITIONS, READ_ONLY_TOOLS, TOOL_DEFINITIONS } from './schemas';

const EMPTY = new Set<string>();
const READ_ONLY = new Set(['get_tab_content', 'list_tabs']);

function base(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tool: 'x',
    actionClass: 'read',
    attended: true,
    sessionApprovedTools: EMPTY,
    ...overrides,
  };
}

describe('evaluatePolicy — attended', () => {
  it('allows plain reads', () => {
    expect(evaluatePolicy(base({ actionClass: 'read' })).kind).toBe('allow');
  });

  it('allows low-risk writes with no prompt (visible indication is a UI concern)', () => {
    expect(evaluatePolicy(base({ actionClass: 'low_risk_write' })).kind).toBe('allow');
  });

  it.each<ActionClass>(['external_comms', 'record_modification', 'destructive'])(
    'requires approval for %s',
    (cls) => {
      const d = evaluatePolicy(base({ actionClass: cls }));
      expect(d.kind).toBe('needs_approval');
    },
  );

  it('always denies financial/legal, even attended', () => {
    const d = evaluatePolicy(base({ actionClass: 'financial_legal' }));
    expect(d).toEqual({ kind: 'deny', rule: 'financial_legal_disabled' });
  });

  it('escalates a read from a low-trust capability to approval', () => {
    const d = evaluatePolicy(base({ actionClass: 'read', capabilityKind: 'mcp', trustLevel: 'public' }));
    expect(d.kind).toBe('needs_approval');
  });

  it('auto-allows a read from an enterprise-trust capability', () => {
    const d = evaluatePolicy(base({ actionClass: 'read', capabilityKind: 'mcp', trustLevel: 'enterprise' }));
    expect(d.kind).toBe('allow');
  });
});

describe('evaluatePolicy — session approval short-circuit', () => {
  const onA = 'submit_form@https://a.example';

  it('allows a tool session-approved on the same site', () => {
    const d = evaluatePolicy(base({ tool: 'submit_form', actionClass: 'external_comms', sessionApprovedTools: new Set([onA]), sessionApprovalKey: onA }));
    expect(d.kind).toBe('allow');
  });

  it('does NOT carry a session approval to another site', () => {
    const d = evaluatePolicy(base({
      tool: 'submit_form', actionClass: 'external_comms', sessionApprovedTools: new Set([onA]),
      sessionApprovalKey: 'submit_form@https://b.example',
    }));
    expect(d.kind).toBe('needs_approval');
  });

  it('does NOT honour a bare tool-name approval for a call with no key', () => {
    const d = evaluatePolicy(base({ tool: 'submit_form', actionClass: 'external_comms', sessionApprovedTools: new Set(['submit_form']) }));
    expect(d.kind).toBe('needs_approval');
  });

  it('does NOT carry an MCP approval to another server or method', () => {
    const approved = new Set([sessionApprovalKey('call_mcp_tool', { mcpServer: 'Jira', mcpMethod: 'search' })!]);
    const call = (server: string, method: string) => evaluatePolicy(base({
      tool: 'call_mcp_tool', actionClass: 'external_comms', sessionApprovedTools: approved,
      sessionApprovalKey: sessionApprovalKey('call_mcp_tool', { mcpServer: server, mcpMethod: method }),
    })).kind;
    expect(call('jira', 'search')).toBe('allow');
    expect(call('evil', 'search')).toBe('needs_approval');
    expect(call('jira', 'delete_issue')).toBe('needs_approval');
  });

  it('does NOT let session approval cover destructive actions', () => {
    const key = 'run_javascript@https://a.example';
    const d = evaluatePolicy(base({ tool: 'run_javascript', actionClass: 'destructive', sessionApprovedTools: new Set([key]), sessionApprovalKey: key }));
    expect(d.kind).toBe('needs_approval');
  });

  it('does NOT let session approval cover financial/legal', () => {
    const d = evaluatePolicy(base({ tool: 'pay', actionClass: 'financial_legal', sessionApprovedTools: new Set(['pay']), sessionApprovalKey: 'pay' }));
    expect(d.kind).toBe('deny');
  });
});

describe('sessionApprovalKey', () => {
  it('pins page tools to the site and refuses an unresolved tab', () => {
    expect(sessionApprovalKey('click_element', { origin: 'https://a.example', tabScoped: true })).toBe('click_element@https://a.example');
    expect(sessionApprovalKey('click_element', { tabScoped: true })).toBeUndefined();
  });

  it('pins MCP calls to server and method, case-insensitive on the server', () => {
    expect(sessionApprovalKey('call_mcp_tool', { mcpServer: ' Jira ', mcpMethod: 'search' })).toBe('call_mcp_tool@mcp:jira#search');
    expect(sessionApprovalKey('call_mcp_tool', { mcpServer: '' })).toBeUndefined();
  });

  it('falls back to the tool for tools with no site or server', () => {
    expect(sessionApprovalKey('draft_email', {})).toBe('draft_email');
  });
});

describe('evaluatePolicy — unattended', () => {
  it('allows a plain read', () => {
    expect(evaluatePolicy(base({ attended: false, actionClass: 'read' })).kind).toBe('allow');
  });

  it('denies any non-read action', () => {
    const d = evaluatePolicy(base({ attended: false, actionClass: 'external_comms' }));
    expect(d).toEqual({ kind: 'deny', rule: 'unattended_requires_approval' });
  });

  it('denies an unattended-blocked tool even if read', () => {
    const d = evaluatePolicy(base({ attended: false, actionClass: 'read', tool: 'x', unattendedBlockedTools: new Set(['x']) }));
    expect(d).toEqual({ kind: 'deny', rule: 'unattended_blocked' });
  });

  it('denies a low-trust capability read (cannot prompt when unattended)', () => {
    const d = evaluatePolicy(base({ attended: false, actionClass: 'read', capabilityKind: 'mcp', trustLevel: 'public' }));
    expect(d).toEqual({ kind: 'deny', rule: 'unattended_low_trust_capability' });
  });
});

describe('classifyTool', () => {
  it('uses the explicit table where present', () => {
    expect(classifyTool('submit_form', READ_ONLY)).toBe('external_comms');
    expect(classifyTool('run_javascript', READ_ONLY)).toBe('destructive');
  });

  it('gates fill_input: a page can read a field as it is typed into', () => {
    expect(classifyTool('fill_input', READ_ONLY)).toBe('external_comms');
  });

  it('falls back to read for known read-only tools', () => {
    expect(classifyTool('list_tabs', READ_ONLY)).toBe('read');
  });

  it('falls back to external_comms (asks) for unknown tools', () => {
    expect(classifyTool('some_new_tool', READ_ONLY)).toBe('external_comms');
  });

  it('does NOT gate navigation/read tools (regression: open_url etc. must not prompt)', () => {
    for (const tool of ['open_url', 'navigate', 'search_web', 'scroll_wheel', 'wait_for_page_state', 'capture_full_page', 'run_subtasks']) {
      const d = evaluatePolicy(base({ tool, actionClass: classifyTool(tool, READ_ONLY) }));
      expect(d.kind, `${tool} should be allowed without approval`).toBe('allow');
    }
  });

  it('treats local-only writes (memory, repo ingest, file gen) as low-risk, no prompt', () => {
    for (const tool of ['add_to_repo', 'save_memory', 'update_memory', 'delete_memory', 'create_powerpoint']) {
      const d = evaluatePolicy(base({ tool, actionClass: classifyTool(tool, READ_ONLY) }));
      expect(d.kind, `${tool} should be allowed without approval`).toBe('allow');
    }
  });

  it('never classifies a page-mutating tool as read', () => {
    for (const [tool, cls] of Object.entries(TOOL_ACTION_CLASS)) {
      if (cls === 'read') expect(tool).not.toMatch(/submit|click|run_javascript|drag|press_keys/);
    }
  });
});

describe('isApprovalStillValid — approval binding', () => {
  it('rejects an approval granted after expiry', () => {
    expect(isApprovalStillValid(1000, 1001)).toBe(false);
  });
  it('accepts an approval granted before expiry', () => {
    expect(isApprovalStillValid(1000, 999)).toBe(true);
  });
  it('treats an unbound (undefined) expiry as valid', () => {
    expect(isApprovalStillValid(undefined, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Coverage guard: every advertised tool must be *deliberately* classified.
//
// classifyTool resolves a tool as TOOL_ACTION_CLASS[tool] ?? (READ_ONLY_TOOLS
// ? 'read' : 'external_comms'). A tool that is in NEITHER table silently rides
// that last default to `external_comms`, which means it prompts the user for
// approval — the exact over-gating regression that made `open_url` ask for
// permission. This test fails the build the moment a new tool is added to
// TOOL_DEFINITIONS without a risk class, turning a silent runtime UX regression
// into a loud, one-line-to-fix CI failure. It asserts nothing about *which*
// class is correct — only that a human made a deliberate choice for every tool.
// -----------------------------------------------------------------------------
describe('tool classification coverage', () => {
  const advertisedTools = [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS].map((t) => t.function.name);

  it('advertises at least the known core tools (guards against an empty catalogue)', () => {
    expect(advertisedTools).toContain('open_url');
    expect(advertisedTools.length).toBeGreaterThan(20);
  });

  it('classifies every advertised tool explicitly (TOOL_ACTION_CLASS or READ_ONLY_TOOLS)', () => {
    const unclassified = advertisedTools.filter(
      (tool) => !(tool in TOOL_ACTION_CLASS) && !READ_ONLY_TOOLS.has(tool),
    );
    // If this fails: add the tool to TOOL_ACTION_CLASS with its risk class, or to
    // READ_ONLY_TOOLS if it has no state-changing/outward-facing effect. Leaving
    // it unlisted makes it silently prompt for approval (external_comms default).
    expect(unclassified, `unclassified tools would default to external_comms: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('has no TOOL_ACTION_CLASS entry for a tool that is not advertised (stale entry)', () => {
    // Reverse guard: an entry for a tool no longer in the catalogue is dead
    // config. `microsoft365_search` is intentionally allowed — it is a
    // capability-sourced tool classified ahead of being advertised.
    const advertised = new Set(advertisedTools);
    const stale = Object.keys(TOOL_ACTION_CLASS).filter(
      (tool) => !advertised.has(tool) && tool !== 'microsoft365_search',
    );
    expect(stale, `stale TOOL_ACTION_CLASS entries: ${stale.join(', ')}`).toEqual([]);
  });
});
