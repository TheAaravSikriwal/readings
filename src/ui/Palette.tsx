import { useEffect, useMemo, useRef, useState } from 'react';
import { actions, useStore } from '../store';
import type { LibNode } from '../types';

export type PaletteMode = { kind: 'search' } | { kind: 'connect'; from: string } | { kind: 'move'; id: string };

interface Item {
  key: string;
  node: LibNode | null; // null = top level (move)
  where: string;
  snippet?: string;
  on?: boolean;
}

interface Props {
  mode: PaletteMode;
  onPick: (id: string | null) => void;
  onClose: () => void;
}

const TOP = '__top';

export function Palette({ mode, onPick, onClose }: Props) {
  const { tree, lib } = useStore();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const where = (n: LibNode) => tree.path(n.parent).map((p) => p.title).join(' / ') || lib.title;
    const out: Item[] = [];

    if (mode.kind === 'move') {
      const self = tree.get(mode.id);
      if (self?.parent && (!needle || 'top level'.includes(needle))) out.push({ key: TOP, node: null, where: lib.title });
      for (const t of tree.topics()) {
        if (t.id === mode.id || t.id === self?.parent || tree.isInside(t.id, mode.id)) continue;
        if (needle && !t.title.toLowerCase().includes(needle)) continue;
        out.push({ key: t.id, node: t, where: where(t) });
      }
      return out.slice(0, 60);
    }

    for (const n of lib.nodes) {
      if (mode.kind === 'connect' && n.id === mode.from) continue;
      const on = mode.kind === 'connect' ? !!actions.linkBetween(mode.from, n.id) : undefined;
      if (!needle) {
        out.push({ key: n.id, node: n, where: where(n), on });
        continue;
      }
      const hay = [n.title, n.type === 'article' ? `${n.authors ?? ''} ${n.year ?? ''}` : ''].join(' ').toLowerCase();
      if (hay.includes(needle)) {
        out.push({ key: n.id, node: n, where: where(n), on });
        continue;
      }
      if (mode.kind === 'search' && n.type === 'article') {
        const hit =
          n.highlights.find((h) => h.text.toLowerCase().includes(needle) || h.note.toLowerCase().includes(needle)) ??
          (n.summary?.toLowerCase().includes(needle) ? { text: n.summary } : undefined);
        if (hit) out.push({ key: n.id, node: n, where: where(n), snippet: hit.text });
      }
    }
    return out.slice(0, 60);
  }, [q, mode, tree, lib]);

  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.children[i]?.scrollIntoView({ block: 'nearest' });
  }, [i]);

  const pick = (it?: Item) => it && onPick(it.node ? it.node.id : null);
  const title =
    mode.kind === 'search'
      ? 'Find'
      : mode.kind === 'connect'
        ? `Connect “${tree.get(mode.from)?.title ?? ''}” to…`
        : `Move “${tree.get(mode.id)?.title ?? ''}” into…`;

  return (
    <div className="scrim top" onPointerDown={onClose}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sheet-title">{title}</div>
        <input
          autoFocus
          className="sheet-input"
          value={q}
          placeholder={mode.kind === 'search' ? 'Titles, authors, highlights, notes…' : 'Type to filter…'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((v) => Math.min(items.length - 1, v + 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setI((v) => Math.max(0, v - 1)));
            if (e.key === 'Enter') pick(items[i]);
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="results" ref={list}>
          {items.map((it, k) => (
            <button key={it.key} className={`result ${k === i ? 'on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => pick(it)}>
              <span className={`glyph ${it.node?.type ?? 'topic'}`} />
              <span className="result-main">
                <span className="result-title">{it.node ? it.node.title : 'Top level'}</span>
                <span className="result-where">{it.snippet ? `“${it.snippet.slice(0, 90)}”` : it.where}</span>
              </span>
              {it.on && <span className="tag">connected</span>}
            </button>
          ))}
          {!items.length && <div className="faint pad">Nothing found.</div>}
        </div>
      </div>
    </div>
  );
}
