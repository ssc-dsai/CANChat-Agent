---
name: search-sharepoint
description: Search your SharePoint and OneDrive files via the microsoft365_search tool (REST over the signed-in session) — filter by document type, site, author, and date.
---

Goal: answer a SharePoint/OneDrive file question accurately using the **`microsoft365_search`** tool, which calls the SharePoint/Microsoft Search REST API over your signed-in session (no setup or token; covers SharePoint sites **and** OneDrive).

**Step 1 — Call `microsoft365_search` with `source:'files'`** and map the request to its parameters (let the tool build the query — do not hand-write KQL):

- topic words → `query`
- document type → `fileType` (`docx` | `xlsx` | `pptx` | `pdf`)
- a specific site/library → `sitePath` (its URL, e.g. `https://contoso.sharepoint.com/sites/Finance`)
- "files I edited" / "my files" → `editedByMe:true` (the tool resolves your identity)
- a date window → `since` / `until` (`YYYY-MM-DD`); for "latest/recent" set `orderBy:'date'`
- how many → `top` (default 10, max 25)

**Step 2 — Resolve the site URL** when the user names a site but not its address: ask, or use an open `*.sharepoint.com` tab. The tenant base comes from Settings or an open SharePoint tab automatically.

**Step 3 — Read the response:** results are under `files` (or `filesError` if it failed). If `filesError` says there is no base URL, tell the user to set the SharePoint base URL in Settings (or open a SharePoint tab) and retry.

**Step 4 — If results are empty or weak,** loosen once (drop `fileType`, or simplify the terms) and retry before reporting nothing.

**Step 5 — Present each hit** as: **Title** (linked to its `url`) — file type, last modified, editor; one-line snippet. End with the standard "Source tabs:" list of the result URLs. Never invent files not in the results.

Note: this is REST over your cookie session, not the Graph bearer-token API. The simpler `sharepoint_search` tool (files only) is an alternative if needed. To read a file's full contents, pass its `url` to `read_office_document` or `read_pdf`.
