import type { Article, Library, LibNode } from './types';

/** Lookup helpers over the flat node list. Rebuilt whenever the library changes. */
export class Tree {
  readonly byId = new Map<string, LibNode>();
  readonly kids = new Map<string | null, LibNode[]>();
  readonly neighbors = new Map<string, Set<string>>();

  constructor(lib: Library) {
    for (const n of lib.nodes) this.byId.set(n.id, n);
    for (const n of lib.nodes) {
      const p = n.parent && this.byId.has(n.parent) ? n.parent : null;
      if (!this.kids.has(p)) this.kids.set(p, []);
      this.kids.get(p)!.push(n);
    }
    for (const l of lib.links) {
      if (!this.neighbors.has(l.a)) this.neighbors.set(l.a, new Set());
      if (!this.neighbors.has(l.b)) this.neighbors.set(l.b, new Set());
      this.neighbors.get(l.a)!.add(l.b);
      this.neighbors.get(l.b)!.add(l.a);
    }
  }

  get(id: string | null | undefined) {
    return id ? this.byId.get(id) : undefined;
  }

  article(id: string | null | undefined): Article | undefined {
    const n = this.get(id);
    return n?.type === 'article' ? n : undefined;
  }

  children(id: string | null) {
    return this.kids.get(id) ?? [];
  }

  parentOf(id: string): string | null {
    const p = this.get(id)?.parent;
    return p && this.byId.has(p) ? p : null;
  }

  /** Root-first chain of topics leading to (and including) id. */
  path(id: string | null): LibNode[] {
    const out: LibNode[] = [];
    const seen = new Set<string>();
    let cur = this.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = this.get(cur.parent);
    }
    return out;
  }

  isInside(id: string, ancestor: string) {
    return this.path(id).some((n) => n.id === ancestor);
  }

  topics() {
    return [...this.byId.values()].filter((n) => n.type === 'topic');
  }
}
