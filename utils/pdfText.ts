import { PDFFont } from 'pdf-lib';

// pdf-lib has no built-in text wrapping — drawText() draws exactly what you
// give it on one line, however wide. Both PDF generators need to fit
// paragraphs into a fixed column width, so this is shared rather than
// duplicated between them.
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
