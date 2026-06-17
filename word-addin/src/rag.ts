// The "brain": reuse the extension's portable model client (complete/embed) and
// the shared int8 similarity search to answer questions, optionally grounded in
// a repository (RAG) and/or the current document, optionally steered by a skill.

import { complete, embed, type LlmMessage } from '../../src/background/llmProvider';
import type { Settings } from '../../src/shared/types';
import { searchVectors, type SearchHit } from '../../src/shared/vectorSearch';
import { getRepo } from './store';

/** Embed the query and retrieve the top-k passages from a stored repository. */
export async function retrieve(
  settings: Settings,
  repoName: string,
  query: string,
  k = 6,
): Promise<SearchHit[]> {
  const repo = await getRepo(repoName);
  if (!repo || repo.meta.chunkCount === 0) return [];
  const [queryVector] = await embed(settings, [query]);
  return searchVectors({
    dim: repo.meta.dim,
    perDimScale: repo.meta.perDimScale,
    chunkCount: repo.meta.chunkCount,
    vectors: repo.vectors,
    chunks: repo.chunks,
    queryVector,
    k,
  });
}

export interface AskInput {
  settings: Settings;
  query: string;
  /** Repository to ground the answer in (RAG), if any. */
  repoName?: string;
  /** Current Word selection/document text to reason over, if any. */
  documentText?: string;
  /** A skill body to follow as guidance, if a skill was invoked. */
  skillBody?: string;
  signal?: AbortSignal;
}

export interface AskResult {
  answer: string;
  citations: SearchHit[];
}

const DOC_LIMIT = 8000; // keep the document slice bounded

export async function ask(input: AskInput): Promise<AskResult> {
  const { settings, query, repoName, documentText, skillBody, signal } = input;
  const citations = repoName ? await retrieve(settings, repoName, query) : [];

  const system = [
    'You are a writing and research assistant embedded in Microsoft Word.',
    'Answer in clean Markdown suitable for pasting into a document.',
    skillBody ? `Follow this saved procedure wherever it applies:\n${skillBody}` : '',
    citations.length
      ? 'Use the retrieved passages as your source of truth; cite them inline as [n] and list the sources at the end.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const parts: string[] = [];
  if (documentText?.trim()) {
    parts.push(`Document context:\n"""\n${documentText.slice(0, DOC_LIMIT)}\n"""`);
  }
  if (citations.length) {
    parts.push(
      'Retrieved passages:\n' +
        citations.map((c, i) => `[${i + 1}] ${c.name} — ${c.url}\n${c.text}`).join('\n\n'),
    );
  }
  parts.push(`Question:\n${query}`);

  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
  const reply = await complete(settings, messages, undefined, signal);
  return { answer: reply.content ?? '', citations };
}
