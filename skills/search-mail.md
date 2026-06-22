---
name: search-mail
description: Search Outlook mail precisely — translate the request into mail KQL keywords (from / to / subject / received / hasattachments) and run the search in the signed-in Outlook web app.
---

Goal: turn a plain-language email request into a precise keyword query, then run it.

**First choice:** call the **`microsoft365_search`** tool with `{source:'mail', from, query, since/until, orderBy:'date', top}` — it searches your mailbox over the signed-in session and returns messages directly. Only fall back to driving the Outlook web UI (the steps below) if that tool returns a `mailError`.

The keyword syntax below is exactly what Microsoft Graph mail search (`/me/messages?$search='…'`) uses as KQL, and it is also what the Outlook web search box accepts — so the same translated query works in both. (This skill executes over the signed-in Outlook web UI; there is no Graph bearer-token call.)

**Step 1 — Extract the intent and map each part to a keyword:**

- Sender → `from:"Jane Doe"` or `from:jane@contoso.com`.
- Recipient → `to:jane@contoso.com` (or `cc:`, `participants:` for anyone on the thread).
- Words in the subject → `subject:"quarterly budget"`.
- Words anywhere in the body → `body:"renewal"` (or just bare terms for subject+body).
- Date / recency → `received:today`, `received:"this week"`, or `received>=2024-01-01` (and/or `received<2024-02-01`).
- Attachments → `hasattachments:yes` (Graph `$filter` equivalent: `hasAttachments eq true`).
- Unread / flagged / importance → `isread:no`, `isflagged:yes`, `importance:high`.
- An exact phrase → wrap in quotes. Combine clauses with `AND` / `OR` / `NOT` and parentheses.

Example: `from:finance subject:"Q3 budget" hasattachments:yes received>=2024-01-01`.

**Step 2 — Make sure Outlook is open and signed in:** if no `outlook.office.com` (work) or `outlook.live.com` (personal) tab is open, open one (e.g. `https://outlook.office.com/mail/`). If a login wall appears, the task pauses for the user to sign in, then resumes. If an `outlook-owa` / `outlook-live` playbook is active, follow it for the app mechanics.

**Step 3 — Run the search in the OWA search box:** focus it (`press_keys "/"` often focuses it, else `fill_input` the search field), enter the translated query, then `press_keys "Enter"`. These actions are approval-gated — give a clear reason like "search your mailbox for X".

**Step 4 — Read the result list** with `get_tab_content` (or `read_app_content` for the virtualized list). If a hit needs detail, open it (ArrowDown/Enter) and read the reading pane.

**Step 5 — Present each match** as: **Subject** — sender, date, unread/attachment flags; one-line snippet. Link to the message when a URL is available. Never invent messages that were not in the results. If results are thin, loosen the query once (drop the tightest clause or widen a quoted phrase) and retry.
