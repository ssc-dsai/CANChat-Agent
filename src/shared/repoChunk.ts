// Split a document's text into overlapping chunks for embedding/retrieval.
const CHUNK_CHARS = 800;
const OVERLAP_CHARS = 120;

export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK_CHARS);
    // Prefer to break on a paragraph or sentence boundary near the end.
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = window.lastIndexOf('. ');
      const cut = para > CHUNK_CHARS * 0.5 ? para : sentence > CHUNK_CHARS * 0.5 ? sentence + 1 : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - OVERLAP_CHARS;
  }
  return chunks;
}
