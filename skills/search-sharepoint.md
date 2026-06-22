---
name: search-sharepoint
description: Search SharePoint precisely — translate the request into KQL (filename, filetype, site path, author, date) and run sharepoint_search for accurate results.
---

Goal: turn a plain-language SharePoint request into a precise query so results are accurate.

**First choice:** call the **`microsoft365_search`** tool with `{source:'files', fileType, sitePath, editedByMe, since/until, query, orderBy}` — it searches your files over the signed-in session (SharePoint **and** OneDrive). The KQL mapping below applies equally to the simpler `sharepoint_search` tool if you use that instead.

The `sharepoint_search` tool uses the SharePoint Search REST API, whose query language is KQL — the **same** query language and managed properties Microsoft Graph Search (`/search/query`) uses, so this translation transfers directly to Graph. Pass your KQL as the tool's `query`.

**Step 1 — Extract the intent and map each part to a KQL clause:**

- Free words about the topic → leave as plain terms (matches content + title).
- A file name → `filename:"Q3 Budget"` (use quotes for phrases).
- A document type → `filetype:xlsx` (or `docx`, `pptx`, `pdf`). Several: `(filetype:docx OR filetype:pdf)`.
- A specific site/library → `path:"https://<tenant>.sharepoint.com/sites/<Site>"` — this is how you scope to ONE site; without it search is tenant-wide.
- An author/editor → `author:"Jane Doe"` or `Editor:"Jane Doe"`.
- A date constraint → `LastModifiedTime>=2024-01-01` (and/or `<2025-01-01`). For "recent", prefer `sortBy:'modified'` over a date clause.
- "files I edited / my files" → set the tool arg `editedByMe:true` (it resolves your identity); do not hand-write an `Editor` clause for yourself.

Combine clauses with `AND` / `OR` / `NOT` and parentheses, e.g. `budget filetype:xlsx path:"https://contoso.sharepoint.com/sites/Finance"`.

**Step 2 — Resolve the site path** when the user names a site but not its URL. Ask for the site URL, or if a `*.sharepoint.com` tab is open, use its origin + `/sites/<name>`. The tool's base tenant is taken from Settings or an open SharePoint tab automatically; the `path:` clause is only for narrowing to a site.

**Step 3 — Call `sharepoint_search`** with: `query` (your KQL), `top` (default 10, up to 25), `sortBy:'modified'` for "latest/recent" requests else `'relevance'`, `editedByMe:true` when the user means their own files.

**Step 4 — If zero or weak results, loosen once:** drop the most restrictive clause (often `filetype` or a tight phrase), or widen a quoted phrase to individual terms, and retry before reporting nothing.

**Step 5 — Present each hit** as: **Title** (linked to its URL) — file type, last modified, editor; one-line snippet. End with the standard "Source tabs:" list of the result URLs. Never invent files not in the results.

Note: this rides your signed-in browser session (cookie auth) against SharePoint Search — there is no Graph bearer-token call. If results require Graph-only data you cannot reach it here; say so plainly.
