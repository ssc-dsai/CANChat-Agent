# CANAgent — User Training Script

**Audience:** Government of Canada employees (program, policy, corporate, and analyst roles)
**Format:** Instructor-led or self-paced
**Duration:** ~90 minutes (60 min core + 30 min hands-on use cases)
**Prerequisites:** A Chromium browser (Chrome or Edge), and an **approved** OpenAI-compatible model endpoint provided by your department (base URL + API key + model name). See **Module 0 — Security & Compliance** before configuring anything.

> CANAgent is a browser side-panel AI assistant that uses *your already-signed-in browser* as its toolset. It can read the page you're on, your open tabs, PDFs and Office files, search your SharePoint, and build small on-device document libraries you can ask questions against. It is sometimes referred to internally as "CANAssist" — the panel and toolbar say **CANAgent**.

---

## How to use this script

Each module has:
- **🎙 Say** — facilitator talking points (paraphrase freely).
- **🧑‍💻 Do** — hands-on steps the learner performs.
- **✅ Check** — a quick knowledge check before moving on.

If self-paced, just follow the **Do** and **Check** items.

---

## Module 0 — Security & Compliance (do not skip)

**🎙 Say:**
CANAgent is powerful *because* it can see what you can see and send it to an AI model. That is exactly why we start here. Three facts shape everything you do with it:

1. **Where your data goes.** Whatever the agent reads to answer you — the page text, your prompt, a document's contents — is sent to the **model endpoint configured in Settings**. Choose that endpoint deliberately.
2. **What stays local.** Your API key, your saved settings, your on-device "repositories" (document libraries), and their search index live **only in this browser profile on this device**. They are not synced to the cloud. *However*, building a repository sends each document's text to the endpoint once (to compute embeddings).
3. **It acts as you.** The agent uses your authenticated sessions — SharePoint, email, internal apps. It can only see what your account can see, and it must **ask your approval before any action that changes something** (clicking, submitting, running code).

**Departmental rules come first.** Before using CANAgent on any real work:
- Follow the **TBS *Guide on the use of generative AI*** and **your department's GenAI direction**. If your department has not authorized a generative-AI tool for a given activity, do not use it for that activity.
- **Know your classification.** Only point CANAgent at an endpoint that is **approved for the classification of the information you are handling** (Unclassified, Protected A, Protected B, etc.). Do **not** send Protected or sensitive information to a public/commercial AI service unless your department has formally assessed and approved that service for that purpose. When in doubt, prefer a **departmental or on-premises ("sovereign") endpoint**.
- **Human in the loop.** Treat every output as a *draft from a fallible assistant*. Verify facts against the cited sources. You remain accountable for anything you act on or send.
- **Records & ATIP.** Outputs you rely on for a decision may be subject to information-management and access-to-information obligations — manage them like any other work record.
- **Official languages.** CANAgent can help draft or summarize in English and French, but it is **not** a substitute for the Translation Bureau for authoritative or published translations. Always have a human review bilingual output.

**✅ Check:** *In one sentence — when you ask CANAgent to summarize a document, where does that document's text go?* (Answer: to the model endpoint configured in Settings — so that endpoint must be approved for the document's classification.)

---

## Module 1 — What CANAgent is, and the mental model

**🎙 Say:**
Think of CANAgent as a capable assistant sitting in a panel beside your browser. You give it a goal in plain language; it decides which browser "tools" to use — reading the current tab, opening search results, reading a PDF, searching SharePoint — and comes back with an answer, usually with source links. For multi-step tasks it shows a **plan** and a running **tool activity** log so you can see what it's doing. It is **not** a chatbot disconnected from your work; its whole point is to operate on the pages and documents in front of you.

What it can do, at a glance:
- Answer questions about the **current tab** or **several open tabs**.
- **Research** on the open web and synthesize across pages (it groups the tabs it opens).
- Read **PDFs** and **Office files** (`.docx`, `.pptx`, `.xlsx`) the browser would otherwise just download.
- **Search your SharePoint** using your signed-in session — including "the files I edited recently."
- Build small **on-device document libraries** ("repositories") and answer questions from them with citations.
- **Extract tables** to CSV/JSON, **operate web apps** (with your approval for any change), and learn **playbooks** for sites you use often.

**✅ Check:** *Name two things CANAgent can read that a normal copy-paste into a chatbot could not easily handle.* (e.g., a cookie-gated PDF you're logged into; an Excel file the browser downloads; your SharePoint search results.)

---

## Module 2 — Installation & first-run configuration

> **Managed-device note:** GC workstations are often managed, and loading a browser extension may require your department's approval or a managed deployment. If you cannot enable Developer Mode or load the extension, **stop and contact your IT service desk** — do not attempt to bypass device controls. The steps below assume you have been cleared to install it.

**🧑‍💻 Do — install the extension:**
1. Obtain the built extension folder (`dist/`) from your department's distribution, **or** build it from source if you have the repository:
   - `mise run install` then `mise run build` (or `npm install && npm run build`). This produces the `dist/` folder.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `dist/` folder.
5. Pin **CANAgent** to the toolbar, then click its icon to open the **side panel**.

**🧑‍💻 Do — configure your model (one time):**
1. In the side panel, click the **gear (Settings)** icon.
2. Fill in, using the values your department provided:
   - **Endpoint base URL** — e.g. `https://<your-approved-gateway>/v1`
   - **API key** — stored only on this device.
   - **Model** — the chat model id.
   - *(Optional)* **Embedding model** — only needed if you'll build repositories; set it to your endpoint's embeddings model id.
   - *(Optional)* **SharePoint base URL** — e.g. `https://<tenant>.sharepoint.com` (or leave blank to auto-detect from an open SharePoint tab).
   - *(Optional)* **Custom instructions** — persistent guidance, e.g. *"Answer in Canadian English. I work in <program area>; prefer precise, policy-aware language."*
3. Click **Test connection** → you should see a success message. Click **Save**.

**✅ Check:** *Where is your API key stored, and is it synced to other devices?* (On this device only; not synced.)

---

## Module 3 — Interface tour

**🎙 Say / 🧑‍💻 Do (point each out):**
- **Header:** the CANAgent title and a live **status** (idle / thinking / acting), a **text-size** control (A− / A+), a **clear-conversation** (trash) button — which also stops a running task — and the **Settings** gear.
- **Tab-context bar** (under the header):
  - **Snapshot** — capture the visible part of the current tab as an *image* for the model (for dashboards/charts the text tools can't read). *Needs a vision-capable model.*
  - **OCR Page** — scroll-and-capture the *whole* page as images (for long or canvas-rendered pages). *Vision model, token-heavy — a last resort.*
  - **Refresh** — re-read what's in context.
  - **Repository box** (with **+ Tab** / **+ Group** and a **✕** to clear) — capture pages into an on-device library (Module 7).
- **Composer (the message box):** type your request. Two shortcuts:
  - **`@`** → pick a **bookmark**; the agent will open and read *that exact page*.
  - **`#`** → pick a **repository**; the agent will search *that exact library*.
  - **`/`** → run a **skill** (reusable instruction set), including the built-in **`/learn`**.
- **Plan panel & Tool activity:** appear during multi-step tasks so you can watch the steps and any **approval** prompts.

**✅ Check:** *Which button would you use to let the agent read a chart image that text extraction can't see?* (Snapshot — with a vision-capable model.)

---

## Module 4 — Core skill: ask about the page and the web

**🧑‍💻 Do — current page:**
1. Open a Canada.ca policy or program page.
2. In the panel, ask: *"Summarize this page in five bullet points and list any obligations or deadlines."*
3. Note the answer ends with a **source** link.

**🧑‍💻 Do — guided web research:**
1. Ask: *"Find the current federal public service mental-health support offerings and summarize the main programs, with sources."*
2. Watch CANAgent open results into a **named tab group** (e.g. "Heron") and read across them. It will mention the group name; you can later say *"summarize the pages in the Heron group."*

**🎙 Say:** Notice it **cites sources** and uses the site's own pages rather than guessing. Always click through and verify before relying on anything.

**✅ Check:** *Why does the agent open research pages into a named tab group?* (To keep your window organized and let you refer back to that set by name.)

---

## Module 5 — Documents: PDFs and Office files

**🎙 Say:**
The browser shows PDFs as an image and *downloads* Office files — so neither is readable by ordinary page tools. CANAgent has dedicated readers that fetch the file with your signed-in session and extract the text.

**🧑‍💻 Do:**
1. Open (or have a link to) a long **PDF** — e.g. a Treasury Board directive. Ask: *"What are the key requirements and who do they apply to?"* (`read_pdf`)
2. With a **Word** file (`.docx`): *"Summarize this document and list any action items."* (`read_office_document`)
3. With a **PowerPoint** deck (`.pptx`): *"Turn this deck into concise speaking notes, slide by slide."*
4. With an **Excel** file (`.xlsx`): *"Which line items changed the most between the two quarters?"* — remember spreadsheets return **raw cell values**, so verify any figure.

**🎙 Say (limits):** Scanned/image-only PDFs have no text layer (use **Snapshot/OCR + a vision model**). Legacy `.doc/.xls/.ppt` are not supported — re-save as the modern format. Spreadsheets give raw values, not formatted/computed display, so check numbers and dates.

**✅ Check:** *A colleague sends a `.pptx` that your browser downloads. How do you get CANAgent to read it?* (Open/point it at the file and ask — it uses `read_office_document`.)

---

## Module 6 — SharePoint: find and summarize your documents

**🎙 Say:**
Using your existing SharePoint session (no extra sign-in or app registration), CANAgent can search your sites and return passages with the source links — including **who created/modified** each file and **when**.

**🧑‍💻 Do:**
1. Make sure you're signed into SharePoint in the browser (and the **SharePoint base URL** is set in Settings, or a SharePoint tab is open).
2. Ask: *"Show the last five files I edited on SharePoint."* (sorts by most-recently-modified, limited to you).
3. Then: *"Summarize the most recent one and list any open questions."*
4. Try a topic search: *"Search SharePoint for our onboarding checklist and quote the relevant section."*

**🎙 Say (limits):** It only sees what **you** are allowed to see. The "files I edited" filter relies on your tenant's search configuration and matches by display name, so treat it as a strong hint, not a perfect audit. Snippets are short — for deep analysis, open the document or ingest it into a repository (next module).

**✅ Check:** *True or false: CANAgent can see SharePoint files your account has no access to.* (False — it uses your session.)

---

## Module 7 — On-device repositories (your private, searchable library)

**🎙 Say:**
A **repository** is a small, on-device library of documents you've captured. CANAgent chunks each one, computes embeddings (via your endpoint), and stores the text + index **locally** so you can ask questions across all of them and get answers **with citations**. Great for a set of directives, a program's reference pages, or a stack of reports you keep returning to.

> **Compliance reminder:** building a repository sends each document's text to your endpoint once (for embeddings). Only ingest material that is appropriate for that endpoint's approved classification.

**🧑‍💻 Do — build one:**
1. Open a relevant page or document (a directive PDF, a Canada.ca page, a `.docx`).
2. In the tab-context bar, type a repository name (e.g. `Directives`) — the box also lists repos you already have.
3. Click **+ Tab** to add the current tab (or **+ Group** to add every page in the conversation's tab group).
4. Repeat for a few documents. Re-adding the same page will **prompt you to replace** the existing copy (no silent duplicates).

**🧑‍💻 Do — use it:**
5. Ask: *"In #Directives, what are the requirements for records retention?"* (the `#` picks the repository explicitly). The answer cites each source page/document.
6. Manage it under **Settings → Repositories**: expand a repository to **delete individual documents**, or remove the whole thing.

**✅ Check:** *Where do a repository's text and search index live, and are they synced?* (On this device only; not synced.)

---

## Module 8 — Power features: mentions, skills, playbooks, memory

**🧑‍💻 Do — explicit targets:**
- **`@bookmark`** → the agent opens and reads *that exact page* (no web search). Good for a directive you bookmarked.
- **`#repository`** → the agent searches *that exact library*.

**🧑‍💻 Do — extract a table:**
- On a page or report with tabular data: *"Extract the program, lead, and due date into a table."* You'll get a **download card** with **CSV** and **JSON** buttons for your tracker.

**🧑‍💻 Do — teach a site (app playbook):**
- On an internal tool you use often, type **`/learn`**. CANAgent explores the app and saves a reusable **playbook**, so next time it knows how to operate that tool. Review what it saved.

**🧑‍💻 Do — operate a web app (with approval):**
- Ask it to perform a UI action (e.g., *"open the most recent item in this list"*). For anything that **changes state** (clicking, submitting, running code), CANAgent shows an **approval card** explaining *what* and *why* — read it, then **Approve** or **Deny**. Approve deliberately.

**🎙 Say — memory (optional, off by default):** In Settings you can enable a small persistent **memory** (e.g., your role, preferred style). Keep it free of sensitive specifics.

**✅ Check:** *Before CANAgent submits a form on your behalf, what happens?* (It pauses and asks you to approve, with a plain-language reason.)

---

## Example use cases for a GC employee

Use these as ready-made practice scenarios. Adapt the wording to your program. **Mind the classification of anything you point it at.**

1. **Policy triage.** Open a long Treasury Board / departmental directive (PDF). *"List the mandatory requirements, who they apply to, and any dates, with the section numbers."*
2. **Briefing prep from a deck.** With a `.pptx`: *"Produce a one-page summary and three anticipated questions a senior executive might ask."*
3. **Recent work catch-up.** *"Show the last five files I edited on SharePoint, then summarize the two most recent."*
4. **Cross-document Q&A.** Build a repository `ProgramX` from several reference pages + a PDF, then: *"In #ProgramX, what are the eligibility criteria and where do they conflict?"*
5. **Spreadsheet sense-making.** With a budget `.xlsx`: *"Summarize spending by category and flag the three largest variances."* (Then verify the figures.)
6. **Plain-language rewrite.** On a dense web page: *"Rewrite this as plain-language guidance for the public at a Grade 8 reading level."*
7. **Bilingual drafting (review required).** *"Draft a short bilingual notice (EN/FR) announcing this change, for human review."*
8. **Web research with sources.** *"Compare the eligibility rules across these three Canada.ca program pages and produce a table with citations."*
9. **Meeting/record extraction.** From notes or a transcript page: *"Extract decisions and action items (owner, due date) into a table"* → export CSV.
10. **Inbox/site navigation.** *"In this SharePoint library, find the most recent version of the onboarding checklist and quote its first section."*
11. **Teach an internal tool.** Run **`/learn`** on a departmental web application so future asks ("create a new entry titled …") are reliable — approving each change.
12. **Quick comparison.** Open two program pages in tabs: *"What changed between these two versions of the guidance?"*

---

## Do's and Don'ts (print this)

**Do**
- ✅ Confirm your **endpoint is approved** for the classification of what you're handling.
- ✅ **Verify** outputs against cited sources before using them.
- ✅ Use **repositories** and **SharePoint search** to ground answers in real documents.
- ✅ **Read approval prompts** before approving any state-changing action.
- ✅ Manage outputs as **records** where required.

**Don't**
- ❌ Don't send **Protected/sensitive** information to an endpoint not approved for it.
- ❌ Don't treat outputs as authoritative — especially **figures, legal/financial details, and translations**.
- ❌ Don't bypass managed-device controls to install it.
- ❌ Don't store sensitive specifics in **memory** or custom instructions.
- ❌ Don't auto-approve actions — approve each one deliberately.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "No model configured" / Test connection fails | Re-check the **base URL, API key, model** in Settings. Confirm the endpoint is reachable from your network. |
| Embeddings error (e.g. 403) when building a repository | Set the **Embedding model** field to your endpoint's embeddings model id (it differs from the chat model). |
| `read_pdf` returns little/no text | The PDF is **scanned/image-only** (no text layer) — use **Snapshot/OCR + a vision model** — or it's behind more than a simple cookie request. |
| An Office file won't read | Must be **OOXML** (`.docx/.pptx/.xlsx`). Re-save legacy `.doc/.xls/.ppt` to the modern format. |
| SharePoint search fails or "files I edited" is empty | Ensure you're **signed into SharePoint**, the **base URL** is set, and your tenant's search is configured; the editor filter matches by display name and varies by tenant. |
| Snapshot/OCR gives a weak answer | You need a **vision-capable model** configured. |
| Can't load the extension | Managed-device restriction — **contact IT**, don't bypass controls. |

---

## Facilitator notes

**Suggested timing (90 min):** Module 0 (10) · 1 (5) · 2 (15) · 3 (5) · 4 (10) · 5 (10) · 6 (10) · 7 (10) · 8 (5) · Use-case practice (10).

**Materials to prepare:** an approved endpoint's base URL/key/model; a sample PDF, `.docx`, `.pptx`, `.xlsx`; access to a non-sensitive SharePoint site; a couple of Canada.ca pages.

**Close with:** the **Do's and Don'ts** card and a reminder that **accountability stays with the employee** — CANAgent is an assistant, not an authority.
