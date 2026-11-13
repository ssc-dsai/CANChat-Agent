// =============================================================================
// Canonical tool-name registry. Every tool name the agent can call is declared
// here exactly once, and `TOOL_DEFINITIONS` (schemas.ts), the policy tables
// (policy.ts), and the availability Sets (sourcePolicy.ts, scopedSubtask.ts,
// researchJob.ts) all reference these values. That makes this the single source
// of truth for the stringly-typed tool names: a name can no longer drift between
// the catalogue, the risk table, and the read-only/external-source lists, and a
// typo in any of them is a compile error instead of a silent runtime miss.
//
// The values are the exact strings the model sends and the dispatch switch in
// agentRuntime matches, so they must stay byte-for-byte stable.
// =============================================================================

export const TOOL_NAMES = {
  // --- persistent memory (only offered when the user enables memory) -------
  save_memory: 'save_memory',
  update_memory: 'update_memory',
  delete_memory: 'delete_memory',

  // --- tab / page inspection ------------------------------------------------
  list_tabs: 'list_tabs',
  get_active_tab: 'get_active_tab',
  get_tab_content: 'get_tab_content',
  read_app_content: 'read_app_content',
  capture_full_page: 'capture_full_page',
  get_all_tab_contents: 'get_all_tab_contents',
  navigate: 'navigate',
  open_url: 'open_url',
  read_tab_group: 'read_tab_group',

  // --- delegation / research ------------------------------------------------
  run_subtasks: 'run_subtasks',
  search_web: 'search_web',
  start_research_job: 'start_research_job',
  request_web_fallback: 'request_web_fallback',

  // --- element map / pointer / page interaction -----------------------------
  get_element_map: 'get_element_map',
  query_pointer_target: 'query_pointer_target',
  click_element: 'click_element',
  fill_input: 'fill_input',
  submit_form: 'submit_form',
  press_keys: 'press_keys',
  wait_for_element: 'wait_for_element',
  click_at: 'click_at',
  drag: 'drag',
  scroll_wheel: 'scroll_wheel',
  wait_for_page_state: 'wait_for_page_state',
  detect_auth_state: 'detect_auth_state',
  run_javascript: 'run_javascript',

  // --- local knowledge base / repository ------------------------------------
  add_to_repo: 'add_to_repo',
  search_repo: 'search_repo',
  search_graph: 'search_graph',
  global_search: 'global_search',
  list_repos: 'list_repos',
  use_skill: 'use_skill',

  // --- external / enterprise sources ----------------------------------------
  sharepoint_search: 'sharepoint_search',
  microsoft365_search: 'microsoft365_search',
  calendar_search: 'calendar_search',
  draft_email: 'draft_email',
  list_mcp_tools: 'list_mcp_tools',
  call_mcp_tool: 'call_mcp_tool',
  list_webmcp_tools: 'list_webmcp_tools',
  call_webmcp_tool: 'call_webmcp_tool',

  // --- scheduling / skills / playbooks --------------------------------------
  schedule_task: 'schedule_task',
  list_scheduled_tasks: 'list_scheduled_tasks',
  cancel_scheduled_task: 'cancel_scheduled_task',
  save_as_skill: 'save_as_skill',
  save_app_playbook: 'save_app_playbook',
  search_known_sites: 'search_known_sites',

  // --- planning / findings / export -----------------------------------------
  set_plan: 'set_plan',
  update_plan: 'update_plan',
  record_finding: 'record_finding',
  export_data: 'export_data',
  create_file: 'create_file',
  create_image: 'create_image',
  create_word_document: 'create_word_document',
  create_powerpoint: 'create_powerpoint',

  // --- document readers -----------------------------------------------------
  read_pdf: 'read_pdf',
  read_office_document: 'read_office_document',
  get_video_transcript: 'get_video_transcript',
} as const;

/** Union of every valid tool name, derived from the registry above. */
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
