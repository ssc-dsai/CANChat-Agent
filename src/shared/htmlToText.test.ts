import { describe, expect, it } from 'vitest';
import { EMAIL_DROP_HTML, GRAPH_HTML, htmlToText, MAX_HTML_TO_TEXT_INPUT } from './htmlToText';
import { stripHtml } from './emailDrop';
import { htmlToText as mailHtmlToText } from './graphMail';
import { htmlToText as calendarHtmlToText } from './graphCalendar';

// The pre-fix regex implementations, kept here only as a reference oracle for
// well-formed input (they are O(n²) on hostile input — never call them on it).
function legacyEmailDrop(html: string): string {
  const NAMED: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  };
  let s = html;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => NAMED[m.toLowerCase()] ?? ' ');
  s = s.replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
function legacyGraph(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CORPUS = [
  '<p>Hello</p><p>World</p>',
  'a<br>b<BR/>c<br />d<br\t/>e',
  '<style>.x{color:red}</style>Body<script>evil()</script>',
  '<SCRIPT type="text/javascript">if (a < b && c > d) {}</SCRIPT>after',
  'Tom&nbsp;&amp;&nbsp;Jerry &lt;3 &quot;q&quot; &#39;s&apos;',
  '<div>a</div><div></div><div></div><div>b</div>',
  '<html><head><title>T</title></head><body><table><tr><td>x</td><td>y</td></tr></table></body></html>',
  '<h1>Title</h1>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>\n<blockquote>quoted</blockquote>',
  '<p class="MsoNormal"><span style="font-family:Calibri">Hi <b>Bob</b>,</span></p><p>See   you\tthere.</p>',
  'Caf&#233; &copy; 2026',
  'plain text with no markup at all',
  'a < b and c > d',
  'x <> y',
  '<<b>bold</b>',
  'trailing open <',
  '',
];

describe('htmlToText — matches the previous regex output on well-formed input', () => {
  it.each(CORPUS)('emailDrop flavour: %j', (html) => {
    expect(htmlToText(html, EMAIL_DROP_HTML)).toBe(legacyEmailDrop(html));
    expect(stripHtml(html)).toBe(legacyEmailDrop(html));
  });

  it.each(CORPUS)('Graph flavour: %j', (html) => {
    expect(htmlToText(html, GRAPH_HTML)).toBe(legacyGraph(html));
    expect(mailHtmlToText(html)).toBe(legacyGraph(html));
    expect(calendarHtmlToText(html)).toBe(legacyGraph(html));
  });
});

describe('htmlToText — behaviour', () => {
  it('turns closing block tags and <br> into line breaks, collapsing blank runs', () => {
    expect(htmlToText('<p>a\u00a0\u00a0b</p>\r\n<p>c</p>', GRAPH_HTML)).toBe('a b\n\nc');
    expect(htmlToText('a\r\nb', GRAPH_HTML)).toBe('a\nb');
    expect(htmlToText('a<br><br><br><br>b', EMAIL_DROP_HTML)).toBe('a\n\nb');
  });

  it('drops scripts and styles including their content', () => {
    expect(htmlToText('a<script>x()</script>b<style>p{}</style>c', GRAPH_HTML)).toBe('a b c');
  });

  it('removes comments, even ones containing ">"', () => {
    expect(htmlToText('a<!-- if (x > 1) -->b', EMAIL_DROP_HTML)).toBe('ab');
    expect(htmlToText('<!--[if mso]><style>p{}</style><![endif]-->Hi', GRAPH_HTML)).toBe('Hi');
  });

  it('decodes entities in one pass (no double-decoding)', () => {
    expect(htmlToText('&amp;lt;b&amp;gt;', EMAIL_DROP_HTML)).toBe('&lt;b&gt;');
    expect(htmlToText('&amp;lt;b&amp;gt;', GRAPH_HTML)).toBe('&lt;b&gt;');
  });

  it('decodes numeric refs in the email-drop flavour only', () => {
    expect(htmlToText('&#233;&#xE9;&#X1F600;', EMAIL_DROP_HTML)).toBe('éé😀');
    expect(htmlToText('&#233; &eacute;', GRAPH_HTML)).toBe('&#233; &eacute;');
    expect(htmlToText('a&#0;b&#99999999;c', EMAIL_DROP_HTML)).toBe('a b c');
  });

  it('normalises CRLF and non-breaking spaces', () => {
    expect(htmlToText('<p>a\u00a0\u00a0b</p>\r\n<p>c</p>', GRAPH_HTML)).toBe('a b\n\nc');
    expect(htmlToText('a\r\nb', GRAPH_HTML)).toBe('a\nb');
  });

  it('caps the processed input length', () => {
    const big = 'x'.repeat(MAX_HTML_TO_TEXT_INPUT) + 'TAIL';
    const out = htmlToText(big, GRAPH_HTML);
    expect(out.length).toBe(MAX_HTML_TO_TEXT_INPUT);
    expect(out.endsWith('TAIL')).toBe(false);
  });
});

describe('htmlToText — linear time on hostile input', () => {
  const N = 200_000;
  const PATHOLOGICAL: Array<[string, string]> = [
    ["200 KB of '<'", '<'.repeat(N)],
    ["'<a' repeated", '<a'.repeat(N / 2)],
    ["'<a ' repeated then one '>'", `${'<a '.repeat(N / 3)}>`],
    ["unclosed '<!--' repeated", '<!--'.repeat(N / 4)],
    ["one unclosed '<!--' then text", `<!--${'x'.repeat(N)}`],
    ["'<script' repeated without close", '<script'.repeat(N / 7)],
    ["'<script>' repeated without close", '<script>'.repeat(N / 8)],
    ["'<style' and '<script' interleaved", '<style<script'.repeat(N / 13)],
    ["many '&'", '&'.repeat(N)],
    ["'&#' + digits repeated", '&#1111111'.repeat(N / 9)],
    ["'&a' repeated", '&a'.repeat(N / 2)],
    ['spaces and newlines', ' \n \t\n'.repeat(N / 5)],
    ['long run of spaces', ' '.repeat(N)],
    ["'<br' + spaces repeated", `<br${' '.repeat(100)}`.repeat(N / 103)],
  ];

  it.each(PATHOLOGICAL)('%s finishes well under 200 ms (both flavours)', (_label, input) => {
    for (const opts of [EMAIL_DROP_HTML, GRAPH_HTML]) {
      htmlToText(input.slice(0, 1000), opts); // warm up
      const t0 = performance.now();
      htmlToText(input, opts);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });

  it('a 2 MB hostile body (the cap) still finishes quickly', () => {
    const t0 = performance.now();
    htmlToText('<a'.repeat(MAX_HTML_TO_TEXT_INPUT), EMAIL_DROP_HTML);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
