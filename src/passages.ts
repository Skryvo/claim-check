import { numbers, overlap, tokens } from "./normalize.js";

const TARGET = 600;
const PARAGRAPH = 200;

/** Paragraph-sized pieces of a page: a real paragraph alone (cut at sentence ends when long), short lines joined. */
export function split(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n\s*\n|\n(?=- )/)) {
    const clean = paragraph.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    if (clean.length >= PARAGRAPH) {
      push();
      let piece = "";
      for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
        if (piece && piece.length + sentence.length > TARGET) {
          pieces.push(piece.trim());
          piece = "";
        }
        piece += `${sentence} `;
      }
      if (piece.trim()) pieces.push(piece.trim());
      continue;
    }
    if (current && current.length + clean.length > TARGET) push();
    current += `${clean}\n`;
  }
  push();
  return pieces;
}

/** Words and figures the passage shares with the claim, discounted when the passage is mostly short lines (menus, tables). */
export function score(claim: string, passage: string): number {
  const figures = numbers(claim);
  const shared = overlap(tokens(claim), tokens(passage)) + (figures.size ? 0.3 * overlap(figures, numbers(passage)) : 0);
  const prose = passage.split("\n").filter((line) => line.length >= 80).reduce((n, line) => n + line.length, 0);
  return shared * (0.6 + (0.4 * prose) / passage.length);
}

function isProse(passage: string): boolean {
  return passage.length >= PARAGRAPH && !passage.includes("\n");
}

/** The pieces of a page most likely to settle the claim, best first, always with the page's first paragraph, where pages state their main facts. */
export function bestPassages(claim: string, text: string, limit: number): string[] {
  const pieces = split(text);
  const ranked = pieces
    .map((passage, index) => ({ passage, index, score: score(claim, passage) }))
    .filter((p) => p.score > 0.25)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);
  const opening = pieces.findIndex(isProse);
  if (opening >= 0 && !ranked.some((p) => p.index === opening) && score(claim, pieces[opening]!) > 0) {
    ranked.splice(Math.max(0, limit - 1), 1, { passage: pieces[opening]!, index: opening, score: 0 });
  }
  return ranked.map((p) => p.passage);
}
