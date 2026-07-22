// Demo-only scripted LLM. Same OpenAI-compatible surface as the e2e mock
// (tests/e2e/mockLlm.ts) but with REALISTIC, hand-written responses matched to
// the live pages the demo shows — genuine-sounding summaries, plans whose
// steps the agent really executes (open_url on live sites, so real tabs
// appear), and natural prose instead of test-marker strings. Deterministic:
// every take is identical, no API key, no spend.
//
// Response selection keys off distinctive phrases in the latest user message —
// the scene scripts in scenes.ts and these handlers are written as a pair.

import { createServer, type IncomingMessage, type Server } from 'node:http';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: ToolCall[];
}
interface ChatRequest {
  messages: ChatMessage[];
}

export interface DemoLlm {
  url: string;
  close: () => Promise<void>;
}

const busySeen = new Map<string, number>();

function textOf(m: ChatMessage | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? '').join(' ');
  return '';
}
const latestUserText = (ms: ChatMessage[]) => {
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') return textOf(ms[i]);
  return '';
};
const systemTextOf = (ms: ChatMessage[]) => textOf(ms.find((m) => m.role === 'system'));
const hasToolCall = (ms: ChatMessage[], name: string) =>
  ms.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((tc) => tc.function.name === name));
const countToolCalls = (ms: ChatMessage[], name: string) =>
  ms.reduce((n, m) => n + (m.role === 'assistant' ? (m.tool_calls ?? []).filter((tc) => tc.function.name === name).length : 0), 0);
const toolCall = (name: string, args: Record<string, unknown>, id = name): ToolCall => ({
  id: `call_${id}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function decide(req: ChatRequest): ChatMessage {
  const system = systemTextOf(req.messages);
  const rawPrompt = latestUserText(req.messages);
  const prompt = rawPrompt.toLowerCase();

  // ----- internal model-assisted steps (same contracts as the e2e mock) -----
  if (system.includes('strict reviewer')) return { role: 'assistant', content: '{"verdict":"ok"}' };
  if (system.includes('compress a browser agent')) {
    const n = (rawPrompt.match(/--- Tool output \d+ ---/g) ?? []).length || 1;
    return { role: 'assistant', content: JSON.stringify(new Array(n).fill('digest of an earlier step')) };
  }
  if (system.includes('label a conversation')) {
    const fr = /résume|canal rideau|diapositives|point de terminaison/.test(prompt);
    return {
      role: 'assistant',
      content: fr
        ? '{"title":"Recherche sur le canal Rideau","summary":"Lecture de l’article sur le canal Rideau, comparaison des voies navigables et production d’un jeu de diapositives."}'
        : '{"title":"Rideau Canal research","summary":"Read the Rideau Canal article, compared Canadian waterways across sources, and produced a briefing deck."}',
    };
  }
  if (system.includes('Extract durable knowledge from this exchange')) {
    return { role: 'assistant', content: '{"memories":[]}' };
  }
  if (system.includes('Two memory facts about the same subject')) {
    return { role: 'assistant', content: '{"supersedes": false}' };
  }
  if (system.includes('convert a completed browser task into a reusable skill')) {
    return {
      role: 'assistant',
      content: '{"name":"waterway-brief","description":"Compare Canadian waterways and produce a short brief","body":"1. Read the sources. 2. Compare. 3. Brief."}',
    };
  }

  // ============================ French scenes ============================

  if (prompt.includes('résume cette page')) {
    if (!hasToolCall(req.messages, 'get_tab_content')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('get_tab_content', {})] };
    }
    return {
      role: 'assistant',
      content:
        'Voici la page en trois points :\n\n' +
        '- Le **canal Rideau** relie Ottawa à Kingston sur 202 km de rivières, de lacs et d’écluses construites à la main; il fonctionne sans interruption depuis **1832**.\n' +
        '- Il est inscrit au **patrimoine mondial de l’UNESCO** depuis 2007 — la plupart de ses écluses sont encore manœuvrées à la main.\n' +
        '- L’hiver, le tronçon d’Ottawa devient la **patinoire du canal Rideau**, l’une des plus grandes patinoires naturelles au monde.\n\n' +
        'Source : l’article Wikipédia ouvert dans cet onglet.',
    };
  }

  if (prompt.includes('voies navigables historiques')) {
    if (!hasToolCall(req.messages, 'set_plan')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('set_plan', {
            steps: [
              'Lire l’article sur le canal Rideau dans l’onglet actuel',
              'Ouvrir l’article sur le passage du Nord-Ouest',
              'Ouvrir l’article sur la voie navigable Trent-Severn',
              'Synthétiser une comparaison avec les sources',
            ],
          }),
        ],
      };
    }
    if (countToolCalls(req.messages, 'open_url') === 0) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('open_url', { url: 'https://fr.wikipedia.org/wiki/Passage_du_Nord-Ouest' }, 'open1')],
      };
    }
    if (countToolCalls(req.messages, 'open_url') === 1) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('open_url', { url: 'https://fr.wikipedia.org/wiki/Voie_navigable_Trent-Severn' }, 'open2')],
      };
    }
    if (!hasToolCall(req.messages, 'update_plan')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('update_plan', { step: 1, status: 'done' }, 'up1'),
          toolCall('update_plan', { step: 2, status: 'done' }, 'up2'),
          toolCall('update_plan', { step: 3, status: 'done' }, 'up3'),
        ],
      };
    }
    return {
      role: 'assistant',
      content:
        'Comparaison entre les trois sources maintenant ouvertes dans ce groupe d’onglets :\n\n' +
        '- **Canal Rideau (1832)** — construit pour le ravitaillement militaire après la guerre de 1812; aujourd’hui un corridor patrimonial et récréatif, navigable de bout en bout.\n' +
        '- **Voie navigable Trent-Severn** — 386 km à travers le centre de l’Ontario; comme le Rideau, elle est exploitée par Parcs Canada.\n' +
        '- **Passage du Nord-Ouest** — une route maritime arctique, pas un canal : longtemps prisonnière des glaces, de plus en plus franchie l’été.\n\n' +
        'Fil conducteur : les trois ont façonné les routes commerciales canadiennes, mais seuls les deux canaux ont été construits — le passage est un système naturel en mutation.\n\n' +
        'Onglets sources : Canal Rideau · Passage du Nord-Ouest · Voie navigable Trent-Severn.',
    };
  }

  if (prompt.includes('titre exact')) {
    if (!hasToolCall(req.messages, 'run_javascript')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('run_javascript', {
            reason: 'Lire le titre de cette page pour le rapporter exactement',
            code: 'document.title',
          }),
        ],
      };
    }
    return {
      role: 'assistant',
      content: 'Le titre exact de la page est **« Colline du Parlement — Wikipédia »**. Il vient directement du titre du document, lu avec votre approbation.',
    };
  }

  if (prompt.includes('note d’information') || prompt.includes("note d'information")) {
    if (!hasToolCall(req.messages, 'search_repo')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('search_repo', { repo: 'notes d’information', query: 'saison de navigation canal Rideau' })],
      };
    }
    return {
      role: 'assistant',
      content:
        'D’après votre base **notes d’information** : la note indique que la saison de navigation du canal Rideau s’étend de la **mi-mai à la mi-octobre**, avec un personnel d’écluses réduit en début et en fin de saison — planifiez les visites officielles de juin à septembre.\n\nSource : « note-canal.txt » dans notes d’information.',
    };
  }

  if (prompt.includes('trois diapositives')) {
    if (!hasToolCall(req.messages, 'create_powerpoint')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('create_powerpoint', {
            title: 'Canal Rideau — Note de présentation',
            filename: 'canal-rideau-presentation.pptx',
            slides: [
              { title: 'Un canal patrimonial en service', bullets: ['202 km, d’Ottawa à Kingston', 'En service continu depuis 1832', 'Patrimoine mondial de l’UNESCO (2007)'] },
              { title: 'Son fonctionnement aujourd’hui', bullets: ['Écluses encore manœuvrées à la main', 'Navigation gérée par Parcs Canada', 'Saison : mi-mai à mi-octobre'] },
              { title: 'Pourquoi c’est important', bullets: ['Plus ancien canal en service continu en Amérique du Nord', 'La patinoire d’hiver attire ~1 M de visites', 'Pilier du tourisme à Ottawa'], notes: 'Terminer avec la photo de la patinoire.' },
            ],
          }),
        ],
      };
    }
    return {
      role: 'assistant',
      content: 'Terminé — **canal-rideau-presentation.pptx** est prêt ci-dessous : trois diapositives avec titres, puces, et une note d’allocution sur la dernière.',
    };
  }

  if (prompt.includes('quand même')) {
    return {
      role: 'assistant',
      content: 'Malgré la limitation de débit passagère, le réessai s’est **rétabli** proprement — et la page est résumée : le parc de la Gatineau est le grand parc de conservation de la capitale, aux portes d’Ottawa-Gatineau.',
    };
  }

  // ============================ English scenes ============================

  // ----- scene: summarize the live Rideau Canal article -----
  if (prompt.includes('summarize this page')) {
    if (!hasToolCall(req.messages, 'get_tab_content')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('get_tab_content', {})] };
    }
    return {
      role: 'assistant',
      content:
        'Here’s the page in three points:\n\n' +
        '- The **Rideau Canal** connects Ottawa to Kingston over 202 km of rivers, lakes, and hand-built locks, and has operated continuously since **1832**.\n' +
        '- It was designated a **UNESCO World Heritage Site** in 2007 as the best-preserved slackwater canal in North America — most of its locks are still worked by hand.\n' +
        '- In winter, the Ottawa stretch becomes the **Rideau Canal Skateway**, one of the world’s largest naturally frozen skating rinks.\n\n' +
        'Source: the Wikipedia article open in this tab.',
    };
  }

  // ----- scene: multi-tab research with a live plan -----
  if (prompt.includes('historic waterways')) {
    if (!hasToolCall(req.messages, 'set_plan')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('set_plan', {
            steps: [
              'Read the Rideau Canal article in the current tab',
              'Open the Northwest Passage article for comparison',
              'Open Parks Canada’s Trent–Severn Waterway page',
              'Synthesize a comparison with sources',
            ],
          }),
        ],
      };
    }
    if (countToolCalls(req.messages, 'open_url') === 0) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('open_url', { url: 'https://en.wikipedia.org/wiki/Northwest_Passage' }, 'open1')],
      };
    }
    if (countToolCalls(req.messages, 'open_url') === 1) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('open_url', { url: 'https://en.wikipedia.org/wiki/Trent%E2%80%93Severn_Waterway' }, 'open2')],
      };
    }
    if (!hasToolCall(req.messages, 'update_plan')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('update_plan', { step: 1, status: 'done' }, 'up1'),
          toolCall('update_plan', { step: 2, status: 'done' }, 'up2'),
          toolCall('update_plan', { step: 3, status: 'done' }, 'up3'),
        ],
      };
    }
    return {
      role: 'assistant',
      content:
        'Comparison across the three sources now open in this tab group:\n\n' +
        '- **Rideau Canal (1832)** — built for military supply after the War of 1812; today a heritage and recreation corridor, navigable end to end.\n' +
        '- **Trent–Severn Waterway** — 386 km across central Ontario; like the Rideau it is operated by Parks Canada as a historic canal.\n' +
        '- **Northwest Passage** — an Arctic sea route, not a canal: historically ice-bound, now increasingly navigated as summer ice retreats.\n\n' +
        'The common thread: all three shaped Canadian trade routes, but only the two canals were engineered — the Passage is a changing natural system.\n\n' +
        'Source tabs: Rideau Canal · Northwest Passage · Trent–Severn Waterway.',
    };
  }

  // ----- scene: approval-gated in-page action -----
  if (prompt.includes('exact title')) {
    if (!hasToolCall(req.messages, 'run_javascript')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('run_javascript', {
            reason: 'Read this page’s title so I can report it exactly',
            code: 'document.title',
          }),
        ],
      };
    }
    return {
      role: 'assistant',
      content: 'The page’s exact title is **“Parliament Hill - Wikipedia.”** That came straight from the page’s own document title, read with your approval.',
    };
  }

  // ----- scene: knowledge-base question -----
  if (prompt.includes('briefing note')) {
    if (!hasToolCall(req.messages, 'search_repo')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('search_repo', { repo: 'briefing notes', query: 'Rideau Canal navigation season' })],
      };
    }
    return {
      role: 'assistant',
      content:
        'From your **briefing notes** knowledge base: the note says the Rideau Canal’s navigation season runs **mid-May to mid-October**, with lock staffing reduced in the shoulder weeks — plan official visits for June through September.\n\nSource: “canal-brief.txt” in briefing notes.',
    };
  }

  // ----- scene: document generation -----
  if (prompt.includes('three-slide deck')) {
    if (!hasToolCall(req.messages, 'create_powerpoint')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('create_powerpoint', {
            title: 'Rideau Canal — Briefing',
            filename: 'rideau-canal-briefing.pptx',
            slides: [
              { title: 'A working heritage canal', bullets: ['202 km, Ottawa to Kingston', 'Operating continuously since 1832', 'UNESCO World Heritage Site (2007)'] },
              { title: 'How it runs today', bullets: ['Most locks still hand-operated', 'Parks Canada manages navigation', 'Season: mid-May to mid-October'] },
              { title: 'Why it matters', bullets: ['Oldest continuously operated canal in North America', 'Winter Skateway draws ~1M visits', 'Anchor of Ottawa tourism'], notes: 'Close with the skating rink photo.' },
            ],
          }),
        ],
      };
    }
    return {
      role: 'assistant',
      content: 'Done — **rideau-canal-briefing.pptx** is ready below: three slides with titles, bullets, and a speaker note on the closing slide.',
    };
  }

  // ----- scene: rate-limit recovery (429 handled at the HTTP layer) -----
  if (prompt.includes('summarize it anyway')) {
    return {
      role: 'assistant',
      content: 'Even with the endpoint briefly rate-limited, the retry recovered cleanly — and the page is summarized: Major’s Hill Park is Ottawa’s oldest park, overlooking the canal’s final flight of locks.',
    };
  }

  // Default (e.g. Test connection): a short, natural reply.
  return { role: 'assistant', content: 'Connected and ready.' };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

export async function startDemoLlm(): Promise<DemoLlm> {
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');

    if (url.endsWith('/chat/completions')) {
      let parsed: ChatRequest = { messages: [] };
      try {
        parsed = JSON.parse(await readBody(req)) as ChatRequest;
      } catch {
        /* tolerate */
      }
      // Rate-limit theatre for the resilience scene: 429 the first attempt.
      const prompt = latestUserText(parsed.messages).toLowerCase();
      if ((prompt.includes('summarize it anyway') || prompt.includes('quand même')) && !systemTextOf(parsed.messages).includes('strict reviewer')) {
        const seen = (busySeen.get(prompt) ?? 0) + 1;
        busySeen.set(prompt, seen);
        if (seen === 1) {
          res.statusCode = 429;
          res.setHeader('Retry-After', '2');
          res.end(JSON.stringify({ error: { message: 'Too Many Requests', code: 'too_many_requests' } }));
          return;
        }
      }
      const message = decide(parsed);
      res.end(JSON.stringify({ id: 'chatcmpl-demo', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
      return;
    }

    if (url.endsWith('/embeddings')) {
      let n = 1;
      try {
        const body = JSON.parse(await readBody(req)) as { input?: unknown };
        if (Array.isArray(body.input)) n = Math.max(1, body.input.length);
      } catch {
        /* one */
      }
      res.end(JSON.stringify({ data: Array.from({ length: n }, () => ({ embedding: new Array(8).fill(0.1) })) }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
