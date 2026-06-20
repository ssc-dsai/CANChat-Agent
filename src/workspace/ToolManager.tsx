import { useEffect, useState } from 'preact/hooks';
import type { CapabilityRegistryEntry } from '../shared/capabilities';
import { kindForToolName, type UnifiedToolDefinition } from '../shared/unifiedTools';
import { TOOL_DEFINITIONS } from '../shared/schemas';

export function ToolManager() {
  const [capabilities, setCapabilities] = useState<CapabilityRegistryEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get('ba_capabilities').then((r) => {
      const caps = r.ba_capabilities as CapabilityRegistryEntry[] | undefined;
      if (Array.isArray(caps)) setCapabilities(caps);
    });
  }, []);

  const builtInTools: UnifiedToolDefinition[] = TOOL_DEFINITIONS.map((t) => ({
    name: t.function.name,
    kind: kindForToolName(t.function.name),
    description: t.function.description,
    parameters: t.function.parameters,
    requiresApproval: false,
    isReadOnly: true,
  }));

  return (
    <div class="ws-tool-manager">
      <h2>Built-in tools</h2>
      <ul class="ws-tool-list">
        {builtInTools.map((t) => (
          <li key={t.name} class="ws-tool-item" onClick={() => setExpanded(expanded === t.name ? null : t.name)}>
            <span class="ws-tool-kind">{t.kind}</span>
            <span class="ws-tool-name">{t.name}</span>
            {expanded === t.name && (
              <p class="ws-tool-desc">{t.description}</p>
            )}
          </li>
        ))}
      </ul>

      {capabilities.length > 0 && (
        <>
          <h2>Registered capabilities</h2>
          <ul class="ws-tool-list">
            {capabilities.map((c) => (
              <li key={c.id} class="ws-tool-item" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                <span class="ws-tool-kind">{c.kind}</span>
                <span class="ws-tool-name">{c.name}</span>
                {expanded === c.id && (
                  <div class="ws-tool-desc">
                    <p>{c.description}</p>
                    {c.url && <p>URL: {c.url}</p>}
                    {c.mcpUrl && <p>MCP: {c.mcpUrl}</p>}
                    {c.tags && c.tags.length > 0 && <p>Tags: {c.tags.join(', ')}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
