import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { SelectionPop, type MarkMode } from './SelectionPop';
import { hasNote } from '../notes';
import type { Highlight } from '../types';

interface Props {
  url: string;
  highlights: Highlight[];
  active: string | null;
  editable: boolean;
  jump: { id: string; n: number } | null;
  onPick: (id: string | null, x: number, y: number) => void;
  onCreate: (h: { text: string; start: number; end: number }, mode: MarkMode, x: number, y: number) => void;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function offsetOf(root: Node, node: Node, offset: number) {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Wraps characters [start, end) of root's text in <mark> elements. */
function wrap(root: HTMLElement, start: number, end: number, id: string, cls: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: [Text, number, number][] = [];
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n && pos < end; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    const s = Math.max(start, pos);
    const e = Math.min(end, pos + len);
    if (s < e) parts.push([n, s - pos, e - pos]);
    pos += len;
  }
  for (const [node, s, e] of parts) {
    let t = node;
    if (s > 0) t = t.splitText(s);
    if (e - s < t.data.length) t.splitText(e - s);
    if (!t.data.trim()) continue;
    const m = document.createElement('mark');
    m.className = cls;
    m.dataset.id = id;
    t.replaceWith(m);
    m.appendChild(t);
  }
}

/** Margin markers for lines with notes. (Empty elements, so the text offsets don't change.) */
function placeMarkers(el: HTMLElement, highlights: Highlight[], active: string | null) {
  el.querySelectorAll('.mnote').forEach((d) => d.remove());
  const top = el.getBoundingClientRect().top;
  for (const h of highlights) {
    if (!hasNote(h)) continue;
    const m = el.querySelector(`mark[data-id="${h.id}"]`);
    if (!m) continue;
    const r = m.getBoundingClientRect();
    const dot = document.createElement('span');
    dot.className = `mnote${h.id === active ? ' on' : ''}`;
    dot.dataset.id = h.id;
    dot.title = h.note;
    dot.style.top = `${r.top - top + r.height / 2}px`;
    el.appendChild(dot);
  }
}

/** A saved web page, cleaned up, with highlights anchored by character offsets. */
export function HtmlDoc({ url, highlights, active, editable, jump, onPick, onCreate }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; start: number; end: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => alive && setHtml(DOMPurify.sanitize(t, { FORBID_TAGS: ['style', 'form', 'iframe', 'script'] })))
      .catch(() => alive && setHtml('<p>Couldn’t load the saved page.</p>'));
    return () => {
      alive = false;
    };
  }, [url]);

  // Only re-wrap when anchors change, not on every keystroke of a note.
  const anchors = highlights.map((h) => `${h.id}:${h.start}:${h.end}:${h.kind ?? ''}:${hasNote(h) ? 1 : 0}`).join();
  const latest = useRef(highlights);
  latest.current = highlights;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || html === null) return;
    const highlights = latest.current;
    el.innerHTML = html;
    el.querySelectorAll('a').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noreferrer';
    });
    const full = el.textContent ?? '';
    for (const h of [...highlights].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))) {
      let { start = -1, end = -1 } = h;
      if (squash(full.slice(start, end)) !== squash(h.text)) {
        // Text moved? Find it again.
        start = full.indexOf(h.text);
        end = start + h.text.length;
      }
      const kindClass = h.kind === 'note' ? ' note' : h.kind === 'definition' ? ' def' : '';
      if (start >= 0) wrap(el, start, end, h.id, `hl${kindClass}${h.id === active ? ' on' : ''}`);
    }
    placeMarkers(el, highlights, active);
  }, [html, anchors, active]);

  // Images load late and push text down; keep the markers next to their lines.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => placeMarkers(el, latest.current, activeRef.current));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the hover preview of each margin note current.
  useEffect(() => {
    box.current?.querySelectorAll<HTMLElement>('.mnote').forEach((d) => {
      d.title = highlights.find((h) => h.id === d.dataset.id)?.note ?? '';
    });
  });

  useEffect(() => {
    if (!jump) return;
    box.current?.querySelector(`mark[data-id="${jump.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [jump, html]);

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const sel = window.getSelection();
      const el = box.current;
      if (!el) return;
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setPending(null);
        const m = (e.target as HTMLElement).closest<HTMLElement>('mark.hl, .mnote');
        onPick(m?.dataset.id ?? null, e.clientX, e.clientY);
        return;
      }
      if (!editable) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      const raw = range.toString();
      if (squash(raw).length < 2) return;
      const start = offsetOf(el, range.startContainer, range.startOffset);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      setPending({ text: squash(raw), start, end: start + raw.length, x: last.right + 8, y: last.bottom + 6 });
    },
    [editable, onPick],
  );

  const commit = useCallback(
    (mode: MarkMode) => {
      if (!pending) return;
      onCreate({ text: pending.text, start: pending.start, end: pending.end }, mode, pending.x, pending.y);
      window.getSelection()?.removeAllRanges();
      setPending(null);
    },
    [pending, onCreate],
  );

  return (
    <>
      {html === null && <div className="doc-msg">opening…</div>}
      <article className="snapshot" ref={box} onMouseUp={onMouseUp} />
      {pending && (
        <SelectionPop
          x={pending.x}
          y={pending.y}
          onPick={commit}
          onDismiss={() => setPending(null)}
        />
      )}
    </>
  );
}
