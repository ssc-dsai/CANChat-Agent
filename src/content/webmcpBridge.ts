// WebMCP bridge — runs in the page's MAIN world at document_start. WebMCP
// (the emerging navigator.modelContext proposal) lets a page register tools for
// an in-browser agent. The browser's native agent would receive them; we are an
// extension, so we install a minimal shim that records what the page registers
// into a page global the extension can read via executeScript.
//
// Passive: it only captures tools the page voluntarily registers. It reads no
// page content and changes no page behaviour.

interface WebMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  execute?: (args: unknown) => unknown;
}

interface Registry {
  tools: Map<string, WebMcpTool>;
}

(() => {
  const w = window as unknown as {
    __CANAGENT_WEBMCP__?: Registry;
    navigator: Navigator & { modelContext?: Record<string, unknown> };
  };

  // Single shared registry for this page.
  const registry: Registry = w.__CANAGENT_WEBMCP__ ?? { tools: new Map<string, WebMcpTool>() };
  Object.defineProperty(w, '__CANAGENT_WEBMCP__', {
    value: registry,
    writable: false,
    enumerable: false,
    configurable: true,
  });

  const record = (tool: WebMcpTool | undefined) => {
    if (tool && typeof tool.name === 'string' && tool.name) registry.tools.set(tool.name, tool);
  };
  const recordMany = (tools: unknown) => {
    if (Array.isArray(tools)) tools.forEach((t) => record(t as WebMcpTool));
  };

  const existing = w.navigator.modelContext as
    | {
        registerTool?: (tool: WebMcpTool) => unknown;
        provideContext?: (ctx: { tools?: WebMcpTool[] }) => unknown;
        unregisterTool?: (name: string) => unknown;
      }
    | undefined;

  if (existing) {
    // Wrap an existing (e.g. native or polyfilled) implementation so we still
    // capture registrations, then delegate to the original.
    const origRegister = existing.registerTool?.bind(existing);
    const origProvide = existing.provideContext?.bind(existing);
    if (origRegister) {
      existing.registerTool = (tool: WebMcpTool) => {
        record(tool);
        return origRegister(tool);
      };
    }
    if (origProvide) {
      existing.provideContext = (ctx: { tools?: WebMcpTool[] }) => {
        recordMany(ctx?.tools);
        return origProvide(ctx);
      };
    }
    return;
  }

  // No implementation present — install a minimal shim covering the proposal's
  // registration entry points.
  const modelContext = {
    registerTool(tool: WebMcpTool) {
      record(tool);
      return () => registry.tools.delete(tool?.name);
    },
    unregisterTool(name: string) {
      registry.tools.delete(name);
    },
    provideContext(ctx: { tools?: WebMcpTool[] }) {
      recordMany(ctx?.tools);
    },
  };
  try {
    Object.defineProperty(w.navigator, 'modelContext', {
      value: modelContext,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // navigator is read-only in some contexts; nothing else we can do.
  }
})();
