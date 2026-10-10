import type { Article, Highlight, Library, Section } from './types';
import type { Tree } from './tree';

/** Reading order: page, then position on the page (PDF) or in the text (web page). */
export const readingOrder = (h: Highlight) =>
  h.rects?.length ? h.rects[0].p * 10 + h.rects[0].y : h.start !== undefined ? h.start / 1e7 : 1e9;

export const sortNotes = (hs: Highlight[]) => [...hs].sort((a, b) => readingOrder(a) - readingOrder(b));

/** The section a mark sits in: the last heading at or above it. -1 is before
 * the first heading; null is a note that isn't on the page at all. */
export function sectionIndex(h: Highlight, sections: Section[]): number | null {
  const r = h.rects?.[0];
  let k = -1;
  if (r) {
    sections.forEach((s, i) => {
      if (s.p !== undefined && (s.p < r.p || (s.p === r.p && (s.y ?? 0) <= r.y + 0.01))) k = i;
    });
    return k;
  }
  if (h.start !== undefined && h.text) {
    sections.forEach((s, i) => {
      if (s.at !== undefined && s.at <= h.start!) k = i;
    });
    return k;
  }
  return null;
}

export const isDefinition = (h: Highlight) => h.kind === 'definition';
export const isReference = (h: Highlight) => h.kind === 'reference';

/** A note that asks something: it ends in a question mark. Shown in red, labelled "question".
 * (Definitions and references keep their own look.) */
export const isQuestion = (h: Highlight) =>
  !isDefinition(h) && !isReference(h) && /\?["'”’)\]]*$/.test(h.note.trim());

/** A line with a note on it (definitions and references are listed apart). */
export const hasNote = (h: Highlight) =>
  !isDefinition(h) && !isReference(h) && (h.kind === 'note' || !!h.note.trim());

// ---- the glossary: every definition from every reading, one entry per term

/** Two spellings of a term are the same entry when they only differ in case,
 * spacing, surrounding punctuation or a plural s. */
export const termKey = (t: string) => {
  let k = t
    .toLowerCase()
    .replace(/[“”"'‘’()[\].,;:!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) k = k.slice(0, -1);
  return k;
};

/** What a definition says: what you wrote, or the passage you selected when
 * the passage itself was the definition. */
export const definitionText = (h: Highlight) =>
  h.note.trim() || (h.term && termKey(h.text) !== termKey(h.term) ? h.text.trim() : '');

export interface GlossarySource {
  articleId: string;
  highlightId: string;
  title: string;
  year?: string;
}

export interface GlossaryEntry {
  key: string;
  term: string;
  /** Different definitions of the term; the same wording from two readings is one, with both as sources. */
  defs: { text: string; sources: GlossarySource[] }[];
}

// ---- the reading list: every reference every reading makes, one entry per work

/** A citation as it reads best on its own: one line, without its list number. */
export const cleanCite = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^\s*(\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.)\s*/, '')
    .trim();

const refKey = (s: string) =>
  cleanCite(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const DOI = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
const ARXIV = /arxiv[:\s/]*(?:abs\/)?(\d{4}\.\d{4,5})/i;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/i;

/** A link a citation carries: its DOI, arXiv id or URL. */
export function citeLink(s: string): string | undefined {
  const doi = s.match(DOI)?.[1]?.replace(/[.,;)]+$/, '');
  if (doi) return `https://doi.org/${doi}`;
  const ax = s.match(ARXIV)?.[1];
  if (ax) return `https://arxiv.org/abs/${ax}`;
  return s.match(URL_RE)?.[0]?.replace(/[.,;)]+$/, '');
}

/** Best guesses at a citation's title, authors and year, to start a new reading from. */
export function guessCite(s: string) {
  const c = cleanCite(s);
  const year = c.match(/\b(1[89]\d\d|20\d\d)\b/)?.[1];
  const quoted = c.match(/[“"]([^”"]{8,})[”"]/)?.[1];
  const afterYear = c.match(/\((?:1[89]|20)\d\d[a-z]?\)\.?\s*([^.?!]{8,}[.?!]?)/)?.[1];
  // "A. Vaswani, N. Shazeer, et al. Attention is all you need. In …": the
  // sentences, not counting the dot after an initial. Authors end on a name.
  const parts = c.split(/(?<!\b[A-Z])\.\s+/);
  const named = parts.length > 2 && /(et al|[A-Z][\w'’-]+)$/.test(parts[0]) && /,| and /.test(parts[0]) && parts[1].length >= 8;
  const title = (quoted || afterYear || (named ? parts[1] : c)).replace(/[,.]\s*$/, '').trim().slice(0, 200);
  const cut = quoted ? c.indexOf(quoted) - 1 : afterYear ? c.search(/\((?:1[89]|20)\d\d/) : named ? parts[0].length : -1;
  const authors = cut > 0 ? c.slice(0, cut).replace(/[,.\s]+$/, '').slice(0, 160) || undefined : undefined;
  return { title, authors, year, url: citeLink(c) };
}

export const scholarUrl = (s: string) => `https://scholar.google.com/scholar?q=${encodeURIComponent(cleanCite(s))}`;

export interface ReferenceSource {
  articleId: string;
  highlightId: string;
  title: string;
  page?: number;
  note: string;
}

export interface ReferenceEntry {
  key: string;
  cite: string;
  sources: ReferenceSource[];
  /** The reading it is on the map as, if it is. */
  onMap?: string;
}

export function referenceList(lib: Library, only?: string): ReferenceEntry[] {
  const titles = new Map<string, string>();
  for (const n of lib.nodes) if (n.type === 'article') titles.set(refKey(n.title), n.id);
  const ids = new Set(lib.nodes.map((n) => n.id));
  /** A reading the citation names: its guessed title, or any longer title found in it. */
  const onMap = (cite: string, key: string) => {
    const hit = titles.get(refKey(guessCite(cite).title));
    if (hit) return hit;
    for (const [t, tid] of titles) if (t.length >= 16 && ` ${key} `.includes(` ${t} `)) return tid;
  };
  const entries = new Map<string, ReferenceEntry>();
  for (const n of lib.nodes) {
    if (n.type !== 'article' || (only && n.id !== only)) continue;
    for (const h of n.highlights) {
      if (!isReference(h)) continue;
      const cite = cleanCite(h.cite || h.text);
      const key = refKey(cite);
      if (!key) continue;
      let e = entries.get(key);
      if (!e) entries.set(key, (e = { key, cite, sources: [] }));
      e.sources.push({ articleId: n.id, highlightId: h.id, title: n.title, page: h.rects?.[0]?.p, note: h.note.trim() });
      const linked = h.linked && ids.has(h.linked) ? h.linked : onMap(cite, key);
      if (linked && linked !== n.id) e.onMap = linked;
    }
  }
  // Still to read first, then the ones cited most.
  return [...entries.values()].sort(
    (a, b) => Number(!!a.onMap) - Number(!!b.onMap) || b.sources.length - a.sources.length || a.cite.localeCompare(b.cite),
  );
}

export function glossary(lib: Library, only?: string): GlossaryEntry[] {
  const entries = new Map<string, GlossaryEntry>();
  for (const n of lib.nodes) {
    if (n.type !== 'article' || (only && n.id !== only)) continue;
    for (const h of n.highlights) {
      if (!isDefinition(h) || !h.term?.trim()) continue;
      const key = termKey(h.term);
      if (!key) continue;
      let e = entries.get(key);
      if (!e) entries.set(key, (e = { key, term: h.term.trim(), defs: [] }));
      const text = definitionText(h);
      const same = text.toLowerCase().replace(/\s+/g, ' ');
      let d = e.defs.find((x) => x.text.toLowerCase().replace(/\s+/g, ' ') === same);
      if (!d) e.defs.push((d = { text, sources: [] }));
      d.sources.push({ articleId: n.id, highlightId: h.id, title: n.title, year: n.year });
    }
  }
  return [...entries.values()].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'notes';

const heading = (level: number, text: string) => `${'#'.repeat(Math.min(level, 6))} ${text}`;

/** One article as Markdown: details, summary, quotes with your notes, connections. */
export function articleMarkdown(a: Article, tree: Tree, lib: Library, level = 2) {
  const out = [heading(level, a.title)];
  const meta = [a.authors, a.year, a.site].filter(Boolean).join(' · ');
  if (meta) out.push('', meta);
  if (a.url) out.push('', `Source: <${a.url}>`);
  if (a.summary?.trim()) out.push('', `**Summary.** ${a.summary.trim()}`);
  const terms = glossary(lib, a.id);
  if (terms.length) {
    out.push('', '**Definitions**', '');
    for (const t of terms) for (const d of t.defs) out.push(`- **${t.term}**${d.text ? `: ${d.text}` : ''}`);
  }
  const refs = referenceList(lib, a.id);
  if (refs.length) {
    out.push('', '**References worth following**', '');
    for (const r of refs) {
      const notes = r.sources.map((s) => s.note).filter(Boolean).join(' ');
      out.push(`- ${r.cite}${notes ? ` (${notes})` : ''}`);
    }
  }
  // Quotes sit under the heading of the section they come from.
  const sections = a.outline?.sections ?? [];
  let section = -2;
  for (const h of sortNotes(a.highlights)) {
    if (isDefinition(h) || isReference(h)) continue;
    const k = sections.length ? sectionIndex(h, sections) : null;
    if (k !== null && k >= 0 && k !== section) out.push('', `_${sections[k].title}_`);
    if (k !== null) section = k;
    const page = h.rects?.length ? ` (p. ${h.rects[0].p + 1})` : '';
    const q = isQuestion(h) ? '**Question:** ' : '';
    if (h.text) {
      out.push('', `> ${h.text}${page}`);
      if (h.note.trim()) out.push('', q + h.note.trim());
    } else if (h.note.trim()) {
      out.push('', `- ${q}${h.note.trim().replace(/\n/g, '\n  ')}`);
    }
  }
  const links = lib.links
    .filter((l) => l.a === a.id || l.b === a.id)
    .map((l) => ({ other: tree.get(l.a === a.id ? l.b : l.a), note: l.note }))
    .filter((x) => x.other);
  if (links.length) {
    out.push('', '**Connected to:**');
    for (const { other, note } of links) out.push(`- ${other!.title}${note ? ` (${note})` : ''}`);
  }
  return out.join('\n');
}

/** The whole library (or one topic and everything inside it) as Markdown. */
export function libraryMarkdown(lib: Library, tree: Tree, rootId: string | null = null) {
  const root = tree.get(rootId);
  const out = [`# ${root ? root.title : lib.title}`, '', `_Notes exported ${today()}_`];
  if (root?.type === 'topic' && root.note?.trim()) out.push('', root.note.trim());
  const walk = (parent: string | null, level: number) => {
    const kids = tree.children(parent);
    for (const n of kids) if (n.type === 'article') out.push('', articleMarkdown(n, tree, lib, level));
    for (const t of kids) {
      if (t.type !== 'topic') continue;
      out.push('', heading(level, t.title));
      if (t.note?.trim()) out.push('', t.note.trim());
      walk(t.id, level + 1);
    }
  };
  walk(rootId, 2);
  const inside = new Set(
    lib.nodes.filter((n) => n.type === 'article' && (!rootId || tree.isInside(n.id, rootId))).map((n) => n.id),
  );
  const terms = glossary(lib).filter((t) => t.defs.some((d) => d.sources.some((s) => inside.has(s.articleId))));
  const refs = referenceList(lib).filter((r) => r.sources.some((s) => inside.has(s.articleId)));
  if (refs.length) {
    out.push('', '## Reading list', '', '_References from these readings._', '');
    for (const r of refs) {
      const from = r.sources.map((s) => s.title).join('; ');
      out.push(`- ${r.onMap ? '[on the map] ' : ''}${r.cite} _cited in ${from}_`);
    }
  }
  if (terms.length) {
    out.push('', '## Glossary', '');
    for (const t of terms) {
      for (const d of t.defs) {
        const from = d.sources.map((s) => `${s.title}${s.year ? ` (${s.year})` : ''}`).join('; ');
        out.push(`- **${t.term}**${d.text ? `: ${d.text}` : ''} _${from}_`);
      }
    }
  }
  return out.join('\n') + '\n';
}

export function download(name: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const exportName = (title: string, ext: 'md' | 'json', what = 'notes') => `${slug(title)}-${what}-${today()}.${ext}`;
