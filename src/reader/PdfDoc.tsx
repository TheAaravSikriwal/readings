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

/** Selected text, with a space wherever pdf.js marked a line end. */
function rangeText(range: Range) {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n as Text).data;
    else if ((n as Element).tagName === 'BR') out += ' ';
    else n.childNodes.forEach(walk);
  };
  range.cloneContents().childNodes.forEach(walk);
  return out.replace(/\s+/g, ' ').trim();
}

/** Joins the per-span boxes a selection produces into one box per line. */
function mergeRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && last.p === r.p && Math.abs(last.y - r.y) < Math.min(last.h, r.h) * 0.6 && r.x <= last.x + last.w + 0.012) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const top = Math.min(last.y, r.y);
      last.h = Math.max(last.y + last.h, r.y + r.h) - top;
      last.y = top;
      last.w = right - last.x;
    } else out.push({ ...r });
  }
  return out;
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
      const pages = [...box.current.querySelectorAll<HTMLElement>('.pdf-page')].map((el) => ({
        el,
        b: el.getBoundingClientRect(),
      }));
      const rects: Rect[] = [];
      let last: DOMRect | null = null;
      for (const cr of range.getClientRects()) {
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
      if (!rects.length || !last) return;
      setPending({ text, rects: mergeRects(rects), x: last.right + 8, y: last.bottom + 6 });
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
  active: string | null;
  onPick: Props['onPick'];
}

function PdfPage({ doc, index, width, base, marks, active, onPick }: PageProps) {
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
        const end = document.createElement('div');
        end.className = 'endOfContent';
        text.current?.append(end);
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
      <div
        className="textLayer"
        ref={text}
        onMouseDown={() => text.current?.classList.add('selecting')}
        onMouseUp={() => text.current?.classList.remove('selecting')}
      />
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
