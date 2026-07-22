import type { AuthMethod } from './capabilities';
import type { ToolDefinition } from '../background/llmProvider';

export type ToolKind = 'builtin' | 'rest' | 'mcp' | 'webmcp' | 'browser';

export interface UnifiedToolDefinition {
  name: string;
  kind: ToolKind;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
  isReadOnly: boolean;
  sourceId?: string;
  invoke?: {
    endpoint?: string;
    method?: string;
    auth?: { method: AuthMethod; token?: string };
  };
}

export function toLlmToolDefinition(u: UnifiedToolDefinition): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: u.name,
      description: u.description,
      parameters: u.parameters,
    },
  };
}

export function kindForToolName(name: string): ToolKind {
  if (name.startsWith('call_mcp_') || name.startsWith('list_mcp_')) return 'mcp';
  if (name.startsWith('call_webmcp_') || name.startsWith('list_webmcp_')) return 'webmcp';
  return 'builtin';
}
