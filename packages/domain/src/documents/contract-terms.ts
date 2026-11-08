/**
 * PRD go-live §7.1 — the contract T&C is stored per organization as bilingual
 * markdown (ContractTerms.body) and printed verbatim, Indonesian left and
 * English right. This turns that markdown into aligned article/point pairs
 * the PDF renderer can lay out row by row, so point II.8 in Indonesian always
 * sits beside II.8 in English, however long either one runs.
 *
 * Expected shape (the data pack's contract-terms-id-en.md):
 *
 *   ## Bahasa Indonesia
 *   <title lines>
 *   **I. DEFINISI.**
 *   1. ...
 *   ## English
 *   <title lines>
 *   **DEFINITIONS.**
 *   1. ...
 *   ## Pernyataan penandatangan / Signatory declaration
 *   <ID paragraph>
 *   <EN paragraph>
 *   ...
 *
 * Text is not rewritten — only line wrapping is undone.
 */

export interface TermsArticle {
  heading: string;
  /** Unnumbered text between the heading and point 1 (e.g. Article III's lead-in). */
  intro: string | null;
  points: string[];
}

export interface TermsLanguage {
  title: string[];
  articles: TermsArticle[];
}

export interface ParsedContractTerms {
  id: TermsLanguage;
  en: TermsLanguage;
  /** Indonesian/English paragraph pairs of the signatory declaration. */
  declaration: Array<{ id: string; en: string }>;
}

export interface AlignedArticle {
  id: TermsArticle | null;
  en: TermsArticle | null;
  /** max(id.points, en.points) — rows to lay out. */
  rows: Array<{ id: string | null; en: string | null }>;
}

function sections(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "";
  for (const raw of markdown.replace(/\f/g, "\n").split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(raw);
    if (h) {
      current = h[1]!.trim().toLowerCase();
      out.set(current, []);
      continue;
    }
    if (current) out.get(current)!.push(raw);
  }
  return out;
}

function findSection(all: Map<string, string[]>, prefix: string): string[] {
  for (const [k, v] of all) if (k.startsWith(prefix)) return v;
  return [];
}

function parseLanguage(lines: string[]): TermsLanguage {
  const title: string[] = [];
  const articles: TermsArticle[] = [];
  let article: TermsArticle | null = null;
  let point: string | null = null;

  const flushPoint = () => {
    if (article && point !== null) article.points.push(point.trim());
    point = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^\*\*(.+?)\*\*$/.exec(line);
    if (heading) {
      flushPoint();
      article = { heading: heading[1]!.trim(), intro: null, points: [] };
      articles.push(article);
      continue;
    }
    if (!article) {
      title.push(line);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      flushPoint();
      point = line;
      continue;
    }
    if (point !== null) point += ` ${line}`;
    else article.intro = article.intro ? `${article.intro} ${line}` : line;
  }
  flushPoint();
  return { title, articles };
}

function parseDeclaration(lines: string[]): Array<{ id: string; en: string }> {
  const paragraphs: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) paragraphs.push(buf.join(" ").replace(/\s+/g, " ").trim());
    buf = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    // The legacy form's signature-box labels, not declaration text.
    if (/^(sign|signature)$/i.test(line)) continue;
    buf.push(line);
  }
  flush();
  const pairs: Array<{ id: string; en: string }> = [];
  for (let i = 0; i < paragraphs.length; i += 2) pairs.push({ id: paragraphs[i]!, en: paragraphs[i + 1] ?? "" });
  return pairs;
}

export function parseContractTerms(markdown: string): ParsedContractTerms {
  const all = sections(markdown);
  return {
    id: parseLanguage(findSection(all, "bahasa indonesia")),
    en: parseLanguage(findSection(all, "english")),
    declaration: parseDeclaration(findSection(all, "pernyataan penandatangan")),
  };
}

/** Pair the two languages article by article and point by point. */
export function alignContractTerms(terms: ParsedContractTerms): AlignedArticle[] {
  const n = Math.max(terms.id.articles.length, terms.en.articles.length);
  const out: AlignedArticle[] = [];
  for (let i = 0; i < n; i++) {
    const id = terms.id.articles[i] ?? null;
    const en = terms.en.articles[i] ?? null;
    const rows: AlignedArticle["rows"] = [];
    const m = Math.max(id?.points.length ?? 0, en?.points.length ?? 0);
    for (let j = 0; j < m; j++) rows.push({ id: id?.points[j] ?? null, en: en?.points[j] ?? null });
    out.push({ id, en, rows });
  }
  return out;
}
