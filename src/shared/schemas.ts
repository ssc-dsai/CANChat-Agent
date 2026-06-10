import type { ToolDefinition } from '../background/llmProvider';

const tabIdParam = {
  tabId: { type: 'number', description: 'The id of the target tab.' },
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
      parameters: { type: 'object', properties: {}, required: [] },
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
        },
        required: ['tabId', 'selectorOrRef'],
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
        },
        required: ['tabId', 'selectorOrRef', 'value'],
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
        },
        required: ['tabId', 'selectorOrRef'],
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
