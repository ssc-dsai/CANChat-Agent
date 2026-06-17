# CANChat for Word

A Microsoft Word task-pane add-in that lets you use the **model, skills, and knowledge bases** you
configured in the [CANChat Agent](../README.md) browser extension — *inside Word*.

It can't read the extension's storage directly (a Chrome extension and an Office add-in are separate
sandboxes), so it works by **importing the extension's backup file** and reusing the extension's
portable core ([`llmProvider`](../src/background/llmProvider.ts), [`vectorSearch`](../src/shared/vectorSearch.ts),
[`backupFormat`](../src/shared/backupFormat.ts)).

## What works (and what doesn't)

| Capability | In Word |
|---|---|
| **Model** (your endpoint/key/model, Azure + retry) | ✅ Full |
| **Knowledge bases (RAG)** — search your imported repositories, with citations | ✅ Full (vectors come in the backup; only the query is embedded) |
| **Document integration** — ground answers in the selection/document, insert the answer | ✅ |
| **Skills** | ⚠️ Reused as *instruction templates*. Skills written to drive the browser (`list_tabs`, `navigate`, …) can't run here — there's no browser — and are flagged "guidance only". Pure-procedure skills still shape the answer. |

It's a **snapshot**: re-export and re-import to pick up changes you make in the extension.

## Use it

1. In the extension: **Settings → Data & privacy → Backup & Restore → Export backup**.
2. In Word: open the **CANChat** task pane → **Import backup…** and choose that JSON file.
3. Pick a knowledge base (or "None"), optionally tick **Use the selected text / document as context**,
   type a question (use `/skill` to apply a skill, `#name` to target a knowledge base), and **Ask**.
4. **Insert answer** drops the result into your document at the cursor/selection.

## Develop

```bash
npm run addin:typecheck         # tsc over word-addin/
npm run addin:build             # bundle → word-addin/dist
npx office-addin-dev-certs install   # one-time: localhost HTTPS certs (Office requires HTTPS)
npm run addin:dev               # HTTPS dev server on https://localhost:3000
npx office-addin-debugging start word-addin/manifest.xml   # sideload into Word
```

(Install the dev tooling once: `npm i -D office-addin-debugging office-addin-dev-certs`. For full
Office IntelliSense, `npm i -D @types/office-js` — the add-in ships a minimal ambient shim so it
builds without it.)

## The CORS caveat

The add-in calls your model/embeddings endpoint from the task-pane webview, which has no
`<all_urls>` permission like the extension. So the **endpoint must allow the add-in's origin**:

- **Azure OpenAI** — add `https://localhost:3000` (and your prod host) to the resource's CORS allow-list.
- **Local models** (Ollama/LM Studio) — set their CORS/origins option.
- **api.openai.com** — blocks browser CORS entirely; use the bundled proxy:
  ```bash
  TARGET=https://api.openai.com/v1 npm run addin:proxy   # http://localhost:8787
  ```
  then set the add-in's **Endpoint base URL** (Settings) to `http://localhost:8787/v1`.
