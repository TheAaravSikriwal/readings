import { useSyncExternalStore } from 'react';
import { api } from './api';
import { Tree } from './tree';
import type { Article, Bookmark, Highlight, Library, Link, MapSettings, Topic } from './types';

/** Editing only exists on the local dev server; the built website is read-only. */
export const EDITABLE = import.meta.env.DEV;

export interface State {
  lib: Library;
  tree: Tree;
  rev: number;
  loaded: boolean;
  error?: string;
  save: 'saved' | 'saving' | 'error';
  pending: ReadonlySet<string>;
  toast: { text: string; id: number } | null;
}

const emptyLib = (): Library => ({ version: 1, title: 'Readings', nodes: [], links: [] });

let state: State = {
  lib: emptyLib(),
  tree: new Tree(emptyLib()),
  rev: 0,
  loaded: false,
  save: 'saved',
  pending: new Set(),
  toast: null,
};

const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getState = () => state;
export const useStore = () => useSyncExternalStore(subscribe, getState);

export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ---- persistence (debounced; whole library is one small JSON file)

let saveTimer: number | undefined;
let dirty = false;

export async function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    await api.save(state.lib);
    if (!dirty) set({ save: 'saved' });
  } catch {
    dirty = true;
    set({ save: 'error' });
  }
}

function scheduleSave() {
  if (!EDITABLE) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 450);
}

// ---- undo / redo: whole-library snapshots (the library is one small JSON file)

const past: string[] = [];
const future: string[] = [];
let lastKey = '';
let lastAt = 0;

/** Keeps the library as it was before a change. Changes that share a key and
 * come close together (typing in one field) are one step. */
function remember(key: string) {
  const t = Date.now();
  if (key && key === lastKey && t - lastAt < 1200) {
    lastAt = t;
    return;
  }
  past.push(JSON.stringify(state.lib));
  if (past.length > 120) past.shift();
  future.length = 0;
  lastKey = key;
  lastAt = t;
}

function apply(lib: Library) {
  set({ lib, tree: new Tree(lib), rev: state.rev + 1, save: EDITABLE ? 'saving' : state.save });
  scheduleSave();
}

function commit(fn: (lib: Library) => void, key = '') {
  if (EDITABLE) remember(key);
  fn(state.lib);
  set({ tree: new Tree(state.lib), rev: state.rev + 1, save: EDITABLE ? 'saving' : state.save });
  scheduleSave();
}

const fieldKey = (prefix: string, id: string, patch: object) => `${prefix}:${id}:${Object.keys(patch).sort().join(',')}`;

if (EDITABLE) {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
}

// ---- actions

const article = (id: string) => state.tree.article(id);

export const actions = {
  async load() {
    try {
      const lib = await api.load();
      lib.nodes ??= [];
      lib.links ??= [];
      lib.title ||= 'Readings';
      for (const n of lib.nodes) if (n.type === 'article') n.highlights ??= [];
      past.length = future.length = 0;
      set({ lib, tree: new Tree(lib), rev: state.rev + 1, loaded: true });
    } catch (e: any) {
      set({ loaded: true, error: e?.message ?? String(e) });
    }
  },

  replace(lib: Library) {
    commit((l) => Object.assign(l, lib));
  },

  /** Steps back one change. Returns false when there is nothing to undo. */
  undo() {
    const prev = past.pop();
    if (!prev) return false;
    future.push(JSON.stringify(state.lib));
    lastKey = '';
    apply(JSON.parse(prev));
    return true;
  },

  redo() {
    const next = future.pop();
    if (!next) return false;
    past.push(JSON.stringify(state.lib));
    lastKey = '';
    apply(JSON.parse(next));
    return true;
  },

  setTitle(title: string) {
    commit((lib) => void (lib.title = title), 'title');
  },

  addTopic(parent: string | null, title: string) {
    const id = uid('t');
    commit((lib) => lib.nodes.push({ id, type: 'topic', title, parent, created: now() }));
    return id;
  },

  addArticle(parent: string | null, fields: Partial<Article> & { id?: string }) {
    const id = fields.id ?? uid('a');
    commit((lib) =>
      lib.nodes.push({ highlights: [], ...fields, id, type: 'article', title: fields.title || 'Untitled', parent, created: now() }),
    );
    return id;
  },

  update(id: string, patch: Partial<Omit<Topic, 'type'>> & Partial<Omit<Article, 'type'>>) {
    commit(() => {
      const n = state.tree.get(id);
      if (n) Object.assign(n, patch);
    }, fieldKey('node', id, patch));
  },

  /** Fills only fields that are still empty. The title is also replaced while it is still the placeholder. */
  fill(id: string, patch: Partial<Article>, placeholderTitle?: string) {
    const n = article(id);
    if (!n) return;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const cur = (n as unknown as Record<string, unknown>)[k];
      if (v && (!cur || (k === 'title' && cur === placeholderTitle))) out[k] = v;
    }
    if (Object.keys(out).length) actions.update(id, out);
  },

  /** Moves a bubble into a topic (or to the top level). Refuses loops. */
  move(id: string, parent: string | null) {
    const t = state.tree;
    if (parent === id || t.get(id)?.parent === parent) return false;
    if (parent && (t.get(parent)?.type !== 'topic' || t.isInside(parent, id))) return false;
    commit(() => {
      const n = t.get(id)!;
      n.parent = parent;
      delete n.pin; // it orbits its new topic now
    });
    return true;
  },

  setSettings(patch: Partial<MapSettings>) {
    commit((lib) => void (lib.settings = { ...lib.settings, ...patch }), `settings:${Object.keys(patch).sort().join(',')}`);
  },

  /** Holds a bubble at a spot on the map (null lets it float again). */
  pin(id: string, at: [number, number, number] | null) {
    commit(() => {
      const n = state.tree.get(id);
      if (!n) return;
      if (at) n.pin = at;
      else delete n.pin;
    });
  },

  unpinAll() {
    commit((lib) => lib.nodes.forEach((n) => delete n.pin));
  },

  /** A new bubble in the middle of a connection: A to B becomes A to new to B.
   * It goes in the deepest topic that holds both ends. */
  insertOnLink(linkId: string, kind: 'topic' | 'article', title: string) {
    const l = state.lib.links.find((x) => x.id === linkId);
    if (!l) return null;
    const t = state.tree;
    const holders = (id: string) => {
      const n = t.get(id);
      return t.path(n?.type === 'topic' ? id : (n?.parent ?? null)).map((x) => x.id);
    };
    const inB = new Set(holders(l.b));
    let parent: string | null = null;
    for (const h of holders(l.a)) if (inB.has(h)) parent = h;
    const id = uid(kind === 'topic' ? 't' : 'a');
    commit((lib) => {
      lib.nodes.push(
        kind === 'topic'
          ? { id, type: 'topic', title, parent, created: now() }
          : { id, type: 'article', title, parent, highlights: [], created: now() },
      );
      const old = lib.links.find((x) => x.id === linkId)!;
      const b = old.b;
      old.b = id;
      lib.links.push({ id: uid('l'), a: id, b });
    });
    return id;
  },

  /** A new topic between a bubble and the topic it's in. */
  insertAbove(childId: string, title: string) {
    const c = state.tree.get(childId);
    if (!c) return null;
    const id = uid('t');
    commit((lib) => {
      lib.nodes.push({ id, type: 'topic', title, parent: c.parent, created: now() });
      const n = lib.nodes.find((x) => x.id === childId)!;
      n.parent = id;
      delete n.pin;
    });
    return id;
  },

  /** Moves one end of a connection onto another bubble. Returns why not, or null. */
  relink(linkId: string, which: 'a' | 'b', target: string): string | null {
    const l = state.lib.links.find((x) => x.id === linkId);
    if (!l || !state.tree.get(target)) return 'That bubble is gone.';
    const keep = which === 'a' ? l.b : l.a;
    if (target === (which === 'a' ? l.a : l.b)) return null;
    if (target === keep) return 'A bubble can’t connect to itself.';
    if (actions.linkBetween(keep, target)) return 'Those two are already connected.';
    commit(() => {
      if (which === 'a') l.a = target;
      else l.b = target;
    });
    return null;
  },

  /** Deleting a topic keeps its contents: they move up one level. A deleted
   * reading's file is moved to data/trash by the server once nothing points at
   * it, and comes back if the delete is undone. */
  remove(id: string) {
    const t = state.tree;
    const n = t.get(id);
    if (!n) return;
    commit((lib) => {
      for (const c of t.children(id)) c.parent = n.parent;
      lib.nodes = lib.nodes.filter((x) => x.id !== id);
      lib.links = lib.links.filter((l) => l.a !== id && l.b !== id);
    });
  },

  linkBetween(a: string, b: string): Link | undefined {
    return state.lib.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  },

  connect(a: string, b: string) {
    if (a === b || actions.linkBetween(a, b)) return;
    commit((lib) => lib.links.push({ id: uid('l'), a, b }));
  },

  toggleConnection(a: string, b: string) {
    const l = actions.linkBetween(a, b);
    if (l) actions.disconnect(l.id);
    else actions.connect(a, b);
  },

  disconnect(linkId: string) {
    commit((lib) => void (lib.links = lib.links.filter((l) => l.id !== linkId)));
  },

  updateLink(linkId: string, patch: Partial<Link>) {
    commit((lib) => {
      const l = lib.links.find((x) => x.id === linkId);
      if (l) Object.assign(l, patch);
    }, fieldKey('link', linkId, patch));
  },

  addHighlight(articleId: string, h: Omit<Highlight, 'id' | 'created' | 'note'> & { note?: string }) {
    const id = uid('h');
    commit(() => {
      const a = article(articleId);
      if (a) a.highlights = [...a.highlights, { note: '', ...h, id, created: now() }];
    });
    return id;
  },

  updateHighlight(articleId: string, hid: string, patch: Partial<Highlight>) {
    commit(() => {
      const a = article(articleId);
      if (a) a.highlights = a.highlights.map((x) => (x.id === hid ? { ...x, ...patch } : x));
    }, fieldKey('hl', hid, patch));
  },

  addBookmark(articleId: string, b: { p?: number; y: number }) {
    const id = uid('b');
    commit(() => {
      const a = article(articleId);
      if (a) a.bookmarks = [...(a.bookmarks ?? []), { label: '', ...b, id, created: now() }];
    });
    return id;
  },

  updateBookmark(articleId: string, bid: string, patch: Partial<Bookmark>) {
    commit(() => {
      const a = article(articleId);
      if (a) a.bookmarks = (a.bookmarks ?? []).map((x) => (x.id === bid ? { ...x, ...patch } : x));
    }, fieldKey('bm', bid, patch));
  },

  removeBookmark(articleId: string, bid: string) {
    commit(() => {
      const a = article(articleId);
      if (a) a.bookmarks = (a.bookmarks ?? []).filter((x) => x.id !== bid);
    });
  },

  /** A reference that became a reading: remember which, and connect the two. */
  linkReference(articleId: string, hid: string, target: string) {
    commit((lib) => {
      const a = article(articleId);
      if (a) a.highlights = a.highlights.map((x) => (x.id === hid ? { ...x, linked: target } : x));
      if (articleId !== target && !actions.linkBetween(articleId, target))
        lib.links.push({ id: uid('l'), a: articleId, b: target, note: 'reference' });
    });
  },

  removeHighlight(articleId: string, hid: string) {
    commit(() => {
      const a = article(articleId);
      if (a) a.highlights = a.highlights.filter((x) => x.id !== hid);
    });
  },

  setPending(id: string, on: boolean) {
    const pending = new Set(state.pending);
    if (on) pending.add(id);
    else pending.delete(id);
    set({ pending });
  },

  toast(text: string) {
    const id = Date.now();
    set({ toast: { text, id } });
    setTimeout(() => state.toast?.id === id && set({ toast: null }), 4200);
  },
};
