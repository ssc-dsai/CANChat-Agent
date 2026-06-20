# CANChat Agent — loadable skills

Each `*.md` file here is a self-contained **skill** in Claude "Agent Skill" format:
`---`-fenced frontmatter (`name`, `description`) followed by a Markdown instruction
body. They are plain instructions for the agent — no bundled scripts — so they import
and run as-is.

## Skills

| File | Skill | What it does |
|---|---|---|
| [`search-sharepoint.md`](search-sharepoint.md) | `/search-sharepoint` | Translate a request into precise KQL (filename / filetype / site `path:` / author / date) and run `sharepoint_search`. |
| [`search-mail.md`](search-mail.md) | `/search-mail` | Translate a request into mail KQL keywords (`from` / `to` / `subject` / `received` / `hasattachments`) and run the search in the signed-in Outlook web app. |

## Loading a skill

In the side panel: **Settings → Skills**, then either:

- **Import from URL** — paste the raw URL of a file here (e.g. the
  `raw.githubusercontent.com` link; GitHub `blob` URLs are rewritten automatically), or
- open the file, copy its contents, and **Add skill** by pasting the body and filling
  in the name/description.

Once added, invoke it from the composer by typing `/<name>` (e.g. `/search-mail find
unread mail from finance with attachments`).

> Note: `/search-sharepoint` and `/search-mail` also ship pre-seeded on a **fresh
> install**. These files are the portable copies — useful for re-importing on an
> existing profile or sharing.
