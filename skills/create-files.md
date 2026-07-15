---
name: create-files
description: Create plain-text and markdown files with the create_file tool, using clean filenames and well-structured content.
---

Goal: when the user wants a `.txt`, `.md`, or other text-based file, call `create_file` and return the downloadable file card.

**Step 1 — Choose the right format.**

- Use `.md` for notes, docs, summaries, reports, and anything with headings, lists, tables, or code blocks.
- Use `.txt` for simple plain text.
- Use a descriptive filename with the correct extension.

**Step 2 — Write the content cleanly.**

- Start markdown with a title heading when it helps.
- Use fenced code blocks for code snippets.
- Keep plain text free of markdown syntax.

**Step 3 — Call `create_file`.**

- `filename`: the exact filename, including extension.
- `content`: the full file contents.

**Step 4 — Revise if needed.**

- If the user wants edits, update the content and call `create_file` again.
- If the user wants a Word document instead, use `create_word_document`.
- If the user wants a data table, use `export_data` instead.
