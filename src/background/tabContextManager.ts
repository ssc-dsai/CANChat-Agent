import type { ContextScope, TabContextSnapshot, TabContextSummary } from '../shared/types';
import { getActiveTab, getAllTabContents, getTabContent } from './browserToolAdapter';

const STALE_AFTER_MS = 5 * 60 * 1000;

let current: TabContextSnapshot | null = null;

export function getSnapshot(): TabContextSnapshot | null {
  return current;
}

export function clearSnapshot(): void {
  current = null;
}

export function isStale(snapshot: TabContextSnapshot): boolean {
  return Date.now() - new Date(snapshot.createdAt).getTime() > STALE_AFTER_MS;
}

export async function buildSnapshot(scope: ContextScope): Promise<TabContextSnapshot> {
  const createdAt = new Date().toISOString();
  let tabs;
  if (scope === 'all') {
    tabs = await getAllTabContents();
  } else {
    const active = await getActiveTab();
    tabs = [await getTabContent(active.tabId)];
  }
  current = {
    snapshotId: `snap-${Date.now()}`,
    scope,
    tabs,
    createdAt,
  };
  return current;
}

/** Re-extract whatever scope the current snapshot covers. */
export async function refreshSnapshot(): Promise<TabContextSnapshot> {
  return buildSnapshot(current?.scope ?? 'active');
}

export function toSummary(snapshot: TabContextSnapshot | null): TabContextSummary | null {
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.snapshotId,
    scope: snapshot.scope,
    createdAt: snapshot.createdAt,
    tabs: snapshot.tabs.map((t) => ({
      tabId: t.tabId,
      title: t.title,
      url: t.url,
      extractionStatus: t.extractionStatus,
      capturedAt: t.capturedAt,
    })),
  };
}
