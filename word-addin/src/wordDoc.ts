// Office.js helpers: read what the user has selected (or the whole document) and
// insert generated text back at the cursor/selection. Each call is its own
// Word.run batch so the task pane stays decoupled from document state.

/** Text of the current selection (empty string if nothing is selected). */
export async function getSelectionText(): Promise<string> {
  return Word.run(async (context) => {
    const sel = context.document.getSelection();
    sel.load('text');
    await context.sync();
    return sel.text ?? '';
  });
}

/** Full body text of the document. */
export async function getDocumentText(): Promise<string> {
  return Word.run(async (context) => {
    const body = context.document.body;
    body.load('text');
    await context.sync();
    return body.text ?? '';
  });
}

/** Insert text at the end of the current selection (or at the cursor). */
export async function insertAtSelection(text: string): Promise<void> {
  await Word.run(async (context) => {
    context.document.getSelection().insertText(text, Word.InsertLocation.end);
    await context.sync();
  });
}

/** True when running inside Word (vs a plain browser during development). */
export function inWord(): boolean {
  return typeof Word !== 'undefined' && typeof Word.run === 'function';
}
