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

## Install

This is a developer **sideload** — an Office add-in is a locally hosted web app you load into Word;
there's no Store package. You run a small HTTPS dev server and register the manifest with Word.

### Prerequisites

- **Microsoft Word** — Microsoft 365 on Mac or Windows (desktop), or Word on the web.
- **Node 26** (the repo's [mise](https://mise.jdx.dev) toolchain) and this repo cloned.

### Steps

1. **Install dependencies** (once), from the repo root — this also pulls the add-in build + sideload
   tooling (`office-addin-debugging`, `office-addin-dev-certs`, `@types/office-js`):
   ```bash
   mise run install     # or: npm install
   ```
2. **Trust the localhost HTTPS certificate** (once) — Office only loads task panes over HTTPS:
   ```bash
   npm run addin:certs  # prompts for your password to trust a local dev cert
   ```
3. **Start the HTTPS dev server** and leave it running:
   ```bash
   npm run addin:dev    # serves https://localhost:3000 using the cert from step 2
   ```
4. **Sideload into Word**, in a second terminal:
   ```bash
   npm run addin:sideload   # validates the manifest, registers it, and opens Word
   ```
   Word opens with the add-in registered. On the **Home** tab, a **CANChat** group appears → click
   **Open CANChat** to show the task pane. (`npm run addin:stop` unregisters it.)

### Manual sideload (if you skip step 4)

Keep the dev server (step 3) running, then:

- **Mac:** copy `word-addin/manifest.xml` into `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`
  (create the `wef` folder if needed), restart Word, then **Insert → Add-ins → My Add-ins** (Developer
  Add-ins) → **CANChat for Word**.
- **Windows:** put `manifest.xml` in a folder and share it; in Word, **File → Options → Trust Center →
  Trust Center Settings → Trusted Add-in Catalogs**, add the share path, tick *Show in Menu*, restart
  Word, then **Insert → My Add-ins → Shared Folder**.
- **Word on the web:** **Insert → Add-ins → Upload My Add-in** → choose `word-addin/manifest.xml`.

> **Before it can answer**, the add-in must reach your model endpoint from the browser — see
> [The CORS caveat](#the-cors-caveat) below.

### Production install (later)

Host `word-addin/dist` (`npm run addin:build`) on any HTTPS server, replace the `https://localhost:3000`
URLs **and** the `<Id>` GUID in `manifest.xml`, and distribute the manifest through your Microsoft 365
admin center (Integrated Apps) or per-user **Upload My Add-in**.

## Use it

1. In the **extension**: Settings → Data & privacy → Backup & Restore → **Export backup**.
2. In **Word**: open the **CANChat** task pane → **Import backup…** and choose that JSON file.
3. Pick a knowledge base (or "None"), optionally tick **Use the selected text / document as context**,
   type a question (`/skill` to apply a skill, `#name` to target a knowledge base), and **Ask**.
4. **Insert answer** drops the result into your document at the cursor/selection.

## Develop

```bash
npm run addin:typecheck   # tsc over word-addin/ (uses @types/office-js)
npm run addin:build       # bundle → word-addin/dist
npm run addin:dev         # HTTPS dev server (https://localhost:3000)
npm run addin:sideload    # register the manifest with Word
npm run addin:stop        # unregister it
```

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
