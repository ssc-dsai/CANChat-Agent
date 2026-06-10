import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'preact/hooks';

// Links in the side panel must open in a real tab, not navigate the panel.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false })),
    [text],
  );
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
