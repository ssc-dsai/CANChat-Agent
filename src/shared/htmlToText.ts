// Linear-time HTML → plain text, shared by the email-drop, Graph mail and Graph
// calendar ingest paths. No DOM, so it's pure and the markup is never parsed by
// a live document.
//
// Why not regexes: the previous `<[^>]+>` / `<(script|style)[\s\S]*?<\/\1>`
// replaces were O(n²) on hostile input — at every `<` the engine scans to the
// end of the string looking for a `>` (or `</script>`) that isn't there, then
// retries from the next `<`. 200 KB of `<` took ~30 s, so one crafted email
// could hang mailbox sync. This is a single left-to-right scanner: every search
// for a closing `>` / `-->` / `</script>` either consumes the text it scanned or
// is cached as "none further on", so total work is O(n). Input is also capped
// at MAX_HTML_TO_TEXT_INPUT as a belt-and-braces bound.

/** Characters of HTML processed; anything past this is dropped before parsing. */
export const MAX_HTML_TO_TEXT_INPUT = 2_000_000;

export interface HtmlToTextOptions {
  /** Replacement for an ordinary stripped tag or comment ('' joins, ' ' separates). */
  tagReplacement: '' | ' ';
  /** Lower-case names whose exact closing tag (`</p>`) becomes a newline. */
  blockTags: ReadonlySet<string>;
  /**
   * 'all': decode numeric refs (`&#233;`, `&#xE9;`) and the core named set;
   * any other named ref becomes a space. 'basic': decode only the core named
   * set (incl. `&#39;`) and leave everything else verbatim.
   */
  entities: 'all' | 'basic';
}

const CORE_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
};

/** Settings used for dragged / uploaded emails (emailDrop, emlParse, msgParse). */
export const EMAIL_DROP_HTML: HtmlToTextOptions = {
  tagReplacement: '',
  blockTags: new Set(['p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote']),
  entities: 'all',
};

/** Settings used for Microsoft Graph message / event bodies. */
export const GRAPH_HTML: HtmlToTextOptions = {
  tagReplacement: ' ',
  blockTags: new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
  entities: 'basic',
};

const RAW_TEXT_ELEMENTS = ['script', 'style'] as const;

/** ASCII case-insensitive `s.startsWith(word, at)` (word must be lower-case). */
function startsWithCI(s: string, at: number, word: string): boolean {
  if (at + word.length > s.length) return false;
  for (let k = 0; k < word.length; k++) {
    let c = s.charCodeAt(at + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== word.charCodeAt(k)) return false;
  }
  return true;
}

/** `<br>`, `<br/>`, `<br />` (whitespace allowed before the slash), any case. */
function isBr(inner: string): boolean {
  if (!startsWithCI(inner, 0, 'br')) return false;
  let rest = inner.slice(2);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  return rest.trim() === '';
}

/** Pass 1: strip tags, comments and script/style blocks in one linear scan. */
function stripTags(s: string, opts: HtmlToTextOptions): string {
  const out: string[] = [];
  const n = s.length;
  let textStart = 0;
  let i = 0;

  // Cached position of the next '>' at or after the scan point (-1 = none left).
  let gt = -2;
  const nextGt = (from: number): number => {
    if (gt === -1 || gt >= from) return gt;
    gt = s.indexOf('>', from);
    return gt;
  };
  // Same idea for each raw-text element's closing tag, so `<script` repeated
  // without a close costs one scan, not one per occurrence.
  const closeAt: Record<string, number> = { script: -2, style: -2 };
  const nextClose = (name: string, from: number): number => {
    const cached = closeAt[name];
    if (cached === -1 || cached >= from) return cached;
    const re = new RegExp(`</${name}>`, 'gi'); // literal pattern: no backtracking
    re.lastIndex = from;
    const m = re.exec(s);
    closeAt[name] = m ? m.index : -1;
    return closeAt[name];
  };
  const emit = (end: number, replacement: string, resume: number) => {
    if (end > textStart) out.push(s.slice(textStart, end));
    if (replacement) out.push(replacement);
    textStart = i = resume;
  };

  scan: while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;

    for (const name of RAW_TEXT_ELEMENTS) {
      if (startsWithCI(s, lt + 1, name)) {
        const close = nextClose(name, lt + 1 + name.length);
        if (close !== -1) {
          emit(lt, ' ', close + name.length + 3);
          continue scan;
        }
      }
    }

    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end !== -1) {
        emit(lt, opts.tagReplacement, end + 3);
        continue;
      }
      // Unclosed comment: fall through and treat it as an ordinary tag.
    }

    const close = nextGt(lt + 1);
    if (close === -1) break; // no '>' anywhere further on: the rest is text
    if (close === lt + 1) {
      i = lt + 1; // "<>" is literal text
      continue;
    }
    const inner = s.slice(lt + 1, close);
    let replacement: string = opts.tagReplacement;
    if (isBr(inner)) replacement = '\n';
    else if (inner.length <= 11 && inner[0] === '/' && opts.blockTags.has(inner.slice(1).toLowerCase())) {
      replacement = '\n';
    }
    emit(lt, replacement, close + 1);
  }

  if (textStart < n) out.push(s.slice(textStart));
  return out.join('');
}

function decodeNumeric(ref: string): string | undefined {
  const m = /^#(?:x([0-9a-f]{1,6})|([0-9]{1,7}))$/i.exec(ref);
  if (!m) return undefined;
  const code = m[1] !== undefined ? parseInt(m[1], 16) : Number(m[2]);
  if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
  return String.fromCodePoint(code);
}

/** Pass 2: single-pass entity decode (no double-decoding of `&amp;lt;`). */
function decodeEntities(s: string, mode: HtmlToTextOptions['entities']): string {
  // Each match is '&' + a run of [a-z0-9#] + ';'; runs can't contain '&', so
  // failed attempts scan disjoint stretches — linear.
  return s.replace(/&([a-z0-9#]+);/gi, (m, ref: string) => {
    const lower = ref.toLowerCase();
    const named = CORE_ENTITIES[lower];
    if (named !== undefined) return named;
    if (mode === 'basic') return m;
    return decodeNumeric(lower) ?? ' ';
  });
}

/** Pass 3: collapse horizontal whitespace, trim lines, cap blank-line runs. */
function normaliseWhitespace(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert an HTML fragment to readable plain text: scripts/styles and comments
 * dropped, closing block tags and `<br>` become newlines, entities decoded,
 * whitespace collapsed. Good enough for search/ingest and previews; not a full
 * renderer. Runs in linear time on any input.
 */
export function htmlToText(html: string, opts: HtmlToTextOptions = GRAPH_HTML): string {
  if (!html) return '';
  const capped = html.length > MAX_HTML_TO_TEXT_INPUT ? html.slice(0, MAX_HTML_TO_TEXT_INPUT) : html;
  return normaliseWhitespace(decodeEntities(stripTags(capped, opts), opts.entities));
}
