// Skill helpers for the add-in. Skills are reused as *instruction templates*:
// their body is injected as guidance for the model. Many skill bodies were
// written to drive the browser (list_tabs, navigate, …) — those tools don't
// exist in Word, so we flag such skills so the UI can say so honestly.

import type { Skill } from '../../src/shared/types';

const BROWSER_TOOLS =
  /\b(list_tabs|get_active_tab|get_tab_content|get_all_tab_contents|navigate|open_url|search_web|read_tab_group|get_element_map|click_element|fill_input|submit_form|press_keys|click_at|drag|scroll_wheel|run_javascript|capture_full_page|sharepoint_search)\b/;

/** True if the skill's body relies on browser tools the add-in can't provide. */
export function isBrowserSkill(skill: Skill): boolean {
  return BROWSER_TOOLS.test(skill.body);
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

/** Parse a leading `/name rest…` command out of the input, if present. */
export function parseSlashCommand(input: string): { name: string; rest: string } | null {
  const m = /^\/([a-z0-9-]+)\s*([\s\S]*)$/i.exec(input.trim());
  return m ? { name: m[1].toLowerCase(), rest: m[2].trim() } : null;
}

/** Parse a leading/anywhere `#repo` mention, returning the repo token. */
export function parseRepoMention(input: string): string | null {
  const m = /(?:^|\s)#([^\s#]+)/.exec(input);
  return m ? m[1] : null;
}
