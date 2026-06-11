# Atlassian MCP Skill

## Purpose

Provides seamless access to Jira and Confluence through the Atlassian Rovo MCP server without requiring the user to manually create or paste API tokens.

The skill performs OAuth authentication through the user's browser, stores credentials in the agent runtime, discovers available MCP tools, and exposes simple operations such as search, issue retrieval, and page retrieval.

---

## Requirements

### Runtime

- JavaScript/TypeScript execution environment
- Browser automation capability
- Ability to launch external processes
- Ability to persist authentication state
- MCP-compatible client

### Dependencies

```bash
npm install execa
```

---

## Configuration

```yaml
name: atlassian
version: 1.0

mcp:
  server: https://mcp.atlassian.com/v1/mcp/authv2

authentication:
  type: oauth2
  interactive: true
  persistence: local

capabilities:
  - jira_search
  - jira_issue
  - confluence_search
  - confluence_page
  - tool_discovery
```

---

## Authentication Workflow

### First Use

When a user invokes the skill:

```text
User
 └─ Search Jira for CANChat

Skill
 └─ Detects missing credentials

Skill
 └─ Launches OAuth flow

Browser Tool
 └─ Opens Atlassian login page

User
 └─ Authenticates

Atlassian
 └─ Returns authorization

Skill
 └─ Stores session credentials

Skill
 └─ Continues requested operation
```

### Subsequent Uses

```text
User
 └─ Search Jira

Skill
 └─ Uses stored credentials

Atlassian MCP
 └─ Returns results
```

No additional login is required until the refresh token expires.

---

## Agent Interface

### Search

```javascript
await atlassian.search("CANChat architecture");
```

### Retrieve Jira Issue

```javascript
await atlassian.getIssue("AICOE-123");
```

### Retrieve Confluence Page

```javascript
await atlassian.getPage("CANChat Architecture");
```

### Tool Discovery

```javascript
await atlassian.listTools();
```

---

## Reference Implementation

```javascript
import { execa } from "execa";

const ATLASSIAN_MCP_URL =
  "https://mcp.atlassian.com/v1/mcp/authv2";

class AtlassianSkill {
  constructor() {
    this.proc = null;
    this.nextId = 1;
  }

  async connect() {
    this.proc = execa(
      "npx",
      [
        "-y",
        "mcp-remote",
        ATLASSIAN_MCP_URL
      ],
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.proc.stderr.on("data", chunk => {
      const text = chunk.toString();

      const url =
        text.match(/https:\/\/[^\s]+/)?.[0];

      if (url) {
        this.openAuthenticationPage(url);
      }
    });

    await this.initialize();
  }

  openAuthenticationPage(url) {
    console.log("Open:", url);
  }

  async initialize() {
    return this.rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "atlassian-skill",
          version: "1.0"
        }
      }
    );
  }

  async listTools() {
    return this.rpc("tools/list", {});
  }

  async search(query) {
    const tools = await this.listTools();

    const searchTool =
      tools.tools.find(t => /search/i.test(t.name));

    if (!searchTool) {
      throw new Error("Search tool not found.");
    }

    return this.callTool(searchTool.name, { query });
  }

  async callTool(name, args) {
    return this.rpc(
      "tools/call",
      {
        name,
        arguments: args
      }
    );
  }
}
```
