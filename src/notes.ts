import type { Article, Highlight, Library } from './types';
import type { Tree } from './tree';

/** Reading order: page, then position on the page (PDF) or in the text (web page). */
export const readingOrder = (h: Highlight) =>
  h.rects?.length ? h.rects[0].p * 10 + h.rects[0].y : h.start !== undefined ? h.start / 1e7 : 1e9;

export const sortNotes = (hs: Highlight[]) => [...hs].sort((a, b) => readingOrder(a) - readingOrder(b));

export const isDefinition = (h: Highlight) => h.kind === 'definition';

/** A line with a note on it (definitions are listed apart, as terms). */
export const hasNote = (h: Highlight) => !isDefinition(h) && (h.kind === 'note' || !!h.note.trim());

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
  for (const h of sortNotes(a.highlights)) {
    if (isDefinition(h)) continue;
    const page = h.rects?.length ? ` (p. ${h.rects[0].p + 1})` : '';
    if (h.text) {
      out.push('', `> ${h.text}${page}`);
      if (h.note.trim()) out.push('', h.note.trim());
    } else if (h.note.trim()) {
      out.push('', `- ${h.note.trim().replace(/\n/g, '\n  ')}`);
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
