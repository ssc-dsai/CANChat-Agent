import type { Skill } from './types';

/**
 * Curated, opt-in app playbooks ("skill class families"). These are not
 * installed automatically — the user adds them from Settings → Skills, after
 * which they become ordinary origin-bound skills that auto-activate on the site.
 */
export type CuratedPlaybook = Pick<Skill, 'origin' | 'name' | 'description' | 'body'>;

export const CURATED_PLAYBOOKS: CuratedPlaybook[] = [
  {
    origin: 'outlook.office.com',
    name: 'outlook-owa',
    description: 'Outlook on the web: read, search, compose, and send mail.',
    body: [
      'Outlook Web App (OWA). It is a keyboard-driven app; prefer press_keys for its shortcuts.',
      '- Compose: press_keys "n" (or "c") to open a new message. Wait for the compose form with wait_for_element on the To/subject fields.',
      '- Address/subject/body: get_element_map then fill_input on the To, Subject, and body fields. The compose surface may be in a same-origin iframe — get_element_map now sees into it.',
      '- Send: press_keys "Control+Enter".',
      '- Search: focus the search box (press_keys "/" often focuses it) or fill_input the search field, then press_keys "Enter".',
      '- Navigate the message list with ArrowUp/ArrowDown; open with Enter.',
      'Reading mail: use get_tab_content on the reading pane; for structured fields not in the DOM text, try run_javascript.',
    ].join('\n'),
  },
  {
    origin: 'outlook.live.com',
    name: 'outlook-live',
    description: 'Outlook.com (personal): read, search, compose, and send mail.',
    body: [
      'Personal Outlook.com — same app family as OWA. Keyboard-driven; prefer press_keys.',
      '- New message: press_keys "n". Send: press_keys "Control+Enter".',
      '- Fill To/Subject/body via get_element_map + fill_input (compose may be in a same-origin iframe).',
      '- Search: fill_input the search box then press_keys "Enter".',
    ].join('\n'),
  },
  {
    origin: 'mail.google.com',
    name: 'gmail',
    description: 'Gmail: compose, send, search, and triage mail with keyboard shortcuts.',
    body: [
      'Gmail. Keyboard shortcuts must be enabled in Gmail settings; if a shortcut does nothing, fall back to clicking.',
      '- Compose: press_keys "c". Send: press_keys "Control+Enter".',
      '- In compose, fill_input the To, Subject, and body fields found via get_element_map.',
      '- Search: fill_input the search box at the top, then press_keys "Enter".',
      '- Open a thread with Enter; archive with "e"; back to inbox with "u".',
    ].join('\n'),
  },
  {
    origin: 'marinetraffic.com',
    name: 'marinetraffic-map',
    description: 'MarineTraffic: drive the live ship-tracking map and read vessel data.',
    body: [
      'MarineTraffic is primarily an interactive map. Prefer driving the map object directly with run_javascript over simulating gestures.',
      '1. Find the map instance with run_javascript: probe for a Leaflet/Mapbox/MapLibre/OpenLayers object on window or on the map container element (look for methods setView/flyTo/getCenter/getZoom). Save what you find in the playbook.',
      '2. Recenter/zoom: call the map object, e.g. map.setView([lat, lng], zoom) or map.flyTo(...). This is more reliable than dragging.',
      '3. If no JS handle is reachable, fall back to coordinate gestures over the map canvas: drag to pan, scroll_wheel (negative deltaY) to zoom in. Use element rects from get_element_map to pick coordinates inside the map.',
      '4. Search for a vessel/port: fill_input the search box, press_keys "Enter", then read results from the DOM or the page state.',
      '5. Reading vessel details: open the detail panel and use get_tab_content, or pull from the app\'s JS state via run_javascript.',
    ].join('\n'),
  },
  {
    origin: 'atlassian.net',
    name: 'jira-cloud',
    description: 'Jira Cloud: search issues with JQL and read ticket details.',
    body: [
      'Jira Cloud (your-domain.atlassian.net).',
      '- Quick search: press_keys "/" to focus search, type the query, press_keys "Enter".',
      '- Direct JQL: navigate to /issues/?jql=<encoded JQL> for precise queries (e.g. created >= -7d ORDER BY created DESC).',
      '- Create issue: press_keys "c".',
      '- Read an issue: get_tab_content on the issue view; fields like status, assignee, and labels are in the DOM.',
      '- Boards can lazy-load; use wait_for_element before scraping the card list.',
    ].join('\n'),
  },
];
