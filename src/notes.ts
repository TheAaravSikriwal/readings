import type { Article, Highlight, Library } from './types';
import type { Tree } from './tree';

/** Reading order: page, then position on the page (PDF) or in the text (web page). */
export const readingOrder = (h: Highlight) =>
  h.rects?.length ? h.rects[0].p * 10 + h.rects[0].y : h.start !== undefined ? h.start / 1e7 : 1e9;

export const sortNotes = (hs: Highlight[]) => [...hs].sort((a, b) => readingOrder(a) - readingOrder(b));

export const hasNote = (h: Highlight) => h.kind === 'note' || !!h.note.trim();

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
  for (const h of sortNotes(a.highlights)) {
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
