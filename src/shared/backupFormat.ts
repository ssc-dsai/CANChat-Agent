// Pure parser for the JSON file the extension's Backup & Restore exports
// (see src/sidebar/BackupRestoreSection.tsx). Lives in shared/ so the Word
// add-in (word-addin/) can import the extension's models, skills, known sites,
// memory, and repositories — including each repo's int8 vectors — without any
// chrome.* dependency. No DOM either, so it's unit-testable in Node.

import type { CapabilityRegistryEntry } from './capabilities';
import type { ExportedRepo } from './messages';
import { emptyMemoryGraph, type MemoryGraph } from './memoryGraph';
import type { LessonEntry, MemoryEntry, Settings, SiteEntry, Skill } from './types';

/** A repository with its vectors decoded back into an Int8Array. */
export interface ParsedRepo {
  name: string;
  meta: {
    name: string;
    dim: number;
    bits: number;
    perDimScale: number[];
    docs: Array<{ id: string; name: string; url: string; capturedAt: string; chunkStart: number; chunkCount: number }>;
    chunkCount: number;
  };
  chunks: Array<{ name: string; url: string; text: string }>;
  vectors: Int8Array;
}

export interface ParsedBackup {
  settings: Settings | null;
  skills: Skill[];
  sites: SiteEntry[];
  capabilities: CapabilityRegistryEntry[];
  memory: MemoryEntry[];
  /** Graph memory (ba_memory_graph). Falls back to an empty graph for a backup taken before this existed. */
  memoryGraph: MemoryGraph;
  lessons: LessonEntry[];
  repos: ParsedRepo[];
}

/** Decode a base64 string (as produced by btoa over the raw bytes) to bytes. */
export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64 ?? '');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function isMemoryGraph(v: unknown): v is MemoryGraph {
  return !!v && typeof v === 'object' && Array.isArray((v as MemoryGraph).nodes) && Array.isArray((v as MemoryGraph).edges);
}

function parseRepo(r: ExportedRepo): ParsedRepo {
  const bytes = bytesFromBase64(r.vectorsB64 ?? '');
  return {
    name: r.name,
    meta: r.meta as ParsedRepo['meta'],
    chunks: (Array.isArray(r.chunks) ? r.chunks : []) as ParsedRepo['chunks'],
    vectors: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
}

/**
 * Validate and parse an exported backup. Throws if the file isn't a CANChat
 * Agent backup (current `CANChat Agent` tag or the legacy `CANAgent`).
 */
export function parseBackup(input: unknown): ParsedBackup {
  const b = input as
    | { app?: string; kind?: string; storage?: Record<string, unknown>; repos?: ExportedRepo[] }
    | null;
  if (!b || typeof b !== 'object') throw new Error('Not a backup file.');
  if ((b.app !== 'CANChat Agent' && b.app !== 'CANAgent') || b.kind !== 'backup') {
    throw new Error('Not a CANChat Agent backup file.');
  }
  const storage = (b.storage ?? {}) as Record<string, unknown>;
  return {
    settings: (storage.ba_settings as Settings | undefined) ?? null,
    skills: Array.isArray(storage.ba_skills) ? (storage.ba_skills as Skill[]) : [],
    sites: Array.isArray(storage.ba_sites) ? (storage.ba_sites as SiteEntry[]) : [],
    capabilities: Array.isArray(storage.ba_capabilities) ? (storage.ba_capabilities as CapabilityRegistryEntry[]) : [],
    memory: Array.isArray(storage.ba_memory) ? (storage.ba_memory as MemoryEntry[]) : [],
    memoryGraph: isMemoryGraph(storage.ba_memory_graph) ? storage.ba_memory_graph : emptyMemoryGraph(),
    lessons: Array.isArray(storage.ba_lessons) ? (storage.ba_lessons as LessonEntry[]) : [],
    repos: Array.isArray(b.repos) ? b.repos.map(parseRepo) : [],
  };
}
