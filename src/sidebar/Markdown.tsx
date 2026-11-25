import { useMemo } from 'preact/hooks';
import { injectCitationChips } from '../shared/citations';
import type { Citation } from '../shared/types';
import { renderSafeMarkdown } from './safeHtml';

export function Markdown({
  text,
  citations,
  onCiteClick,
}: {
  text: string;
  /** Sentence-level citations; when present, `[[id]]` tokens become numbered chips. */
  citations?: Citation[];
  onCiteClick?: (citation: Citation) => void;
}) {
  const html = useMemo(() => {
    // Sanitize first, then swap the (literal, sanitization-surviving) [[id]] tokens
    // for chip markup built from validated ids — so chips aren't user-injectable HTML.
    let out = renderSafeMarkdown(text);
    if (citations && citations.length > 0) {
      const numberById = new Map(citations.map((c, i) => [c.sentenceId, i + 1] as const));
      out = injectCitationChips(out, numberById);
    }
    return out;
  }, [text, citations]);

  const handleClick = (e: MouseEvent) => {
    if (!citations || !onCiteClick) return;
    const chip = (e.target as HTMLElement | null)?.closest?.('.citation-chip') as HTMLElement | null;
    if (!chip) return;
    const id = chip.getAttribute('data-cite-id');
    const citation = citations.find((c) => c.sentenceId === id);
    if (citation) {
      e.preventDefault();
      onCiteClick(citation);
    }
  };

  return <div class="md" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
