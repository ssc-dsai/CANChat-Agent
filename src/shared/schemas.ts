import type { ToolDefinition } from '../background/llmProvider';

const tabIdParam = {
  tabId: { type: 'number', description: 'The id of the target tab.' },
};

// Required on every approval-gated tool. The user reads this on the approval
// card to make an informed choice, so it must state what the action does and why.
const reasonParam = {
  reason: {
    type: 'string',
    description:
      "A short, plain-language explanation, written for the user, of WHAT this action does and WHY it helps the current task (e.g. \"Open the vessel's detail panel so I can read its destination\"). Avoid jargon and refIds.",
  },
};

/** Only offered to the model when the user has enabled persistent memory. */
export const MEMORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Save one durable fact about the user (their work, projects, interests, preferences, ongoing activities) to persistent memory. One fact per call. Never save secrets, credentials, or sensitive page content.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, plainly stated in third person.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: 'Revise an existing memory entry when a fact has changed or needs correction.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the memory entry to update.' },
          text: { type: 'string', description: 'The corrected fact.' },
        },
        required: ['id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description:
        'Delete a memory entry. Use immediately when the user asks you to forget something, or when an entry is obsolete.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the memory entry to delete.' },
        },
        required: ['id'],
      },
    },
  },
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_tabs',
      description: 'List all open browser tabs with their ids, titles, and URLs.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_active_tab',
      description: 'Get the currently active browser tab (id, title, URL).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tab_content',
      description:
        'Extract readable content from a tab: text, title, headings, links, and metadata. Use after navigation or search to read the resulting page.',
      parameters: { type: 'object', properties: { ...tabIdParam }, required: ['tabId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_all_tab_contents',
      description:
        'Extract readable content from every open tab. Requires the user to have granted all-tabs access; requires user approval each time.',
      parameters: { type: 'object', properties: { ...reasonParam }, required: ['reason'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate an existing tab to a URL and wait for the page to load.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          url: { type: 'string', description: 'Absolute URL to navigate to.' },
        },
        required: ['tabId', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        "Search the web using the browser's default search engine. Opens a new tab with the results; follow up with get_tab_content on the returned tabId to read them.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_element_map',
      description:
        'List interactive elements (links, buttons, inputs) on a tab with stable refIds. Always call this before click_element, fill_input, or submit_form and act on refIds.',
      parameters: { type: 'object', properties: { ...tabIdParam }, required: ['tabId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description:
        'Click an element identified by a refId from get_element_map. State-changing: requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          selectorOrRef: { type: 'string', description: 'refId from get_element_map (preferred) or a CSS selector.' },
          ...reasonParam,
        },
        required: ['tabId', 'selectorOrRef', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill_input',
      description:
        'Fill a text input or textarea identified by a refId from get_element_map. State-changing: requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          selectorOrRef: { type: 'string', description: 'refId from get_element_map (preferred) or a CSS selector.' },
          value: { type: 'string', description: 'The value to enter.' },
          ...reasonParam,
        },
        required: ['tabId', 'selectorOrRef', 'value', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_form',
      description:
        'Submit the form containing the referenced element. State-changing: requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          selectorOrRef: { type: 'string', description: 'refId from get_element_map (preferred) or a CSS selector.' },
          ...reasonParam,
        },
        required: ['tabId', 'selectorOrRef', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_keys',
      description:
        'Dispatch a keyboard key or combo to the page — "Enter", "Control+Enter", "Escape", "Tab", or a single letter for app shortcuts (e.g. "c" to compose in Outlook/Gmail). Optionally focus a refId first. State-changing: requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          combo: { type: 'string', description: 'Key or combo, e.g. "Enter" or "Control+Enter".' },
          targetRef: {
            type: 'string',
            description: 'Optional refId to focus before pressing. Defaults to the focused element.',
          },
          ...reasonParam,
        },
        required: ['tabId', 'combo', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_element',
      description:
        'Wait until an element matching a CSS selector becomes present/visible/enabled (or time out). Use before acting on dynamically-loaded content.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          state: {
            type: 'string',
            enum: ['present', 'visible', 'enabled'],
            description: 'Condition to wait for (default visible).',
          },
          timeoutMs: { type: 'number', description: 'Max wait in ms (default 8000).' },
        },
        required: ['tabId', 'selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_at',
      description:
        'Click at viewport coordinates (x, y) — for canvas/map content with no clickable element. Use element rects from get_element_map to choose coordinates. State-changing: requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          x: { type: 'number', description: 'Viewport x coordinate.' },
          y: { type: 'number', description: 'Viewport y coordinate.' },
          ...reasonParam,
        },
        required: ['tabId', 'x', 'y', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drag',
      description:
        'Drag from one viewport coordinate to another — pan a map, move a slider, or drag-and-drop. State-changing: requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          fromX: { type: 'number' },
          fromY: { type: 'number' },
          toX: { type: 'number' },
          toY: { type: 'number' },
          ...reasonParam,
        },
        required: ['tabId', 'fromX', 'fromY', 'toX', 'toY', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_wheel',
      description:
        'Dispatch a mouse wheel event at viewport coordinates — zoom a map (negative deltaY zooms in) or trigger lazy-loading. Viewport-only; no approval needed.',
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          x: { type: 'number', description: 'Viewport x coordinate.' },
          y: { type: 'number', description: 'Viewport y coordinate.' },
          deltaY: { type: 'number', description: 'Wheel delta; negative = up/zoom-in, positive = down.' },
        },
        required: ['tabId', 'x', 'y', 'deltaY'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_known_sites',
      description:
        "Search the user's curated directory of known sites (names, URLs, descriptions, optional search-URL templates) for sites likely to contain the data a task needs. Check this before falling back to a generic web search.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords describing the data or site you are looking for.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_app_playbook',
      description:
        "Persist a reusable playbook for operating a specific web app, scoped to its site origin. The body auto-loads whenever the user returns to that site. Use at the end of a /learn exploration to record how to drive the app (navigation, search, reading data) with concrete code snippets or element references. Requires user approval.",
      parameters: {
        type: 'object',
        properties: {
          origin: {
            type: 'string',
            description: 'The site hostname this playbook applies to, e.g. "marinetraffic.com".',
          },
          name: { type: 'string', description: 'Short lowercase-kebab name for the playbook.' },
          description: { type: 'string', description: 'One line: what this playbook lets you do.' },
          body: {
            type: 'string',
            description: 'The full playbook in markdown: how to perform the app\'s key actions.',
          },
          ...reasonParam,
        },
        required: ['origin', 'name', 'description', 'body', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        "Load the full instructions of one of the user's skills by name and follow them for the current task. Use when the task matches a skill's description.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name, e.g. "research".' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_javascript',
      description:
        "Run JavaScript in the page's own context (it can read the page's variables, app state, and framework internals) and get the result back. The value of the last expression or an explicit return is JSON-serialized and returned. Use for tasks the other tools can't express — reading app/framework state or computing over page data. Requires user approval. Prefer the dedicated tools (get_tab_content, get_element_map, click_element, …) when they suffice.",
      parameters: {
        type: 'object',
        properties: {
          ...tabIdParam,
          code: {
            type: 'string',
            description:
              'JavaScript source. May use await. End with the value you want returned (e.g. `document.title` or `return ...` inside an async context).',
          },
          ...reasonParam,
        },
        required: ['tabId', 'code', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_page_state',
      description: 'Wait until a tab finishes loading (or times out after 20s).',
      parameters: { type: 'object', properties: { ...tabIdParam }, required: ['tabId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_auth_state',
      description:
        'Check whether a tab is showing a login wall or is behind authentication. If auth is required the task pauses until the user logs in and resumes.',
      parameters: { type: 'object', properties: { ...tabIdParam }, required: ['tabId'] },
    },
  },
];
