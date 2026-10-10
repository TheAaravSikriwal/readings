// Headings and subheadings, found in a reading, so you can move around it and
// so its notes sort into its sections. A PDF's own bookmarks win; otherwise
// they're read off the text. A saved web page has real heading tags.
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Section } from '../types';

/** Bumped when the way headings are found changes, so readings get looked at again. */
export const OUTLINE_V = 1;

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const MAX_PAGES = 300;
const MAX_SECTIONS = 250;

export async function pdfOutline(doc: PDFDocumentProxy): Promise<Section[]> {
  const marked = await fromBookmarks(doc).catch(() => [] as Section[]);
  const found = marked.length >= 2 ? marked : await fromText(doc).catch(() => [] as Section[]);
  return found.sort((a, b) => (a.p ?? 0) - (b.p ?? 0) || (a.y ?? 0) - (b.y ?? 0)).slice(0, MAX_SECTIONS);
}

// ---------------------------------------------------------------- the PDF's own bookmarks

async function fromBookmarks(doc: PDFDocumentProxy): Promise<Section[]> {
  const outline = await doc.getOutline();
  if (!outline?.length) return [];
  const out: Section[] = [];
  const viewports = new Map<number, Awaited<ReturnType<typeof viewportOf>>>();
  const viewportOf = async (p: number) => (await doc.getPage(p + 1)).getViewport({ scale: 1 });

  const walk = async (items: typeof outline, level: number) => {
    for (const it of items) {
      if (out.length >= MAX_SECTIONS) return;
      const title = squash(it.title);
      try {
        const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
        if (title && Array.isArray(dest) && dest[0] != null) {
          const p = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
          if (!viewports.has(p)) viewports.set(p, await viewportOf(p));
          const vp = viewports.get(p)!;
          const kind = (dest[1] as { name?: string } | undefined)?.name;
          const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
          const y = typeof top === 'number' ? vp.convertToViewportPoint(0, top)[1] / vp.height : 0;
          out.push({ title, level: Math.min(3, level), p, y: Math.max(0, Math.min(1, y)) });
        }
      } catch {
        // a broken link in the outline: leave that one out
      }
      if (it.items?.length && level < 3) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

// ---------------------------------------------------------------- read off the text

interface Line {
  p: number;
  text: string;
  size: number;
  x0: number;
  x1: number;
  /** baseline, in points from the top of the page */
  base: number;
  ph: number;
  gapAbove: number;
}

/** "1", "2.3", "IV.", "(1)", "(a)", "A." before a heading. */
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVXLC]{1,6}\.|\(\d{1,2}\)|\([a-z]\)|[A-H]\.)\s+(?=\S)/;
const KNOWN =
  /^(abstract|introduction|background|related work|preliminaries|methods?|methodology|materials and methods|experiments?|results|evaluation|discussion|conclusions?|summary|limitations|future work|references|bibliography|acknowledg(e)?ments?|appendix|appendices)\b/i;

async function linesOf(doc: PDFDocumentProxy): Promise<Line[]> {
  const lines: Line[] = [];
  for (let i = 0; i < Math.min(doc.numPages, MAX_PAGES); i++) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const rows: { base: number; size: number; parts: { x: number; w: number; s: string; size: number }[] }[] = [];
    for (const it of tc.items) {
      if (!('str' in it) || !it.str) continue;
      const [a, b, c, d, e, f] = it.transform as number[];
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue; // turned text: a side note or a figure
      const size = Math.hypot(c, d) || it.height || 10;
      const [x, base] = vp.convertToViewportPoint(e, f);
      let row = rows.find((r) => Math.abs(r.base - base) < Math.max(size, r.size) * 0.45);
      if (!row) rows.push((row = { base, size, parts: [] }));
      row.parts.push({ x, w: it.width, s: it.str, size });
      if (it.str.trim().length > 2) row.size = Math.max(row.size, size);
    }
    rows.sort((r1, r2) => r1.base - r2.base);
    let prev: number | null = null;
    for (const r of rows) {
      r.parts.sort((p1, p2) => p1.x - p2.x);
      let text = '';
      let end = -Infinity;
      for (const part of r.parts) {
        if (text && part.x - end > part.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(part.s)) text += ' ';
        text += part.s;
        end = Math.max(end, part.x + part.w);
      }
      text = squash(text);
      if (!text) continue;
      lines.push({
        p: i,
        text,
        size: r.size,
        x0: r.parts[0].x,
        x1: end,
        base: r.base,
        ph: vp.height,
        gapAbove: prev === null ? Infinity : r.base - prev,
      });
      prev = r.base;
    }
  }
  return lines;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

async function fromText(doc: PDFDocumentProxy): Promise<Section[]> {
  const lines = await linesOf(doc);
  if (!lines.length) return [];

  // The body text: the size most of the characters are set in.
  const chars = new Map<number, number>();
  for (const l of lines) chars.set(Math.round(l.size * 2) / 2, (chars.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  const body = [...chars].sort((a, b) => b[1] - a[1])[0][0];
  const isBody = (l: Line) => Math.abs(l.size - body) <= body * 0.08;
  const lineGap = median(lines.filter((l) => isBody(l) && l.gapAbove > 0 && l.gapAbove < body * 3).map((l) => l.gapAbove)) || body * 1.25;
  const lineWidth = quantile(lines.filter(isBody).map((l) => l.x1 - l.x0), 0.9) || 400;

  // Running heads and page numbers come back on every page.
  const norm = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const pagesWith = new Map<string, Set<number>>();
  for (const l of lines) {
    const k = norm(l.text);
    if (!pagesWith.has(k)) pagesWith.set(k, new Set());
    pagesWith.get(k)!.add(l.p);
  }

  // The title on the first page isn't a heading.
  const firstPage = lines.filter((l) => l.p === 0);
  const titleSize = Math.max(...firstPage.map((l) => l.size), 0);

  type Found = Line & { kind: 'numbered' | 'known' | 'big'; label?: string };
  const found: Found[] = [];
  for (const l of lines) {
    const t = l.text;
    const words = t.split(' ').length;
    if (t.length < 2 || t.length > 110 || words > 14) continue;
    if (!/[A-Za-z]{2}/.test(t) || /^(fig(ure)?|table|eq(uation)?|algorithm|listing)\b/i.test(t)) continue;
    if ((pagesWith.get(norm(t))?.size ?? 0) >= 3) continue;
    // A sentence's last line, not a heading (a short numbered title may still end in a full stop).
    if (/[,;:]$/.test(t) || (/\.$/.test(t) && !(NUMBERED.test(t) && words <= 8))) continue;
    const short = l.x1 - l.x0 <= lineWidth * 0.82;
    const alone = l.gapAbove >= lineGap * 1.35;
    const big = l.size >= body * 1.15;
    const num = t.match(NUMBERED);
    const rest = num ? t.slice(num[0].length) : t;
    if (!/^[A-Z“"']/.test(rest)) continue;
    if (l.p === 0 && l.size >= titleSize && l.size >= body * 1.3) continue;
    if (num && alone && short && words <= 12) found.push({ ...l, kind: 'numbered', label: num[1] });
    else if (KNOWN.test(rest) && words <= 5 && (alone || big)) found.push({ ...l, kind: 'known' });
    else if (big && short && (alone || l.gapAbove === Infinity)) found.push({ ...l, kind: 'big' });
  }

  // Above the first real heading on page one is the paper's front matter: authors, affiliations.
  const firstReal = found.find((f) => f.p === 0 && f.kind !== 'big');
  const kept = found.filter(
    (f) => !(f.p === 0 && f.kind === 'big' && (firstReal ? f.base < firstReal.base : f.base < f.ph * 0.35)),
  );

  // A big heading that runs onto a second line is one heading.
  const merged: Found[] = [];
  for (const f of kept) {
    const last = merged.at(-1);
    if (
      last &&
      f.kind === 'big' &&
      last.kind !== 'known' &&
      last.p === f.p &&
      Math.abs(last.size - f.size) < 0.5 &&
      f.base - last.base <= f.size * 1.6
    ) {
      last.text = `${last.text} ${f.text}`;
      continue;
    }
    merged.push({ ...f });
  }

  // Levels: numbering says it outright; otherwise bigger type is a higher level.
  const bigSizes = [...new Set(merged.filter((f) => f.kind === 'big').map((f) => Math.round(f.size)))].sort((a, b) => b - a);
  const hasTop = merged.some((f) => f.kind !== 'numbered' || /^\d+\.?$|^[IVXLC]+\.$/.test(f.label ?? ''));
  const levelOf = (f: Found) => {
    if (f.kind === 'numbered') {
      const lab = f.label!;
      if (/^\d/.test(lab)) return lab.replace(/\.$/, '').split('.').length;
      if (/^[IVXLC]+\.$/.test(lab)) return 1;
      return hasTop ? 2 : 1; // (1), (a), A.
    }
    if (f.kind === 'known') return 1;
    return Math.min(3, bigSizes.indexOf(Math.round(f.size)) + 1);
  };
  const out = merged.map((f) => ({
    title: f.text.slice(0, 140),
    level: levelOf(f),
    p: f.p,
    y: Math.max(0, Math.min(1, (f.base - f.size) / f.ph)),
  }));
  const top = Math.min(...out.map((s) => s.level), 1);
  return out.map((s) => ({ ...s, level: Math.max(1, Math.min(3, s.level - top + 1)) }));
}

// ---------------------------------------------------------------- web pages

export function htmlOutline(root: HTMLElement): Section[] {
  const heads = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4')];
  const tags = [...new Set(heads.map((h) => h.tagName))].sort();
  const range = document.createRange();
  return heads
    .map((h, i) => {
      range.setStart(root, 0);
      range.setEndBefore(h);
      return { title: squash(h.textContent).slice(0, 140), level: Math.min(3, tags.indexOf(h.tagName) + 1), i, at: range.toString().length };
    })
    .filter((s) => s.title)
    .slice(0, MAX_SECTIONS);
}
