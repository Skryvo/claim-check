const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  shy: "",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const TAG = String.raw`<\/?[a-zA-Z][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>`;
const DROPPED_ELEMENTS = /<(script|style|noscript|svg|template|iframe|object|canvas|head|nav|footer|aside|form|button|select)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(p|div|section|article|main|header|blockquote|pre|table|thead|tbody|tfoot|tr|ul|ol|dl|dt|dd|figure|figcaption|h[1-6]|hr|address|details|summary)\b[^>]*>/gi;

export interface PageText {
  title: string;
  text: string;
}

/** Readable text of a page; with `keepLinks` its anchors stay as Markdown links so the page's own citations are kept. */
export function htmlToText(html: string, base: string, keepLinks: boolean): PageText {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let body = html
    .replace(/<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>/g, " ")
    .replace(DROPPED_ELEMENTS, " ")
    .replace(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
      const shown = inner.replace(new RegExp(TAG, "g"), "").replace(/\s+/g, " ").trim();
      if (!keepLinks || !shown) return ` ${shown} `;
      try {
        const url = new URL(decodeEntities(href), base);
        if (url.protocol !== "http:" && url.protocol !== "https:") return ` ${shown} `;
        return ` [${shown.replace(/[[\]]/g, "")}](${url.href.replace(/\)/g, "%29")}) `;
      } catch {
        return ` ${shown} `;
      }
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<t[dh]\b[^>]*>/gi, " ")
    .replace(BLOCK, "\n\n")
    .replace(new RegExp(TAG, "g"), "");
  body = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

export function isHtml(contentType: string, body: string): boolean {
  return /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
}
