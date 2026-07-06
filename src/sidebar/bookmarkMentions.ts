import type { CapabilityRegistryEntry } from '../shared/capabilities';
import type { SiteEntry } from '../shared/types';

export interface BookmarkTreeLike {
  title?: string;
  url?: string;
  children?: BookmarkTreeLike[];
}

export interface BookmarkMentionCandidate {
  title: string;
  url: string;
  description?: string;
  folder?: string;
  tags?: string[];
  order: number;
}

export interface BookmarkMentionItem {
  primary: string;
  secondary: string;
  insert: string;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function labelWithContext(url: string, context?: string): string {
  return context ? `${url} — ${context}` : url;
}

export function flattenBookmarkTree(nodes: BookmarkTreeLike[], path: string[] = [], startOrder = 0): BookmarkMentionCandidate[] {
  const out: BookmarkMentionCandidate[] = [];
  let order = startOrder;
  const walk = (node: BookmarkTreeLike, folders: string[]) => {
    const title = node.title?.trim() ?? '';
    if (node.url) {
      out.push({
        title: title || node.url,
        url: node.url,
        folder: folders.filter(Boolean).join(' / ') || undefined,
        order: order++,
      });
    }
    const nextFolders = node.url ? folders : [...folders, title].filter(Boolean);
    for (const child of node.children ?? []) walk(child, nextFolders);
  };
  for (const node of nodes) walk(node, path);
  return out;
}

export function capabilityBookmarkCandidates(
  capabilities: CapabilityRegistryEntry[],
  sites: SiteEntry[],
  startOrder = 100000,
): BookmarkMentionCandidate[] {
  const out: BookmarkMentionCandidate[] = [];
  let order = startOrder;
  for (const c of capabilities) {
    if (c.kind !== 'bookmark' || !c.url) continue;
    out.push({
      title: c.name || c.url,
      url: c.url,
      description: c.description || undefined,
      tags: c.tags,
      order: order++,
    });
  }
  for (const s of sites) {
    if (!s.url) continue;
    out.push({
      title: s.name || s.url,
      url: s.url,
      description: s.description || undefined,
      order: order++,
    });
  }
  return out;
}

export function dedupeBookmarkCandidates(candidates: BookmarkMentionCandidate[]): BookmarkMentionCandidate[] {
  const byUrl = new Map<string, BookmarkMentionCandidate>();
  for (const c of candidates) {
    const key = c.url.trim().toLowerCase();
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, c);
      continue;
    }
    byUrl.set(key, {
      ...existing,
      title: existing.title || c.title,
      description: existing.description || c.description,
      folder: existing.folder || c.folder,
      tags: [...new Set([...(existing.tags ?? []), ...(c.tags ?? [])])],
      order: Math.min(existing.order, c.order),
    });
  }
  return [...byUrl.values()];
}

export function filterBookmarkMentions(candidates: BookmarkMentionCandidate[], query: string, limit = 20): BookmarkMentionItem[] {
  const q = norm(query);
  const scored = candidates
    .map((c) => {
      const title = norm(c.title);
      const url = norm(c.url);
      const description = norm(c.description ?? '');
      const folder = norm(c.folder ?? '');
      const tags = norm((c.tags ?? []).join(' '));
      const haystack = `${title} ${url} ${description} ${folder} ${tags}`;
      if (q && !haystack.includes(q)) return null;
      let score = 50;
      if (!q) score = 20;
      else if (title.startsWith(q)) score = 0;
      else if (title.includes(q)) score = 5;
      else if (url.includes(q)) score = 10;
      else if (description.includes(q)) score = 15;
      else if (tags.includes(q)) score = 18;
      else if (folder.includes(q)) score = 20;
      return { c, score };
    })
    .filter((x): x is { c: BookmarkMentionCandidate; score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.c.order - b.c.order)
    .slice(0, limit);

  return scored.map(({ c }) => ({
    primary: c.title || c.url,
    secondary: labelWithContext(c.url, c.description || c.folder || (c.tags?.length ? c.tags.join(', ') : undefined)),
    insert: c.url,
  }));
}
