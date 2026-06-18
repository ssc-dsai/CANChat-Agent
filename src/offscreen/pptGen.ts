// PowerPoint generation — runs in the offscreen document (pptxgenjs needs a DOM,
// which the service worker lacks). Lazy-imported by offscreen.ts for the
// `generate_presentation` op behind the agent's create_powerpoint tool. Mirrors
// docGen.ts (the .docx path).

import PptxGenJS from 'pptxgenjs';
import type { SlideSpec } from '../shared/messages';

/** Build a .pptx from a title + structured slides; return the bytes as base64. */
export async function slidesToPptxBase64(title: string, slides: SlideSpec[]): Promise<string> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  let count = 0;

  const clean = title.trim();
  if (clean) {
    pptx
      .addSlide()
      .addText(clean, { x: 0.5, y: 2.4, w: '90%', h: 1.5, fontSize: 36, bold: true, align: 'center' });
    count++;
  }

  for (const slide of slides) {
    const s = pptx.addSlide();
    count++;
    if (slide.title) {
      s.addText(slide.title, { x: 0.5, y: 0.3, w: '90%', h: 0.9, fontSize: 28, bold: true });
    }
    const bullets = slide.bullets ?? [];
    if (bullets.length) {
      s.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 18, breakLine: true } })),
        { x: 0.7, y: 1.4, w: '85%', h: 5, valign: 'top', color: '363636' },
      );
    }
    if (slide.notes) s.addNotes(slide.notes);
  }

  // Never produce an empty deck.
  if (count === 0) {
    pptx.addSlide().addText(clean || 'Untitled', { x: 1, y: 1, fontSize: 28, bold: true });
  }

  return (await pptx.write({ outputType: 'base64' })) as string;
}
