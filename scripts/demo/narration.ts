// The demo's narration — single source of truth for BOTH the TTS voiceover and
// the generated docs/demo/SCRIPT.md.
//
// Narration is written in BEATS, each anchored to a named checkpoint that the
// scene emits with mark() at the exact moment the narrated thing appears on
// screen. record.ts cuts the scene's footage at those marks and pads each
// chunk to its beat's audio length — so a sentence starts when its action
// starts, and the video holds (never mid-action) when a sentence outruns the
// screen. Every beat must describe ONLY what is visible from its mark onward;
// write narration and scene code as a pair.
//
// The first beat of every scene is anchored at 'start' (scene time zero).

export interface Beat {
  mark: string;
  text: string;
}

export interface SceneDef {
  id: string;
  title: string;
  /** What the viewer sees — used for the SCRIPT.md action column. */
  action: string;
  beats: Beat[];
}

export const SCENES: SceneDef[] = [
  {
    id: 'title',
    title: 'Title card',
    action: 'Branded title card.',
    beats: [
      {
        mark: 'start',
        text:
          'CANChat Agent is an A I agent that lives in your browser’s side panel — and uses the browser itself as its toolset. Over the next few minutes we’ll set it up from scratch, on real pages, and walk through every major feature.',
      },
    ],
  },
  {
    id: 'onboarding',
    title: 'First run — connect a model',
    action: 'Live Wikipedia page on the left; onboarding card in the panel: fill three fields, Test connection, Save & start.',
    beats: [
      {
        mark: 'start',
        text:
          'On first run, the panel shows a short welcome beside whatever you’re reading — here, the Wikipedia article on the Rideau Canal. It asks for just three things: an endpoint, a key, and a model.',
      },
      {
        mark: 'typed',
        text:
          'Any OpenAI-compatible endpoint works — a cloud A P I, a local model, or your organization’s gateway. The key is stored only on this device, never synced.',
      },
      { mark: 'tested', text: 'Test connection sends one tiny request, and reports plainly that it worked.' },
      { mark: 'ready', text: 'Save and start — and that’s the whole setup.' },
    ],
  },
  {
    id: 'summarize',
    title: 'Ask about the current page',
    action: 'Types a question; the agent reads the live article and answers with a real summary.',
    beats: [
      {
        mark: 'start',
        text: 'The simplest thing you can do: ask about the page you’re on.',
      },
      {
        mark: 'asked',
        text:
          'The question goes in the composer in plain language. Watch the status pill — thinking, then acting, as the agent reads the tab.',
      },
      {
        mark: 'answered',
        text:
          'And the answer is a genuine summary of this article — the canal’s length, its heritage status, the winter Skateway — with a one-click copy button and the source cited.',
      },
    ],
  },
  {
    id: 'plan',
    title: 'Research with a live plan',
    action: 'A research task: plan appears, real tabs open across the fake tab strip, synthesis cites all sources; tool log expanded.',
    beats: [
      { mark: 'start', text: 'For bigger tasks, the agent plans in the open. Let’s ask it to compare Canada’s historic waterways.' },
      { mark: 'planned', text: 'It lays out its plan first — four steps, each ticked off as it completes.' },
      {
        mark: 'tabs',
        text:
          'Then it opens real sources — watch the tab strip: the Northwest Passage and the Trent–Severn Waterway open as live tabs, gathered into this conversation’s tab group.',
      },
      { mark: 'answered', text: 'The synthesis draws on every tab it opened, and lists them as sources.' },
      { mark: 'activity', text: 'And the tool activity log keeps the full trace — every call the agent made, in order.' },
    ],
  },
  {
    id: 'approval',
    title: 'Approvals — you stay in control',
    action: 'A state-changing action raises the approval card; Approve runs it; the answer reports the page’s real title.',
    beats: [
      { mark: 'start', text: 'Now the most important design decision: consent.' },
      {
        mark: 'card',
        text:
          'Running code inside a page changes state, so the agent stops and asks first. The card leads with a plain-language reason; the mechanics sit under the technical-detail toggle. Nothing outbound ever happens silently.',
      },
      { mark: 'approved', text: 'Approve it, and the action runs — the agent reads and reports this page’s real title. Deny it, and nothing happens at all.' },
    ],
  },
  {
    id: 'knowledge',
    title: 'Knowledge bases',
    action: 'Workspace Knowledge page: upload a briefing note; back in the panel, a # reference searches it and the answer cites the note.',
    beats: [
      {
        mark: 'start',
        text: 'Knowledge bases are on-device document stores. In the workspace, drop in files — or index whole folders.',
      },
      {
        mark: 'uploaded',
        text: 'This briefing note is parsed and embedded right on the machine. Nothing is uploaded anywhere.',
      },
      { mark: 'panel', text: 'Back in the panel, a hash sign references the base by name.' },
      { mark: 'answered', text: 'The agent searches the note and answers from it — the canal’s navigation season, with the source file cited.' },
    ],
  },
  {
    id: 'history',
    title: 'History, undo, and the More menu',
    action: 'History overlay with generated title and summary; the ⋯ More menu with text-size, save, undo, learn mode.',
    beats: [
      { mark: 'start', text: 'Every conversation is saved automatically — there is no save button to forget.' },
      { mark: 'opened', text: 'Each thread gets a generated title and a one-line summary, with search, sorting, and colour labels.' },
      {
        mark: 'more',
        text:
          'The three-dot menu holds the everyday extras: the text-size control, saving the conversation as a file, undoing the last exchange, and learn mode.',
      },
      { mark: 'done', text: 'And New Chat starts fresh — the old thread stays safely in history.' },
    ],
  },
  {
    id: 'skills',
    title: 'Skills and app playbooks',
    action: 'Workspace Skills page with the seeded skills; back in the panel, slash-command autocomplete.',
    beats: [
      {
        mark: 'start',
        text:
          'Skills are procedures you teach the agent once and reuse forever — written by hand, imported, or installed from the shared playbook library.',
      },
      { mark: 'slash', text: 'Each one becomes a slash command: type a slash in the composer and pick it from the menu.' },
    ],
  },
  {
    id: 'workspace',
    title: 'The Workspace console',
    action: 'Models page with the Advanced section scrolled through; then Memory, Automations (seeded run history), Products.',
    beats: [
      {
        mark: 'start',
        text: 'The settings gear opens the workspace — a full tab with a page for everything. Models holds the connection and every advanced option.',
      },
      { mark: 'scrolled', text: 'Behaviour, generation, embeddings, connected services — one page, one scroll.' },
      { mark: 'memory', text: 'Memory shows what the agent has learned about you — searchable and fully editable.' },
      { mark: 'automations', text: 'Automations runs scheduled tasks and site triggers unattended — here’s this morning’s news brief, run on schedule.' },
      { mark: 'products', text: 'And the files those runs produce land in Products, kept on-device and ready to download.' },
    ],
  },
  {
    id: 'documents',
    title: 'Documents out',
    action: 'Asks for a three-slide deck on the article; a .pptx download card appears in the chat.',
    beats: [
      { mark: 'start', text: 'The agent produces real files, not just chat.' },
      { mark: 'asked', text: 'Ask for a three-slide deck on this article…' },
      {
        mark: 'card',
        text:
          '…and a PowerPoint is built on-device — titles, bullets, and a speaker note — delivered as a download card right in the conversation.',
      },
    ],
  },
  {
    id: 'resilience',
    title: 'Built for imperfect networks',
    action: 'A request against a rate-limited endpoint: retrying notice, then a clean recovered answer.',
    beats: [
      { mark: 'start', text: 'One more thing: failure handling. This request is about to hit a rate-limited endpoint.' },
      { mark: 'retrying', text: 'The agent reads the server’s retry hint, backs off, and says so — right in the conversation.' },
      { mark: 'answered', text: 'Then it recovers to a clean answer on its own. No babysitting.' },
    ],
  },
  {
    id: 'outro',
    title: 'Wrap-up',
    action: 'Outro card with the project location.',
    beats: [
      {
        mark: 'start',
        text:
          'That’s CANChat Agent: your browser, your session, your data — with an agent that shows its plan, logs its tools, and asks before it acts. Load the extension, connect a model, and try it on your own tabs.',
      },
    ],
  },
];
