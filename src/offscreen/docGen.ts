// =============================================================================
// Markdown → .docx generation, run in the offscreen document (so the docx
// library and its Blob/packer work have a real Window and don't weigh down the
// service-worker bundle). Called from offscreen.ts for the `generate_document`
// op behind the agent's create_word_document tool.
//
// We tokenize the agent-supplied markdown with `marked` (already a dependency)
// and map the common block/inline tokens onto docx elements. The mapping is
// intentionally pragmatic — headings, paragraphs, bold/italic/code, lists,
// tables, code blocks, blockquotes — not a full markdown renderer.
// =============================================================================

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { marked, type Token, type Tokens } from 'marked';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
}

/** Flatten inline tokens (strong/em/codespan/link/text…) into styled TextRuns. */
function runsFromInline(tokens: Token[] | undefined, style: RunStyle = {}): TextRun[] {
  if (!tokens) return [];
  const out: TextRun[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
        out.push(...runsFromInline((tok as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runsFromInline((tok as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case 'codespan':
        out.push(new TextRun({ text: (tok as Tokens.Codespan).text, font: 'Courier New', ...style }));
        break;
      case 'link':
        out.push(...runsFromInline((tok as Tokens.Link).tokens, style));
        break;
      case 'br':
        out.push(new TextRun({ break: 1 }));
        break;
      default: {
        const text = 'text' in tok ? String((tok as { text: string }).text) : '';
        if (text) out.push(new TextRun({ text, bold: style.bold, italics: style.italics, font: style.code ? 'Courier New' : undefined }));
      }
    }
  }
  return out;
}

function listParagraphs(list: Tokens.List): Paragraph[] {
  const out: Paragraph[] = [];
  list.items.forEach((item, i) => {
    const runs = runsFromInline(item.tokens?.flatMap((t) => ('tokens' in t ? (t as { tokens: Token[] }).tokens : [])) ?? []);
    const children = runs.length ? runs : [new TextRun(item.text)];
    out.push(
      list.ordered
        ? new Paragraph({ children: [new TextRun(`${(list.start || 1) + i}. `), ...children] })
        : new Paragraph({ children, bullet: { level: 0 } }),
    );
  });
  return out;
}

function tableFromToken(tok: Tokens.Table): Table {
  const headerCells = tok.header.map(
    (c) => new TableCell({ children: [new Paragraph({ children: runsFromInline(c.tokens) })] }),
  );
  const rows = [new TableRow({ children: headerCells, tableHeader: true })];
  for (const row of tok.rows) {
    rows.push(
      new TableRow({
        children: row.map((c) => new TableCell({ children: [new Paragraph({ children: runsFromInline(c.tokens) })] })),
      }),
    );
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/** Convert a single block token into one or more docx block elements. */
function blockFromToken(tok: Token): Array<Paragraph | Table> {
  switch (tok.type) {
    case 'heading': {
      const h = tok as Tokens.Heading;
      return [new Paragraph({ heading: HEADINGS[h.depth - 1] ?? HeadingLevel.HEADING_6, children: runsFromInline(h.tokens) })];
    }
    case 'paragraph':
      return [new Paragraph({ children: runsFromInline((tok as Tokens.Paragraph).tokens) })];
    case 'list':
      return listParagraphs(tok as Tokens.List);
    case 'table':
      return [tableFromToken(tok as Tokens.Table)];
    case 'code':
      return (tok as Tokens.Code).text
        .split('\n')
        .map((line) => new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New' })] }));
    case 'blockquote':
      return [new Paragraph({ children: runsFromInline((tok as Tokens.Blockquote).tokens), indent: { left: 480 }, style: 'IntenseQuote' })];
    case 'space':
      return [];
    default:
      return 'text' in tok && (tok as { text: string }).text
        ? [new Paragraph((tok as { text: string }).text)]
        : [];
  }
}

/** Generate a .docx from a title + markdown, returned base64-encoded. */
export async function markdownToDocxBase64(title: string, markdown: string): Promise<string> {
  const tokens = marked.lexer(markdown ?? '');
  const body: Array<Paragraph | Table> = [];
  if (title.trim()) body.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title.trim())] }));
  for (const tok of tokens) body.push(...blockFromToken(tok));
  if (body.length === 0) body.push(new Paragraph(''));
  const doc = new Document({ sections: [{ children: body }] });
  return Packer.toBase64String(doc);
}
