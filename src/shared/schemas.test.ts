import { describe, expect, it } from 'vitest';
import { MEMORY_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from './schemas';

const ALL = [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS];

describe('tool definitions contract', () => {
  it('every tool name is unique', () => {
    const names = ALL.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has a non-empty description', () => {
    for (const t of ALL) {
      expect(t.function.description, t.function.name).toBeTruthy();
      expect(t.function.description.length, t.function.name).toBeGreaterThan(10);
    }
  });

  it('every tool has an object parameter schema', () => {
    for (const t of ALL) {
      const p = t.function.parameters as { type?: string; properties?: object; required?: unknown };
      expect(p.type, t.function.name).toBe('object');
      expect(typeof p.properties, t.function.name).toBe('object');
      expect(Array.isArray(p.required), t.function.name).toBe(true);
    }
  });

  it('every required key exists in properties', () => {
    for (const t of ALL) {
      const p = t.function.parameters as { properties: Record<string, unknown>; required: string[] };
      for (const key of p.required) {
        expect(Object.keys(p.properties), `${t.function.name}.${key}`).toContain(key);
      }
    }
  });

  it('any tool exposing a "reason" parameter requires it (approval convention)', () => {
    for (const t of ALL) {
      const p = t.function.parameters as { properties: Record<string, unknown>; required: string[] };
      if ('reason' in p.properties) {
        expect(p.required, t.function.name).toContain('reason');
      }
    }
  });

  it('includes the MCP and WebMCP tools', () => {
    const names = ALL.map((t) => t.function.name);
    for (const n of ['list_mcp_tools', 'call_mcp_tool', 'list_webmcp_tools', 'call_webmcp_tool']) {
      expect(names).toContain(n);
    }
  });
});
