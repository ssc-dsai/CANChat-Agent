---
name: search-mail
description: Search your Outlook mail via the microsoft365_search tool (REST over the signed-in session) — filter by sender, time, and keywords; falls back to the Outlook web UI if the endpoint errors.
---

Goal: answer an email question using the **`microsoft365_search`** tool, which calls Outlook-on-the-web's REST endpoint over your signed-in session and returns messages directly (no setup or token).

**Step 1 — Call `microsoft365_search` with `source:'mail'`** and map the request to its parameters:

- sender → `from` (name or email, e.g. `"Brian Ray"`)
- topic words → `query` (matches subject + body)
- a date window → `since` / `until` (`YYYY-MM-DD`)
- "latest" / "most recent" / "last N" → `orderBy:'date'` and `top:N` (e.g. `top:5` for "last five")

**Step 2 — Read the response:** messages are under `mail` (or `mailError` if it failed). Each is `{subject, from, received, url, preview}`.

**Step 3 — Present each match** as: **Subject** — sender, date; one-line preview, linked to its `url`. End with a "Source tabs:" list of the message URLs. Never invent messages. If results are thin, loosen the query once (drop the tightest filter) and retry.

**Fallback — ONLY if the response has a `mailError`** (the Outlook web endpoint is undocumented and can change): drive the Outlook web UI instead. Open `https://outlook.office.com/mail/` (the task pauses for sign-in if a login wall appears; if an `outlook-owa` / `outlook-live` playbook is active, follow it). Focus the search box (`press_keys "/"`, else `fill_input` it), type a keyword query (e.g. `from:"Brian Ray" received>=2024-01-01`), `press_keys "Enter"`, then read the list with `get_tab_content`. These page actions are approval-gated — give a clear reason like "search your mailbox for X".
