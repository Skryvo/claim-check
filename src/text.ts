import { fold, overlap, tokens } from "./normalize.js";

export interface Link {
  url: string;
  start: number;
  end: number;
}

/** A document as prose a model can quote, with the same line count as the source and every address it cites. */
export interface Doc {
  prose: string;
  links: Link[];
  lineStarts: number[];
  breaks: number[];
}

export interface Span {
  start: number;
  end: number;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const REFERENCE = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/;
const FOOTNOTE = /^\s{0,3}\[\^([^\]]+)\]:\s*(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/;
const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?]/g;

const INLINE = new RegExp(
  [
    String.raw`(?<image>!\[[^\]]*\]\([^)]*\))`,
    String.raw`\[(?<ltext>[^\]]*)\]\((?<lurl>[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)`,
    String.raw`\[\^(?<fn>[^\]]+)\]`,
    String.raw`\[(?<rtext>[^\]]+)\]\[(?<rlabel>[^\]]*)\]`,
    String.raw`<a\s[^>]*?href\s*=\s*["'](?<aurl>[^"']+)["'][^>]*>(?<atext>.*?)<\/a\s*>`,
    String.raw`<(?<auto>https?:\/\/[^>\s]+)>`,
    String.raw`(?<bare>https?:\/\/[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?])`,
    String.raw`(?<tag><\/?[a-zA-Z][^>]*>)`,
    String.raw`(?<mark>\*\*|__|\x60)`,
  ].join("|"),
  "gi",
);

function absolute(url: string, base: string | undefined): string | null {
  try {
    const resolved = new URL(url.trim(), base);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
}

function blankLines(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

export function parseDocument(raw: string, base?: string): Doc {
  const text = raw.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, blankLines);
  const lines = text.split("\n");

  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (close > 0) for (let i = 0; i <= close; i++) lines[i] = "";
  }

  const references = new Map<string, string>();
  const footnotes = new Map<string, string[]>();
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      fenced = !fenced;
      lines[i] = "";
      continue;
    }
    if (fenced) {
      lines[i] = "";
      continue;
    }
    const reference = REFERENCE.exec(line);
    if (reference) {
      const url = absolute(reference[2]!, base);
      if (url) references.set(reference[1]!.toLowerCase(), url);
      lines[i] = "";
      continue;
    }
    const footnote = FOOTNOTE.exec(line);
    if (footnote) {
      const urls = [...footnote[2]!.matchAll(URL_IN_TEXT)].map((m) => m[0]);
      footnotes.set(footnote[1]!.toLowerCase(), urls);
      lines[i] = "";
    }
  }

  const links: Link[] = [];
  const breaks: number[] = [];
  const lineStarts: number[] = [];
  let prose = "";

  lines.forEach((line, index) => {
    if (index > 0) {
      const previousHeading = HEADING.test(lines[index - 1]!);
      if (previousHeading || BLOCK_START.test(line) || line.trim() === "") breaks.push(prose.length);
      prose += "\n";
    }
    lineStarts.push(prose.length);
    const heading = HEADING.exec(line);
    const rest = heading ? line.slice(heading[0].length) : line;
    if (heading) breaks.push(prose.length);

    let out = "";
    let last = 0;
    const add = (url: string | null, start: number, end: number) => {
      if (url) links.push({ url, start: prose.length + start, end: prose.length + end });
    };
    for (const match of rest.matchAll(INLINE)) {
      out += rest.slice(last, match.index);
      last = match.index + match[0].length;
      const g = match.groups!;
      if (g.ltext !== undefined) {
        const shown = g.ltext.replace(/\*\*|__|`/g, "");
        add(absolute(g.lurl!, base), out.length, out.length + shown.length);
        out += shown;
      } else if (g.fn !== undefined) {
        for (const url of footnotes.get(g.fn.toLowerCase()) ?? []) add(url, out.length, out.length);
      } else if (g.rtext !== undefined) {
        const label = (g.rlabel || g.rtext).toLowerCase();
        add(references.get(label) ?? null, out.length, out.length + g.rtext.length);
        out += g.rtext;
      } else if (g.atext !== undefined) {
        const shown = g.atext.replace(/<[^>]+>/g, "");
        add(absolute(g.aurl!, base), out.length, out.length + shown.length);
        out += shown;
      } else if (g.auto !== undefined || g.bare !== undefined) {
        add(absolute((g.auto ?? g.bare)!, base), out.length, out.length);
      }
    }
    out += rest.slice(last);
    prose += out;
  });

  return { prose, links, lineStarts, breaks };
}

export function lineOf(doc: Doc, offset: number): number {
  let low = 0;
  let high = doc.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (doc.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function boundaries(doc: Doc, sentences: boolean): number[] {
  const cuts = new Set<number>([0, doc.prose.length, ...doc.breaks]);
  if (sentences) {
    for (const match of doc.prose.matchAll(/[.!?]["')\]”’]*\s+(?=["'(\[“‘]?[\p{Lu}\p{N}])/gu)) {
      cuts.add(match.index + match[0].length);
    }
  } else {
    for (const match of doc.prose.matchAll(/\n[ \t]*\n/g)) cuts.add(match.index + 1);
  }
  return [...cuts].sort((a, b) => a - b);
}

function enclosing(cuts: number[], span: Span): Span {
  let start = 0;
  let end = cuts[cuts.length - 1]!;
  for (const cut of cuts) {
    if (cut <= span.start) start = cut;
    if (cut >= span.end) {
      end = cut;
      break;
    }
  }
  return { start, end };
}

export function sentenceAt(doc: Doc, span: Span): Span {
  return enclosing(boundaries(doc, true), span);
}

export function paragraphAt(doc: Doc, span: Span): Span {
  return enclosing(boundaries(doc, false), span);
}

/** The addresses cited in the claim's sentence first, then the rest of its paragraph. */
export function citedFor(doc: Doc, span: Span): string[] {
  const inside = (outer: Span) =>
    doc.links.filter((link) => link.start >= outer.start && link.end <= outer.end).map((link) => link.url);
  return [...new Set([...inside(sentenceAt(doc, span)), ...inside(paragraphAt(doc, span))])];
}

/** Where the model's quote sits in the prose: exactly (folded), else the one sentence that shares most of its words. */
export function locate(doc: Doc, quote: string): Span | null {
  const needle = fold(quote).text.replace(/[.\s]+$/, "");
  if (needle.length < 4) return null;
  const hay = fold(doc.prose);
  const at = hay.text.indexOf(needle);
  if (at >= 0) {
    return { start: hay.map[at]!, end: hay.map[at + needle.length - 1]! + 1 };
  }
  const wanted = tokens(quote);
  let best: Span | null = null;
  let bestScore = 0.6;
  const cuts = boundaries(doc, true);
  for (let i = 0; i < cuts.length - 1; i++) {
    const span = { start: cuts[i]!, end: cuts[i + 1]! };
    const score = overlap(wanted, tokens(doc.prose.slice(span.start, span.end)));
    if (score > bestScore) {
      best = span;
      bestScore = score;
    }
  }
  return best;
}

export function linesOf(doc: Doc, span: Span): number[] {
  const first = lineOf(doc, span.start);
  const last = lineOf(doc, Math.max(span.start, span.end - 1));
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
