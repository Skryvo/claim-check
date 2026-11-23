const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "″": '"',
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "−": "-",
  " ": " ",
  " ": " ",
  " ": " ",
};
const DROPPED = new Set(["*", "_", "`", "­", "​"]);

export interface Folded {
  text: string;
  /** For each character of `text`, the offset in the original string it came from. */
  map: number[];
}

/** Lower case, one kind of quote and dash, no emphasis marks, single spaces: what two copies of a sentence share. */
export function fold(input: string): Folded {
  let text = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]!;
    if (DROPPED.has(raw)) continue;
    const ch = (FOLD[raw] ?? raw).toLowerCase();
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      text += " ";
      map.push(i);
      lastSpace = true;
      continue;
    }
    text += ch;
    map.push(i);
    lastSpace = false;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export function folded(input: string): string {
  return fold(input).text;
}

const STOPWORDS = new Set(
  `the and for are was were that this with from have has had its it's not but than then they their them
  there which what when where who whom whose will would can could should about into over under more most
  also been being per our your his her she him you all any each other such only some very just`.split(/\s+/),
);

function stem(word: string): string {
  if (word.length <= 4 || /\d/.test(word)) return word;
  return word.replace(/(?:ing|ed|es|s)$/, "");
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of folded(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length > 2 && !STOPWORDS.has(word)) out.add(stem(word));
  }
  return out;
}

export function numbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    out.add(match.replace(/,/g, "").replace(/\.0+$/, ""));
  }
  return out;
}

export function overlap(needles: Set<string>, haystack: Set<string>): number {
  if (needles.size === 0) return 0;
  let shared = 0;
  for (const word of needles) if (haystack.has(word)) shared++;
  return shared / needles.size;
}
