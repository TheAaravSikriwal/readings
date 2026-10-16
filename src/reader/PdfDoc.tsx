import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPdf, pdfjs } from './pdfjs';
import { SelectionPop, type MarkMode } from './SelectionPop';
import { hasNote, isQuestion } from '../notes';
import type { Highlight, Rect, Section } from '../types';

interface Props {
  url: string;
  highlights: Highlight[];
  active: string | null;
  zoom: number;
  /** 'page' fits a whole page on screen (focus mode); 'width' fits the column */
  fit: 'width' | 'page';
  editable: boolean;
  jump: { id: string; n: number } | null;
  onPick: (id: string | null, x: number, y: number) => void;
  onCreate: (h: { text: string; rects: Rect[] }, mode: MarkMode, x: number, y: number) => void;
  /** Look for the document's headings (once; they're kept with the reading after that). */
  findOutline?: boolean;
  /** Changes when the headings should be looked for again. */
  outlineTick?: number;
  onOutline?: (sections: Section[]) => void;
}

interface Pending {
  text: string;
  rects: Rect[];
  x: number;
  y: number;
}

/** The selected part of each text-layer text node, in reading order, and each
 * line end pdf.js marked. Only the pages' text: never the page numbers between. */
function eachPiece(range: Range, onText: (text: string, span: Element) => void, onBreak: () => void) {
  let root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) root = root.parentNode!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode as Node | null; n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const span = n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element);
    if (!span?.closest('.textLayer')) continue;
    if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n as Element).tagName === 'BR') onBreak();
      continue;
    }
    const t = n as Text;
    const from = t === range.startContainer ? range.startOffset : 0;
    const to = t === range.endContainer ? range.endOffset : t.length;
    if (to > from) onText(t.data.slice(from, to), span);
  }
}

/** Selected text. A space wherever the words are apart on the page, and a word
 * broken over a line end ("sub-" / "stituted") put back together. */
function rangeText(range: Range) {
  let out = '';
  let prev: DOMRect | null = null;
  eachPiece(
    range,
    (text, span) => {
      const b = span.getBoundingClientRect();
      if (prev && out && !/\s$/.test(out) && !/^\s/.test(text)) {
        const h = Math.min(prev.height, b.height);
        if (Math.abs(b.top - prev.top) > h * 0.5 || b.left - prev.right > h * 0.2) out += ' ';
      }
      out += text;
      prev = b;
    },
    () => (out += '\u0000'),
  );
  return out
    .replace(/(\p{L})-\s*\u0000\s*(?=\p{Ll})/gu, '$1')
    .replace(/[\s\u0000]+/g, ' ')
    .trim();
}

/** The boxes of the selected text alone, never a whole span or page that happens
 * to be inside it. */
function textRects(range: Range) {
  const out: DOMRect[] = [];
  const part = document.createRange();
  let root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) root = root.parentNode!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n) || !n.parentElement?.closest('.textLayer')) continue;
    const t = n as Text;
    part.selectNodeContents(t);
    if (t === range.startContainer) part.setStart(t, range.startOffset);
    if (t === range.endContainer) part.setEnd(t, range.endOffset);
    for (const cr of part.getClientRects()) out.push(cr);
  }
  return out;
}

/** A selection as boxes on its pages, and where on screen it ends. */
function selectionBoxes(range: Range, root: HTMLElement) {
  const pages = [...root.querySelectorAll<HTMLElement>('.pdf-page')].map((el) => ({ el, b: el.getBoundingClientRect() }));
  const rects: Rect[] = [];
  let last: DOMRect | null = null;
  for (const cr of textRects(range)) {
    if (cr.width < 1 || cr.height < 1) continue;
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const pg = pages.find(({ b }) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
    if (!pg || cr.height > pg.b.height * 0.08) continue;
    rects.push({
      p: Number(pg.el.dataset.page),
      x: (cr.left - pg.b.left) / pg.b.width,
      y: (cr.top - pg.b.top) / pg.b.height,
      w: cr.width / pg.b.width,
      h: cr.height / pg.b.height,
    });
    last = cr;
  }
  return { rects: mergeRects(rects), last };
}

/** One clean band per run of words on a line. Scanned pages carry a crooked text
 * layer (words a few pixels up or down, boxes overlapping the next line), so
 * the words are grouped into lines by their middles first, joined left to
 * right, and each band sits at its words' average height, not their union. */
function mergeRects(rects: Rect[]): Rect[] {
  const mid = (r: Rect) => r.y + r.h / 2;
  const sorted = [...rects].sort((a, b) => a.p - b.p || mid(a) - mid(b));
  const lines: Rect[][] = [];
  for (const r of sorted) {
    const line = lines.at(-1);
    const centre = line && line.reduce((s, x) => s + mid(x), 0) / line.length;
    const h = line && Math.min(r.h, line.reduce((s, x) => s + x.h, 0) / line.length);
    if (line && line[0].p === r.p && Math.abs(mid(r) - centre!) < h! * 0.5) line.push(r);
    else lines.push([r]);
  }
  const out: Rect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let run: Rect[] = [];
    const flush = () => {
      if (!run.length) return;
      const weight = run.reduce((s, r) => s + r.w, 0) || 1;
      const y = run.reduce((s, r) => s + r.y * r.w, 0) / weight;
      const bottom = run.reduce((s, r) => s + (r.y + r.h) * r.w, 0) / weight;
      const x = run[0].x;
      const right = Math.max(...run.map((r) => r.x + r.w));
      out.push({ p: run[0].p, x, y, w: right - x, h: bottom - y });
      run = [];
    };
    for (const r of line) {
      const right = run.length ? Math.max(...run.map((x) => x.x + x.w)) : 0;
      if (run.length && r.x > right + 0.012) flush();
      run.push(r);
    }
    flush();
  }
  return out;
}

interface Caret {
  node: Node;
  offset: number;
}

function caretFromPoint(x: number, y: number): Caret | null {
  const d = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** The place in the text nearest a point: inside the word under it, or at the
 * near end of the closest word, on the same line before any other. */
function caretNear(root: HTMLElement, x: number, y: number): Caret | null {
  let page: HTMLElement | null = null;
  let gap = Infinity;
  for (const el of root.querySelectorAll<HTMLElement>('.pdf-page')) {
    const b = el.getBoundingClientRect();
    const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
    if (d < gap) [gap, page] = [d, el];
    if (!d) break;
  }
  if (!page) return null;
  let best: { t: Text; r: DOMRect } | null = null;
  let score = Infinity;
  for (const span of page.querySelectorAll<HTMLElement>('.textLayer span:not(.markedContent)')) {
    const t = span.firstChild;
    if (t?.nodeType !== Node.TEXT_NODE || !(t as Text).data.trim()) continue;
    const r = span.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const s = dx + dy * 4 + Math.abs(y - (r.top + r.bottom) / 2) * 0.5;
    if (s < score) [score, best] = [s, { t: t as Text, r }];
  }
  if (!best) return null;
  const { t, r } = best;
  if (x <= r.left) return { node: t, offset: 0 };
  if (x >= r.right) return { node: t, offset: t.length };
  const hit = caretFromPoint(x, (r.top + r.bottom) / 2);
  if (hit?.node === t) return hit;
  return { node: t, offset: Math.round(((x - r.left) / r.width) * t.length) };
}

function selectWord(sel: Selection, c: Caret) {
  const t = c.node as Text;
  const word = /[\p{L}\p{N}'’_-]/u;
  let a = c.offset;
  let b = c.offset;
  while (a > 0 && word.test(t.data[a - 1])) a--;
  while (b < t.length && word.test(t.data[b])) b++;
  if (a === b) b = Math.min(t.length, a + 1);
  sel.setBaseAndExtent(t, a, t, b);
}

/** The line as pdf.js gave it: the words between two line ends. */
function selectLine(sel: Selection, c: Caret) {
  const span = c.node.parentElement!;
  const items = [...span.closest('.textLayer')!.querySelectorAll('span:not(.markedContent), br')];
  let a = items.indexOf(span);
  let b = a;
  while (a > 0 && items[a - 1].tagName !== 'BR') a--;
  while (b < items.length - 1 && items[b + 1].tagName !== 'BR') b++;
  const end = items[b].firstChild ?? items[b];
  sel.setBaseAndExtent(items[a].firstChild ?? items[a], 0, end, end.textContent?.length ?? 0);
}

/** One margin marker per note: at the first line it covers on this page. */
function firstOnPage(marks: { h: Highlight; r: Rect }[]) {
  const seen = new Set<string>();
  return marks.filter(({ h }) => hasNote(h) && !seen.has(h.id) && seen.add(h.id));
}

export function PdfDoc({ url, highlights, active, zoom, fit, editable, jump, onPick, onCreate, findOutline, outlineTick, onOutline }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setSizes([]);
    const task = openPdf(url);
    task.promise
      .then(async (d) => {
        const s: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setSizes(s);
        setDoc(d);
      })
      .catch((e) => alive && setError(e?.message ?? String(e)));
    return () => {
      alive = false;
      task.destroy();
    };
  }, [url]);

  // Its headings, in the background once the first pages are up.
  useEffect(() => {
    if (!doc || !findOutline || !onOutline) return;
    let alive = true;
    const t = setTimeout(() => {
      import('./outline')
        .then((m) => m.pdfOutline(doc))
        .then((s) => alive && onOutline(s))
        .catch(() => alive && onOutline([]));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [doc, findOutline, outlineTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = box.current;
    const scroller = el?.closest('.r-doc');
    if (!el || !scroller) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(scroller.clientHeight);
    });
    ro.observe(el);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  // Scroll to a highlight picked in the side rail.
  useEffect(() => {
    if (!jump || !box.current) return;
    const h = highlights.find((x) => x.id === jump.id);
    const r = h?.rects?.[0];
    if (!r) return;
    const page = box.current.querySelector<HTMLElement>(`.pdf-page[data-page="${r.p}"]`);
    const scroller = box.current.closest('.r-doc');
    if (page && scroller) {
      const top = page.offsetTop + r.y * page.offsetHeight - scroller.clientHeight * 0.3;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  }, [jump, sizes]); // eslint-disable-line react-hooks/exhaustive-deps

  const aspect = sizes[0] ? sizes[0].w / sizes[0].h : 0.77;
  const fitted = fit === 'page' ? Math.min(width, height * aspect * 1.4) : Math.min(width - 48, 860);
  const pageWidth = Math.max(280, fitted * zoom);

  const byPage = useMemo(() => {
    const m = new Map<number, { h: Highlight; r: Rect }[]>();
    for (const h of highlights) for (const r of h.rects ?? []) m.set(r.p, [...(m.get(r.p) ?? []), { h, r }]);
    return m;
  }, [highlights]);

  // The selection, drawn as the bands it will be saved as (the browser's own,
  // over a scan's crooked text layer, is a jumble of overlapping boxes).
  const [live, setLive] = useState<Rect[]>([]);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sel = document.getSelection();
        const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (!range || !range.intersectsNode(root)) setLive((v) => (v.length ? [] : v));
        else setLive(selectionBoxes(range, root).rects);
      });
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onChange);
    };
  }, []);

  // Selecting by dragging is done here, not by the browser. A scan's text layer
  // is crooked (words a few pixels up or down, gaps between them, boxes over
  // the next line), and the browser's own selection drops or jumps to the end
  // of the page whenever the pointer is over a gap. Here the pointer always
  // takes the nearest word: in a margin, between words, between lines.
  useEffect(() => {
    const root = box.current;
    const scroller = root?.closest<HTMLElement>('.r-doc');
    if (!root || !scroller) return;
    const sel = () => window.getSelection()!;
    let drag: { anchor: Caret; x: number; y: number; moved: boolean } | null = null;
    let at = { x: 0, y: 0 };
    let raf = 0;
    const extend = () => {
      const c = drag && caretNear(root, at.x, at.y);
      if (drag && c) sel().setBaseAndExtent(drag.anchor.node, drag.anchor.offset, c.node, c.offset);
    };
    // Near the top or bottom edge, the page scrolls on under the pointer.
    const scroll = () => {
      raf = 0;
      if (!drag?.moved) return;
      const b = scroller.getBoundingClientRect();
      const v = at.y < b.top + 40 ? at.y - b.top - 40 : at.y > b.bottom - 40 ? at.y - b.bottom + 40 : 0;
      if (!v) return;
      scroller.scrollTop += Math.max(-40, Math.min(40, v * 0.5));
      extend();
      raf = requestAnimationFrame(scroll);
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      at = { x: e.clientX, y: e.clientY };
      if (!drag.moved && Math.hypot(at.x - drag.x, at.y - drag.y) < 3) return;
      drag.moved = true;
      extend();
      if (!raf) raf = requestAnimationFrame(scroll);
    };
    const onUp = () => {
      drag = null;
      cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp, true);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0 || !t.closest('.pdf-page') || t.closest('button, a, input, textarea')) return;
      const c = caretNear(root, e.clientX, e.clientY);
      if (!c) return;
      e.preventDefault();
      // Nothing gets focus from the click, so let go of a note being typed.
      (document.activeElement as HTMLElement | null)?.blur?.();
      const s = sel();
      if (e.detail === 2) return selectWord(s, c);
      if (e.detail >= 3) return selectLine(s, c);
      at = { x: e.clientX, y: e.clientY };
      if (e.shiftKey && s.anchorNode && root.contains(s.anchorNode)) {
        drag = { anchor: { node: s.anchorNode, offset: s.anchorOffset }, x: at.x, y: at.y, moved: true };
        extend();
      } else {
        s.removeAllRanges();
        drag = { anchor: c, x: at.x, y: at.y, moved: false };
      }
      window.addEventListener('mousemove', onMove);
      // Capturing, so it runs before the mouse-up below reads the selection.
      window.addEventListener('mouseup', onUp, true);
    };
    root.addEventListener('mousedown', onDown);
    return () => {
      onUp();
      root.removeEventListener('mousedown', onDown);
    };
  }, []);
  const liveByPage = useMemo(() => {
    const m = new Map<number, Rect[]>();
    for (const r of live) m.set(r.p, [...(m.get(r.p) ?? []), r]);
    return m;
  }, [live]);

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setPending(null);
        // A plain click: did it land on a highlight?
        const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page');
        if (!pageEl) return;
        const b = pageEl.getBoundingClientRect();
        const fx = (e.clientX - b.left) / b.width;
        const fy = (e.clientY - b.top) / b.height;
        const p = Number(pageEl.dataset.page);
        const hit = (byPage.get(p) ?? []).find(({ r }) => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h);
        onPick(hit ? hit.h.id : null, e.clientX, e.clientY);
        return;
      }
      if (!editable) return;
      const range = sel.getRangeAt(0);
      if (!box.current?.contains(range.commonAncestorContainer)) return;
      const text = rangeText(range);
      if (text.length < 2) return;
      const { rects, last } = selectionBoxes(range, box.current);
      if (!rects.length || !last) return;
      setPending({ text, rects, x: last.right + 8, y: last.bottom + 6 });
    },
    [byPage, editable, onPick],
  );

  const commit = useCallback(
    (mode: MarkMode) => {
      if (!pending) return;
      onCreate({ text: pending.text, rects: pending.rects }, mode, pending.x, pending.y);
      window.getSelection()?.removeAllRanges();
      setPending(null);
    },
    [pending, onCreate],
  );

  if (error) return <div className="doc-msg">Couldn't open this PDF. {error}</div>;

  return (
    <div className="pdf" ref={box} onMouseUp={onMouseUp}>
      {!doc && <div className="doc-msg">opening…</div>}
      {doc &&
        sizes.map((s, i) => (
          <div className="page-wrap" key={i}>
            <PdfPage
              doc={doc}
              index={i}
              width={pageWidth}
              base={s}
              marks={byPage.get(i) ?? []}
              selected={liveByPage.get(i)}
              active={active}
              onPick={onPick}
            />
            <div className="page-num">{i + 1}</div>
          </div>
        ))}
      {pending &&
        // Outside the pages: they carry the paper's colour filter, and in focus
        // mode the reader is the full-screen element, so it goes there.
        createPortal(
          <SelectionPop
            x={pending.x}
            y={pending.y}
            onPick={commit}
            onDismiss={() => setPending(null)}
          />,
          box.current?.closest('.reader') ?? document.body,
        )}
    </div>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  index: number;
  width: number;
  base: { w: number; h: number };
  marks: { h: Highlight; r: Rect }[];
  selected?: Rect[];
  active: string | null;
  onPick: Props['onPick'];
}

function PdfPage({ doc, index, width, base, marks, selected, active, onPick }: PageProps) {
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const scale = width / base.w;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: '1200px 0px' });
    io.observe(el.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let layer: { cancel: () => void } | null = null;
    // Re-render a moment after zoom settles, not on every step.
    const timer = setTimeout(async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled || !canvas.current || !text.current) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      const render = page.render({
        canvas: c,
        canvasContext: c.getContext('2d')!,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      task = render;
      text.current.replaceChildren();
      text.current.style.setProperty('--total-scale-factor', String(scale));
      const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport: vp });
      layer = tl;
      try {
        await Promise.all([render.promise, tl.render()]);
      } catch {
        // cancelled
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
      layer?.cancel();
    };
  }, [near, scale, doc, index]);

  return (
    <div className="pdf-page" data-page={index} ref={el} style={{ width, height: base.h * scale }}>
      <canvas ref={canvas} />
      {/* Questions get a layer of their own: red, where the rest invert the ink. */}
      {[false, true].map((q) => (
        <div key={String(q)} className={`hl-layer ${q ? 'hl-q' : ''}`}>
          {marks
            .map((m, k) => ({ ...m, k }))
            .filter(({ h }) => isQuestion(h) === q)
            .map(({ h, r, k }) => (
              <div
                key={`${h.id}-${k}`}
                className={`hl ${h.kind === 'note' ? 'note' : h.kind === 'definition' ? 'def' : h.kind === 'reference' ? 'cite' : ''} ${active === h.id ? 'on' : ''}`}
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
              />
            ))}
        </div>
      ))}
      {selected && (
        <div className="sel-layer">
          {selected.map((r, k) => (
            <div key={k} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
          ))}
        </div>
      )}
      <div className="textLayer" ref={text} />
      <div className="margin-notes">
        {firstOnPage(marks).map(({ h, r }) => (
          <button
            key={h.id}
            className={`mnote ${active === h.id ? 'on' : ''} ${isQuestion(h) ? 'q' : ''}`}
            style={{ top: `${(r.y + r.h / 2) * 100}%` }}
            title={h.note}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => onPick(h.id, e.clientX, e.clientY)}
            aria-label="Open note"
          />
        ))}
      </div>
    </div>
  );
}
