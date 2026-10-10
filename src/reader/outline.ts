// Headings and subheadings, found in a reading, so you can move around it and
// so its notes sort into its sections. A PDF's own bookmarks win; otherwise
// they're read off the text. A saved web page has real heading tags.
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Section } from '../types';

/** Bumped when the way headings are found changes, so readings get looked at again. */
export const OUTLINE_V = 2;

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const MAX_PAGES = 300;
const MAX_SECTIONS = 250;

export async function pdfOutline(doc: PDFDocumentProxy): Promise<Section[]> {
  const marked = await fromBookmarks(doc).catch(() => [] as Section[]);
  const found = marked.length >= 2 ? marked : await fromText(doc).catch(() => [] as Section[]);
  return found.sort((a, b) => (a.p ?? 0) - (b.p ?? 0) || (a.c ?? 0) - (b.c ?? 0) || (a.y ?? 0) - (b.y ?? 0)).slice(0, MAX_SECTIONS);
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
  pw: number;
  /** 0 left column (or the only one), 1 right column, -1 across both */
  col: number;
  gapAbove: number;
}

/** "1", "2.3", "IV.", "(1)", "(a)", "A." before a heading. */
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVXLC]{1,6}\.|\(\d{1,2}\)|\([a-z]\)|[A-H]\.)\s+(?=\S)/;
const KNOWN =
  /^(abstract|introduction|background|related work|preliminaries|methods?|methodology|materials and methods|experiments?|results|evaluation|discussion|conclusions?|concluding remarks|summary|executive summary|overview|limitations|future work|references|bibliography|works cited|literature cited|appendix|appendices|open peer commentary|continuing commentary|authors?['’]? response|preface|foreword|prologue|epilogue|afterword|glossary|index|notes|endnotes|footnotes|acknowledg(e)?ments?)\b/i;
/** Back matter that belongs to the piece above it. */
const BACK = /^(notes|endnotes|footnotes|acknowledg)/i;
/** "by Robert P. Abelson", "by Aaron Sloman and Monica Croucher" */
const BYLINE = /^[Bb]y\s+((?:[A-Z][\w'’-]*\.?\s*){1,5}(?:(?:and|&)\s+(?:[A-Z][\w'’-]*\.?\s*){1,5})*)(.*)$/;
/** An author's institution, under their name. */
const AFFILIATION = /\b(university|department|dept\.|institute|laborator(y|ies)|college|school of|cent(er|re) for|study|sciences|hospital|faculty|research|inc\.|ltd)\b/i;
const PART = /^part\s+([0-9]{1,2}|[IVXLC]{1,6}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const CHAPTER = /^(chapter|lecture|book)\s+([0-9]{1,3}|[IVXLC]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;

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
    // The line above, in each column: a two-column page is read as two columns.
    const prev: (number | null)[] = [null, null];
    for (const r of rows) {
      r.parts.sort((p1, p2) => p1.x - p2.x);
      // A wide gap is the gutter between columns: each side is a line of its own.
      const pieces: (typeof r.parts)[] = [];
      let piece: typeof r.parts = [];
      let reach = -Infinity;
      for (const part of r.parts) {
        const last = piece.at(-1);
        const jump = !!last && Math.max(part.size, last.size) / Math.min(part.size, last.size) > 1.35 && part.x - reach > 1.5;
        if (piece.length && (part.x - reach > Math.max(part.size, 6) * 1.6 || jump)) {
          pieces.push(piece);
          piece = [];
          reach = -Infinity;
        }
        piece.push(part);
        reach = Math.max(reach, part.x + part.w);
      }
      if (piece.length) pieces.push(piece);

      for (const parts of pieces) {
        let text = '';
        let end = -Infinity;
        let size = 0;
        for (const part of parts) {
          if (text && part.x - end > part.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(part.s)) text += ' ';
          text += part.s;
          end = Math.max(end, part.x + part.w);
          if (part.s.trim().length > 2 || !size) size = Math.max(size, part.size);
        }
        text = squash(text);
        if (!text) continue;
        const x0 = parts[0].x;
        const col = x0 < vp.width * 0.42 ? 0 : 1;
        const spans = col === 0 && end > vp.width * 0.6;
        const above = prev[col];
        lines.push({
          p: i,
          text,
          size: size || r.size,
          x0,
          x1: end,
          base: r.base,
          ph: vp.height,
          pw: vp.width,
          col: spans ? -1 : col,
          gapAbove: above === null ? Infinity : r.base - above,
        });
        prev[col] = r.base;
        if (spans) prev[1] = r.base;
      }
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
  // Each column's own full line width, so "short" means short for that column.
  const colWidths = new Map<string, number[]>();
  for (const l of lines) {
    if (!isBody(l)) continue;
    const k = `${l.p}:${l.col}`;
    if (!colWidths.has(k)) colWidths.set(k, []);
    colWidths.get(k)!.push(l.x1 - l.x0);
  }
  const widthOf = (l: Line) => {
    const ws = colWidths.get(`${l.p}:${l.col}`);
    return ws && ws.length >= 8 ? quantile(ws, 0.9) : lineWidth;
  };

  // Running heads and page numbers come back on every page, near its top or bottom edge.
  // "Commentary/Searle: Minds, brains…" and "References/Searle: Minds, brains…" are the
  // same head, so they're also compared without their first word.
  const norm = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim();
  const tailOf = (s: string) => norm(s).replace(/^\S+\s+/, '');
  const nearEdge = (l: Line) => l.base < l.ph * 0.12 || l.base > l.ph * 0.88;
  const pagesWith = new Map<string, Set<number>>();
  const count = (k: string, p: number) => {
    if (k.length < 4) return;
    if (!pagesWith.has(k)) pagesWith.set(k, new Set());
    pagesWith.get(k)!.add(p);
  };
  for (const l of lines) {
    if (!nearEdge(l)) continue;
    count(norm(l.text), l.p);
    count(`~${tailOf(l.text)}`, l.p);
  }
  const runningHead = (l: Line) =>
    nearEdge(l) &&
    ((pagesWith.get(norm(l.text))?.size ?? 0) >= 3 ||
      (tailOf(l.text).length >= 12 && (pagesWith.get(`~${tailOf(l.text)}`)?.size ?? 0) >= 3));

  // The title on the first page isn't a heading.
  const firstPage = lines.filter((l) => l.p === 0);
  const titleSize = Math.max(...firstPage.map((l) => l.size), 0);

  /** The next line down in the same column (or one across both), within a few lines. */
  const sameCol = (a: Line, b: Line) => a.p === b.p && (a.col === b.col || a.col === -1 || b.col === -1);
  const after = (i: number, n = 6) => {
    const out: number[] = [];
    for (let j = i + 1; j < lines.length && out.length < n && lines[j].p === lines[i].p; j++) if (sameCol(lines[i], lines[j])) out.push(j);
    return out;
  };
  const before = (i: number, n = 3) => {
    const out: number[] = [];
    for (let j = i - 1; j >= 0 && out.length < n && lines[j].p === lines[i].p; j--) if (sameCol(lines[i], lines[j])) out.push(j);
    return out;
  };
  const inMargin = (l: Line) => l.base < l.ph * 0.04 || l.base > l.ph * 0.925;
  const titleLike = (l: Line) =>
    !inMargin(l) &&
    l.size >= body * 1.03 &&
    l.text.split(' ').length <= 16 &&
    !/[,;:]$/.test(l.text) &&
    !NUMBERED.test(l.text) &&
    /^[A-Z“"'(]/.test(l.text) &&
    !AFFILIATION.test(l.text);

  /** A title's second line: the same type, any case. */
  const goesOn = (l: Line) => !inMargin(l) && l.size >= body * 1.03 && l.text.split(' ').length <= 12 && !AFFILIATION.test(l.text);

  // Two-column pages: read the left column, then the right.
  const twoCol = new Set<number>();
  const perPage = new Map<number, [number, number]>();
  for (const l of lines) {
    if (!isBody(l)) continue;
    const c = perPage.get(l.p) ?? [0, 0];
    c[l.col === 1 ? 1 : 0]++;
    perPage.set(l.p, c);
  }
  for (const [p, [left, right]] of perPage) if (right >= 10 && right >= (left + right) * 0.25) twoCol.add(p);

  type Kind = 'numbered' | 'runin' | 'known' | 'back' | 'big' | 'byline' | 'part' | 'chapter';
  type Found = { kind: Kind; title: string; label?: string; p: number; base: number; ph: number; size: number; c?: number };
  const found: Found[] = [];
  const used = new Set<number>(); // lines that became part of another heading

  // Who wrote what: "by Name" next to a title starts a piece (a commentary, a chapter in a collection).
  lines.forEach((l, i) => {
    const m = l.text.match(BYLINE);
    if (!m || inMargin(l) || l.text.split(' ').length > 24) return;
    // What follows the name can only be where they work (sometimes printed on the same line).
    const tail = m[2].trim();
    if (tail && !(AFFILIATION.test(tail) || /^[\d(\[]/.test(tail))) return;
    // The paper's own byline, under its title on the first page, is not a heading.
    if (l.p === 0 && l.base < l.ph * 0.45) return;
    // The name stops where an institution starts ("John Searle Department of…").
    const names = m[1]
      .trim()
      .replace(/\s+(Department|Dept|University|Institute|School|College|Cent(er|re)|Laborator\w*|Faculty)\b.*$/i, '')
      .replace(/[.,]$/, '');
    const surnames = names
      .split(/\s+(?:and|&)\s+/)
      .map((n) => n.trim().split(/\s+/).at(-1)!.replace(/[.,]$/, ''))
      .join(' & ');
    let title: number[] = [];
    // The title below the name (past an affiliation in small type), or else just above it.
    for (const j of after(i, 4)) {
      const c = lines[j];
      if (c.size < body * 0.9 || AFFILIATION.test(c.text)) continue;
      if (titleLike(c)) {
        title = [j];
        const k = after(j, 1)[0];
        const next = k !== undefined ? lines[k] : undefined;
        if (next && goesOn(next) && Math.abs(next.size - c.size) < 0.6 && next.gapAbove <= c.size * 1.6) title.push(k!);
      }
      break;
    }
    if (!title.length) {
      const j = before(i, 1)[0];
      if (j !== undefined && titleLike(lines[j]) && l.gapAbove <= lines[j].size * 2.2) title = [j];
    }
    title.forEach((j) => used.add(j));
    used.add(i);
    const text = title.map((j) => lines[j].text).join(' ');
    const top = title.length && lines[title[0]].base < l.base ? lines[title[0]] : l;
    found.push({
      kind: 'byline',
      title: text ? `${surnames}: ${text}` : names,
      p: l.p,
      base: top.base,
      ph: l.ph,
      size: l.size,
      c: twoCol.has(l.p) ? (l.col === 1 ? 1 : 0) : undefined,
    });
  });

  lines.forEach((l, i) => {
    if (used.has(i)) return;
    const t = l.text;
    const words = t.split(' ').length;
    if (inMargin(l)) return;
    if (t.length < 2 || !/[A-Za-z]{2}/.test(t) || /^(fig(ure)?|table|eq(uation)?|algorithm|listing)\b/i.test(t)) return;
    if (runningHead(l)) return;
    if (l.p === 0 && l.size >= titleSize && l.size >= body * 1.3) return;
    const alone = l.gapAbove >= lineGap * 1.35;
    const short = l.x1 - l.x0 <= widthOf(l) * 0.82;
    const big = l.size >= body * 1.15;
    const at = { p: l.p, base: l.base, ph: l.ph, size: l.size, c: twoCol.has(l.p) ? (l.col === 1 ? 1 : 0) : undefined };

    // A heading that starts its paragraph: "I. The systems reply (Berkeley). While it is…"
    if (alone) {
      const run = runIn(t);
      if (run) return void found.push({ kind: 'runin', title: run.title, label: run.label, ...at });
    }
    if (t.length > 110 || words > 14) return;
    // A sentence's last line, not a heading (a short numbered title may still end in a full stop).
    if (/[,;:]$/.test(t) || (/\.$/.test(t) && !(NUMBERED.test(t) && words <= 8))) return;
    const num = t.match(NUMBERED);
    const rest = num ? t.slice(num[0].length) : t;
    if (!/^[A-Z“"']/.test(rest)) return;
    if ((alone || big) && short && PART.test(t)) return void found.push({ kind: 'part', title: t, ...at });
    if ((alone || big) && short && CHAPTER.test(t)) return void found.push({ kind: 'chapter', title: t, ...at });
    if (num && alone && short && words <= 12) return void found.push({ kind: 'numbered', title: t, label: num[1], ...at });
    if (KNOWN.test(rest) && words <= 5 && (alone || big))
      return void found.push({ kind: BACK.test(rest) ? 'back' : 'known', title: t, ...at });
    if (big && short && (alone || l.gapAbove === Infinity)) found.push({ kind: 'big', title: t, ...at });
  });

  found.sort((a, b) => a.p - b.p || (a.c ?? 0) - (b.c ?? 0) || a.base - b.base);

  // Above the first real heading on page one is the paper's front matter: authors, affiliations.
  const firstReal = found.find((f) => f.p === 0 && f.kind !== 'big');
  const kept = found.filter(
    (f) => !(f.p === 0 && f.kind === 'big' && (firstReal ? f.base < firstReal.base : f.base < f.ph * 0.35)),
  );

  // A big heading that runs onto a second line is one heading.
  const merged: Found[] = [];
  for (const f of kept) {
    const last = merged.at(-1);
    if (last && f.kind === 'big' && last.kind === 'big' && last.p === f.p && Math.abs(last.size - f.size) < 0.5 && f.base - last.base <= f.size * 1.6) {
      last.title = `${last.title} ${f.title}`;
      continue;
    }
    merged.push({ ...f });
  }

  // Levels. Numbering says it outright; parts hold chapters; bigger type is a higher level;
  // a piece with a byline sits under the heading before it; notes sit under what they belong to.
  const bigSizes = [...new Set(merged.filter((f) => f.kind === 'big').map((f) => Math.round(f.size)))].sort((a, b) => b - a);
  const hasParts = merged.some((f) => f.kind === 'part');
  const hasTop = merged.some((f) => f.kind !== 'numbered' || /^\d+\.?$|^[IVXLC]+\.$/.test(f.label ?? ''));
  const numberLevel = (lab: string) => {
    if (/^\d/.test(lab)) return lab.replace(/\.$/, '').split('.').length;
    if (/^[IVXLC]+\.$/.test(lab)) return 1;
    return hasTop ? 2 : 1; // (1), (a), A.
  };
  const out: Section[] = [];
  let lastTop: number | null = null; // the level of the latest heading that isn't back matter
  for (const f of merged) {
    let level: number;
    if (f.kind === 'numbered' || f.kind === 'runin') level = numberLevel(f.label!);
    else if (f.kind === 'part') level = 1;
    else if (f.kind === 'chapter') level = hasParts ? 2 : 1;
    else if (f.kind === 'known') level = 1;
    else if (f.kind === 'back') level = Math.min(3, (lastTop ?? 0) + 1);
    else if (f.kind === 'byline') level = out.length ? Math.min(3, (out.findLast((s) => s.level === 1) ? 2 : 1)) : 1;
    else level = Math.min(3, bigSizes.indexOf(Math.round(f.size)) + 1);
    if (f.kind !== 'back') lastTop = level;
    out.push({
      title: f.title.slice(0, 140),
      level,
      p: f.p,
      y: Math.max(0, Math.min(1, (f.base - f.size) / f.ph)),
      ...(f.c !== undefined ? { c: f.c } : {}),
    });
  }
  const top = Math.min(...out.map((s) => s.level), 1);
  return out.map((s) => ({ ...s, level: Math.max(1, Math.min(3, s.level - top + 1)) }));
}

/** A heading at the start of a paragraph, ending in a full stop: its label and title. */
function runIn(t: string) {
  const m = t.match(/^((?:[IVXLC]{1,6}|\d{1,2}(?:\.\d{1,2}){0,2})\.)\s+(?=[A-Z])/);
  if (!m) return null;
  const rest = t.slice(m[0].length);
  let depth = 0;
  for (let i = 0; i < Math.min(rest.length, 110); i++) {
    const ch = rest[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '.' && depth === 0 && (i === rest.length - 1 || /\s/.test(rest[i + 1]))) {
      const title = rest.slice(0, i).trim();
      const words = title.split(' ').length;
      return title.length >= 3 && words <= 12 ? { label: m[1], title: `${m[1]} ${title}` } : null;
    }
  }
  return null;
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

/** For looking at how a PDF reads (diagnostics). */
export { linesOf as pdfLines };
