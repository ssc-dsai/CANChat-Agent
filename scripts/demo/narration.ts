// The demo's narration — single source of truth for BOTH the TTS voiceover and
// the generated docs/demo/SCRIPT.md. Timecodes are computed by record.ts from
// the finished segments, never written here.
//
// Pacing budget: macOS `say` speaks ~2.5 words/second at the default rate, and
// each scene's video is stretched to fit its narration, so long narration =
// long scene. Keep a scene under ~90 words unless the visuals need the time.

export interface SceneDef {
  id: string;
  title: string;
  /** What the viewer sees — used for the SCRIPT.md action column. */
  action: string;
  narration: string;
}

export const SCENES: SceneDef[] = [
  {
    id: 'title',
    title: 'Title card',
    action: 'Branded title card.',
    narration:
      'CANChat Agent is an A I agent that lives in your browser’s side panel — and uses the browser itself as its toolset. It reads the pages you already have open, works inside the sessions you are already signed into, and keeps its data on your device. Over the next few minutes we’ll set it up from scratch and walk through every major feature, at the pace you would actually use it.',
  },
  {
    id: 'onboarding',
    title: 'First run — connect a model',
    action: 'Onboarding card: fill endpoint, key, and model; Test connection; Save & start.',
    narration:
      'Setup takes under a minute. On first run, a short welcome asks for just three things: the address of any OpenAI-compatible endpoint — a cloud A P I, a local model, or your organization’s gateway — an A P I key, and a model name. The key is stored only on this device, and it is never synced anywhere. Click Test connection, and the extension makes one tiny request and tells you plainly whether it worked. Then Save and start. That’s the whole setup — no account, no sign-up, nothing leaves your machine except the traffic to the endpoint you chose.',
  },
  {
    id: 'summarize',
    title: 'Ask about the current page',
    action: 'Type a question in the composer; the agent reads the page and answers with a Copy button.',
    narration:
      'The simplest thing you can do: open any page and ask about it. Type your question in the composer at the bottom and press enter. Watch the status pill under the title — it shows the agent thinking, then acting as it reads the page. The answer arrives as a chat bubble, with a one-click copy button underneath. The composer has shortcuts, too: type an at-sign to insert one of your bookmarks, a hash to reference a knowledge base, or a slash to run a saved skill. Every answer that draws on a page cites its source.',
  },
  {
    id: 'plan',
    title: 'Research with a live plan',
    action: 'A multi-step task: the plan panel fills in, tools run, and the tool-activity log expands.',
    narration:
      'For bigger tasks, the agent works in visible steps. Give it a research question and it lays out a plan you can watch — each step ticks off as it completes, so you always know where it is and what’s left. Pages it opens are gathered into a named tab group for the conversation. And below the chat, the tool activity log records every single tool call the agent made. Expand it any time to see exactly what ran, in what order, and how each step turned out. Nothing the agent does is hidden.',
  },
  {
    id: 'approval',
    title: 'Approvals — you stay in control',
    action: 'A state-changing action raises an approval card with a plain-language reason; Approve continues.',
    narration:
      'Here’s the most important design decision in the product. Anything that would change state — clicking a button, filling a form, submitting, or running code in a page — stops and asks you first. The approval card leads with a plain-language reason: what the agent wants to do, and why it helps your task. The mechanics are there too, under the technical detail toggle. You approve or deny every single one, or allow a tool for the rest of the session. Reading is frictionless; acting requires consent. Nothing outbound ever happens silently.',
  },
  {
    id: 'knowledge',
    title: 'Knowledge bases',
    action: 'Workspace → Knowledge: upload a file into a named base; then ask a question against it from the panel.',
    narration:
      'Knowledge bases are on-device document stores the agent can search. In the workspace, open the Knowledge page and drop in files — P D Fs, Word documents, spreadsheets, or plain text — or index a whole local folder, and they are parsed and embedded right on your machine. Nothing is uploaded anywhere. Then, back in the panel, type a hash sign to reference a base by name, and just ask your question. The agent searches it with hybrid semantic and keyword retrieval, and answers with citations back to the exact source passages.',
  },
  {
    id: 'history',
    title: 'History, undo, and the More menu',
    action: 'The History overlay with auto-summaries; the ⋯ More menu: text size, save conversation, undo.',
    narration:
      'Every conversation is saved automatically — no save button. The history overlay gives each thread a generated title and a one-line summary, with search, sorting, and colour labels for organizing. Continue any old thread right where you left off. The three-dot More menu in the header holds the everyday extras: a text-size control for the whole panel, saving the conversation as an H T M L file, undoing the last exchange — which puts your message back in the composer to edit — and learn mode. And New Chat starts fresh while keeping the old thread safely in history.',
  },
  {
    id: 'skills',
    title: 'Skills and app playbooks',
    action: 'Workspace → Skills: the seeded skills; slash-command autocomplete in the composer.',
    narration:
      'Skills are reusable procedures you teach the agent once and reuse forever. The workspace Skills page manages them: write your own, import one from a U R L or a zip, or install from the shared App playbook library. Each skill becomes a slash command — type a slash in the composer, and pick from the menu. App playbooks go further: they teach the agent how to drive one specific website reliably, and the agent can even write its own playbook after it figures a site out. After a substantial task, it will offer to save the whole workflow as a new skill.',
  },
  {
    id: 'workspace',
    title: 'The Workspace console',
    action: 'A tour of the full-tab console: Models with the Advanced section, Memory, Automations, Products.',
    narration:
      'The settings gear opens the workspace — a full browser tab with a page for everything, sharing the same conversation. Models holds your endpoint connection and every advanced option: agent behaviour, generation settings, custom instructions, embeddings, and connected services — scroll through one page instead of hunting through tabs. Memory shows what the agent has learned about you, fully searchable and editable. Automations runs scheduled tasks and site triggers unattended — here’s a morning news brief that ran on schedule. And the files those runs produce land in Products, kept on-device and ready to download whenever you are.',
  },
  {
    id: 'documents',
    title: 'Documents out',
    action: 'Ask for a slide deck; a downloadable .pptx card appears in the chat.',
    narration:
      'The agent produces real files, not just chat. Ask for a slide deck and it builds a PowerPoint on-device — titles, bullet points, and speaker notes — delivered as a download card right in the conversation. Word documents work the same way. And when you ask it to collect structured information across pages, it hands you the table as a C S V download. Files generated by scheduled runs go to the Products page, so nothing is lost if you weren’t watching.',
  },
  {
    id: 'resilience',
    title: 'Built for imperfect networks',
    action: 'A rate-limited request shows a retrying notice, then recovers to a clean answer.',
    narration:
      'One more thing worth seeing: failure handling. When an endpoint is busy or rate-limited, the agent doesn’t just die. It reads the server’s retry hint, backs off, tells you it’s retrying, and recovers to a clean answer. On capacity-limited enterprise endpoints, that’s the difference between a tool you trust and one you babysit. And when something genuinely fails, the error banner explains it in plain language, with a one-click retry.',
  },
  {
    id: 'outro',
    title: 'Wrap-up',
    action: 'Outro card with the project location.',
    narration:
      'That’s CANChat Agent: your browser, your session, your data — with an agent that shows its plan, logs its tools, and asks before it acts. Everything you saw ran on-device against the model endpoint we configured at the start. It’s bilingual, it’s open source, and it loads as an unpacked extension in any Chromium browser. Grab it, connect a model, and try it on your own tabs.',
  },
];
