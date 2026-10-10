import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fileUrl } from '../api';
import { attachPdf, fetchInto } from '../importer';
import {
  articleMarkdown,
  citeLink,
  cleanCite,
  download,
  exportName,
  glossary,
  hasNote,
  isDefinition,
  isQuestion,
  isReference,
  readingOrder,
  referenceList,
  scholarUrl,
  sectionIndex,
  sortNotes,
} from '../notes';
import { htmlOutline, OUTLINE_V } from './outline';
import type { MarkMode } from './SelectionPop';
import { actions, EDITABLE, useStore } from '../store';
import type { Bookmark, Highlight, Section } from '../types';
import { BookmarkPop, bookmarkPlace } from './BookmarkPop';
import { Edit } from '../ui/Edit';
import { HtmlDoc } from './HtmlDoc';
import { NotePop } from './NotePop';
import { PdfDoc } from './PdfDoc';

const pref = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode
    }
  },
};

/** The page colour: white, warm (a cream page, brown ink, the room around it
 * warmed too) or dark. */
type Paper = 'white' | 'warm' | 'dark';
const PAPERS: Paper[] = ['white', 'warm', 'dark'];
const savedPaper = (): Paper => {
  const p = pref.get('paper');
  if (p === 'white' || p === 'warm' || p === 'dark') return p;
  return pref.get('invert') === '1' ? 'dark' : 'white';
};

/** Headings in document order. */
const ordered = (ss: Section[]) =>
  [...ss].sort(
    (x, y) => (x.p ?? 0) - (y.p ?? 0) || (x.c ?? 0) - (y.c ?? 0) || (x.y ?? 0) - (y.y ?? 0) || (x.at ?? 0) - (y.at ?? 0),
  );

/** Whether a heading comes at or before a place in the document. */
const before = (s: Section, spot: Pick<Section, 'p' | 'y' | 'at' | 'c'>) =>
  s.p !== undefined && spot.p !== undefined
    ? s.p < spot.p ||
      (s.p === spot.p && ((s.c ?? 0) < (spot.c ?? 0) || ((s.c ?? 0) === (spot.c ?? 0) && (s.y ?? 0) <= (spot.y ?? 0))))
    : (s.at ?? 0) <= (spot.at ?? 0);

/** How far down a web page a character is, in px from the page's top. */
function textTop(root: HTMLElement, at: number) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = (n as Text).data.length;
    if (pos + len > at) {
      const r = document.createRange();
      r.setStart(n, at - pos);
      r.setEnd(n, Math.min(len, at - pos + 1));
      return r.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }
    pos += len;
  }
  return null;
}

/** A zoom kept from last time (the normal view's, or focus mode's). */
const savedZoom = (key: string) => {
  const z = Number(pref.get(key));
  return z >= 0.5 && z <= 3 ? z : 1;
};

/** Overlap kept between "pages" of a web article, so you don't lose your line. */
const WEB_OVERLAP = 56;

/** Reading view: the document like a book (page by page), your notes beside it. */
/** A term reads as a term when it is a handful of words; a longer selection is
 * taken to be the definition, and the term is asked for. */
const looksLikeTerm = (s: string) => s.trim().split(/\s+/).length <= 6;

interface ReaderProps {
  id: string;
  onClose: () => void;
  /** A highlight to scroll to once the document is open (from the glossary). */
  focusHighlight?: string | null;
  /** Start a new reading from one of this reading's references. */
  onAddReference?: (articleId: string, highlightId: string) => void;
  /** Open another reading (a reference that is already on the map). */
  onOpenReading?: (id: string) => void;
  /** A bookmark to go to once the document is open (from the pins on the map). */
  focusBookmark?: string | null;
}

/** Where a bookmark sits: the line you're on, a little below the top of the view. */
const READING_LINE = 0.18;

/** Which side-panel sections are folded away, remembered between readings. */
type Fold = { terms?: boolean; refs?: boolean; marks?: boolean; summary?: boolean; notes?: boolean };
const savedFold = (): Fold => {
  try {
    return JSON.parse(pref.get('rail-fold') ?? '{}') ?? {};
  } catch {
    return {};
  }
};

export default function Reader({ id, onClose, focusHighlight, onAddReference, onOpenReading, focusBookmark }: ReaderProps) {
  const { tree, lib, pending } = useStore();
  const a = tree.article(id);
  const [active, setActive] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [pop, setPop] = useState<{ id: string; x: number; y: number } | null>(null);
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  const [zoom, setZoom] = useState(() => savedZoom('zoom'));
  const [paper, setPaper] = useState<Paper>(savedPaper);
  const [idle, setIdle] = useState(false);
  const [focus, setFocus] = useState(false);
  const [page, setPage] = useState({ n: 1, total: 1 });
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const highlights = a?.highlights ?? [];
  const sorted = useMemo(() => sortNotes(highlights.filter((h) => !isDefinition(h) && !isReference(h))), [highlights]);
  const terms = useMemo(() => (a ? glossary(lib, a.id) : []), [lib, a, highlights]); // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useMemo(() => (a ? referenceList(lib, a.id) : []), [lib, a, highlights]); // eslint-disable-line react-hooks/exhaustive-deps
  /** This reading's references in the order the paper cites them. */
  const refsInOrder = useMemo(() => {
    const at = new Map(highlights.map((h) => [h.id, readingOrder(h)]));
    return [...refs].sort((x, y) => (at.get(x.sources[0].highlightId) ?? 0) - (at.get(y.sources[0].highlightId) ?? 0));
  }, [refs, highlights]);
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const bookmarks = useMemo(() => a?.bookmarks ?? [], [a?.bookmarks]);
  const [bmPop, setBmPop] = useState<{ id: string; x: number; y: number } | null>(null);
  const [spots, setSpots] = useState<Record<string, { top: number; left: number; width: number }>>({});
  const [layoutTick, setLayoutTick] = useState(0);
  const [fold, setFold] = useState<Fold>(savedFold);
  // Notes show as short previews; the one you're on opens in full. Or all of them, if you'd rather.
  const [allOpen, setAllOpen] = useState(() => pref.get('notes-open') === '1');
  const toggleFold = (k: keyof Fold) =>
    setFold((f) => {
      const next = { ...f, [k]: !f[k] };
      pref.set('rail-fold', JSON.stringify(next));
      return next;
    });

  // Opened from the glossary: go to that definition.
  useEffect(() => {
    if (!focusHighlight) return;
    setActive(focusHighlight);
    setJump({ id: focusHighlight, n: Date.now() });
  }, [focusHighlight]);
  const kind = a?.file?.endsWith('.pdf') ? 'pdf' : a?.file?.endsWith('.html') ? 'html' : null;

  // ---- headings: a contents list to move around by, and folders for the notes

  const stored = a?.outline && (a.outline.edited || a.outline.v === OUTLINE_V) ? a.outline.sections : null;
  const [findTick, setFindTick] = useState(0);
  const [found, setFound] = useState<Section[] | null>(null);
  const sections = useMemo(() => stored ?? found ?? [], [stored, found]);
  const outlineKnown = !!stored || found !== null;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const onOutline = useCallback(
    (s: Section[]) => {
      setFound(s);
      if (EDITABLE && JSON.stringify(storedRef.current) !== JSON.stringify(s)) actions.setOutline(id, { v: OUTLINE_V, sections: s });
    },
    [id],
  );
  // ---- your own headings: rename, re-level, remove, add, clear, or find them again

  const editSections = useCallback((next: Section[]) => actions.editOutline(id, { v: OUTLINE_V, sections: ordered(next) }), [id]);

  /** A new heading at a place in the document, at the level of the one above it. Returns where it landed. */
  const addHeading = (spot: Pick<Section, 'p' | 'y' | 'at' | 'c'>, title: string) => {
    const above = sections.filter((x) => before(x, spot)).at(-1);
    const s: Section = { title, level: above?.level ?? 1, ...spot };
    const next = ordered([...sections, s]);
    actions.editOutline(id, { v: OUTLINE_V, sections: next });
    return next.indexOf(s);
  };

  /** The line you're reading, as a place in the document. */
  const readingSpot = (): Pick<Section, 'p' | 'y' | 'at'> | null => {
    const el = scroller.current;
    if (!el) return null;
    const line = el.scrollTop + el.clientHeight * 0.18;
    if (kind === 'pdf') {
      const pg = [...el.querySelectorAll<HTMLElement>('.pdf-page')].find((x) => x.offsetTop + x.offsetHeight > line);
      if (!pg) return null;
      return { p: Number(pg.dataset.page), y: Math.max(0, Math.min(1, (line - pg.offsetTop) / pg.offsetHeight)) };
    }
    const snap = el.querySelector<HTMLElement>('.snapshot');
    if (!snap) return null;
    const x = snap.getBoundingClientRect().left + 40;
    const y = el.getBoundingClientRect().top + el.clientHeight * 0.18;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const r = doc.caretRangeFromPoint?.(x, y);
    const pos = r ? { node: r.startContainer, offset: r.startOffset } : (() => {
      const c = doc.caretPositionFromPoint?.(x, y);
      return c ? { node: c.offsetNode, offset: c.offset } : null;
    })();
    if (!pos || !snap.contains(pos.node)) return { at: 0 };
    const pre = document.createRange();
    pre.setStart(snap, 0);
    pre.setEnd(pos.node, pos.offset);
    return { at: pre.toString().length };
  };

  const redetect = () => {
    actions.update(id, { outline: undefined });
    setFound(null);
    const snap = scroller.current?.querySelector<HTMLElement>('.snapshot');
    if (kind === 'html' && snap) onOutline(htmlOutline(snap));
    else setFindTick((t) => t + 1);
  };

  const [tocOpen, setTocOpen] = useState(() => pref.get('toc') === '1');
  const toggleToc = useCallback(
    () =>
      setTocOpen((o) => {
        pref.set('toc', o ? '0' : '1');
        return !o;
      }),
    [],
  );
  const [cur, setCur] = useState(-1);
  /** Folded section folders in the side panel: `n3` (notes) or `r3` (references). */
  const [shutSecs, setShutSecs] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(pref.get(`secs:${id}`) ?? '[]'));
    } catch {
      return new Set();
    }
  });
  const toggleSec = (key: string) =>
    setShutSecs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      pref.set(`secs:${id}`, JSON.stringify([...next]));
      return next;
    });
  const secOf = useMemo(() => new Map(highlights.map((h) => [h.id, sectionIndex(h, sections)])), [highlights, sections]);
  const secCounts = useMemo(() => {
    const c = sections.map(() => 0);
    for (const k of secOf.values()) if (k !== null && k >= 0) c[k]++;
    return c;
  }, [secOf, sections]);
  const popped = pop ? highlights.find((h) => h.id === pop.id) : undefined;

  // ---- pages: real PDF pages, or screen-sized pages of a web article

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let timer = 0;
    const update = () => {
      const pages = el.querySelectorAll<HTMLElement>('.pdf-page');
      let next: { n: number; total: number };
      if (pages.length) {
        const mid = el.scrollTop + el.clientHeight * 0.4;
        let n = 1;
        pages.forEach((p, i) => p.offsetTop <= mid && (n = i + 1));
        next = { n, total: pages.length };
      } else {
        const step = Math.max(200, el.clientHeight - WEB_OVERLAP);
        const total = Math.max(1, Math.ceil((el.scrollHeight - WEB_OVERLAP) / step));
        const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        next = { n: atEnd ? total : Math.min(total, Math.round(el.scrollTop / step) + 1), total };
      }
      setPage((p) => (p.n === next.n && p.total === next.total ? p : next));
    };
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        update();
        setLayoutTick((t) => t + 1);
      }, 120);
    };
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(later);
    ro.observe(el);
    const mo = new MutationObserver(later);
    mo.observe(el, { childList: true, subtree: true });
    update();
    return () => {
      clearTimeout(timer);
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [kind]);

  // Pressing next twice quickly should move two pages, even mid-scroll.
  const aim = useRef({ n: 1, t: 0 });
  const current = () => (performance.now() - aim.current.t < 700 ? aim.current.n : page.n);

  const goTo = useCallback(
    (n: number) => {
      const el = scroller.current;
      if (!el) return;
      const pages = el.querySelectorAll<HTMLElement>('.pdf-page');
      const target = Math.max(1, Math.min(page.total, n));
      aim.current = { n: target, t: performance.now() };
      if (pages.length) {
        const p = pages[target - 1];
        const top = focus ? p.offsetTop - (el.clientHeight - p.offsetHeight) / 2 : p.offsetTop - 20;
        el.scrollTo({ top, behavior: 'smooth' });
      } else {
        el.scrollTo({ top: (target - 1) * Math.max(200, el.clientHeight - WEB_OVERLAP), behavior: 'smooth' });
      }
    },
    [page.total, focus],
  );

  // ---- focus mode: full screen, nothing but the text

  const toggleFocus = useCallback(async () => {
    (document.activeElement as HTMLElement | null)?.blur(); // so the header can slide away
    if (!focus) {
      setFocus(true);
      await root.current?.requestFullscreen?.().catch(() => {});
    } else {
      setFocus(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    }
  }, [focus]);

  // ---- zoom: focus mode and the normal view each keep their own, between visits too

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const otherZoom = useRef(savedZoom('zoom-focus'));
  const firstFocus = useRef(true);
  useEffect(() => {
    if (firstFocus.current) return void (firstFocus.current = false);
    // Into focus mode: its own zoom. Out again: the zoom you had before.
    const was = zoomRef.current;
    setZoom(otherZoom.current);
    otherZoom.current = was;
  }, [focus]);

  /** Where to hold still while zooming: the point under the pointer, or the middle of the view. */
  const zoomAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const zoomTo = useCallback((z: number, at?: { x: number; y: number }) => {
    const next = Math.round(Math.min(3, Math.max(0.5, z)) * 100) / 100;
    if (next === zoomRef.current) return;
    const sc = scroller.current;
    if (sc) {
      const r = sc.getBoundingClientRect();
      const px = (at?.x ?? r.left + r.width / 2) - r.left;
      const py = (at?.y ?? r.top + r.height * 0.4) - r.top;
      zoomAnchor.current = {
        fx: (sc.scrollLeft + px) / Math.max(1, sc.scrollWidth),
        fy: (sc.scrollTop + py) / Math.max(1, sc.scrollHeight),
        px,
        py,
      };
    }
    setZoom(next);
    pref.set(focusRef.current ? 'zoom-focus' : 'zoom', String(next));
  }, []);
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const sc = scroller.current;
    zoomAnchor.current = null;
    if (!a || !sc) return;
    sc.scrollTop = a.fy * sc.scrollHeight - a.py;
    sc.scrollLeft = a.fx * sc.scrollWidth - a.px;
  }, [zoom]);

  // Ctrl + scroll (or a trackpad pinch) zooms the page, not the whole browser.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!kind) return;
      const over = scroller.current?.contains(e.target as Node);
      const step = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0018;
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * step), over ? { x: e.clientX, y: e.clientY } : undefined);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [kind, zoomTo]);

  useEffect(() => {
    const onFs = () => !document.fullscreenElement && setFocus(false);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Keep your place when the page size changes (focus on/off, zoom).
  const keepPage = useRef(page.n);
  keepPage.current = page.n;
  useEffect(() => {
    const n = keepPage.current;
    const t = setTimeout(() => goTo(n), 120);
    return () => clearTimeout(t);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- bookmarks: a red ribbon on the page, as many as you like

  /** The page (or article) a bookmark sits in, as laid out right now. */
  const boxOf = useCallback((b: { p?: number }) => {
    const el = scroller.current;
    if (!el) return null;
    const box =
      b.p !== undefined ? el.querySelector<HTMLElement>(`.pdf-page[data-page="${b.p}"]`) : el.querySelector<HTMLElement>('.snapshot');
    return box && box.offsetHeight ? box : null;
  }, []);

  useLayoutEffect(() => {
    const next: typeof spots = {};
    for (const b of bookmarks) {
      const box = boxOf(b);
      if (box) next[b.id] = { top: box.offsetTop + b.y * box.offsetHeight, left: box.offsetLeft, width: box.offsetWidth };
    }
    setSpots(next);
  }, [bookmarks, layoutTick, zoom, focus, kind, boxOf]);

  const goToBookmark = useCallback(
    (b: Bookmark, behavior: ScrollBehavior = 'smooth') => {
      const el = scroller.current;
      const box = boxOf(b);
      if (!el || !box) return false;
      el.scrollTo({ top: box.offsetTop + b.y * box.offsetHeight - el.clientHeight * READING_LINE, behavior });
      return true;
    },
    [boxOf],
  );

  /** B: leave a bookmark on the line you're reading, ready to label. */
  const placeBookmark = useCallback(() => {
    const el = scroller.current;
    if (!el || !kind || !EDITABLE) return;
    const line = el.scrollTop + el.clientHeight * READING_LINE;
    const box =
      kind === 'pdf'
        ? [...el.querySelectorAll<HTMLElement>('.pdf-page')].find((pg) => pg.offsetTop + pg.offsetHeight > line) ?? null
        : el.querySelector<HTMLElement>('.snapshot');
    if (!box || !box.offsetHeight) return;
    const p = kind === 'pdf' ? Number(box.dataset.page) : undefined;
    const y = Math.max(0, Math.min(1, (line - box.offsetTop) / box.offsetHeight));
    // Pressing B on a line that already has one opens that one.
    const near = bookmarks.find((b) => b.p === p && Math.abs(b.y - y) < 0.03);
    const bid = near?.id ?? actions.addBookmark(id, { p, y });
    const r = el.getBoundingClientRect();
    setBmPop({
      id: bid,
      x: r.left + box.offsetLeft + box.offsetWidth - el.scrollLeft,
      y: r.top + box.offsetTop + y * box.offsetHeight - el.scrollTop,
    });
  }, [kind, bookmarks, id]);

  /** Each heading's position in the scrolling document, in px (null: not laid out). */
  const sectionTops = useCallback(() => {
    const el = scroller.current;
    if (!el) return sections.map(() => null);
    const pages = new Map<number, HTMLElement>();
    el.querySelectorAll<HTMLElement>('.pdf-page').forEach((pg) => pages.set(Number(pg.dataset.page), pg));
    const snap = el.querySelector<HTMLElement>('.snapshot');
    const heads = snap ? [...snap.querySelectorAll<HTMLElement>('h1, h2, h3, h4')] : [];
    return sections.map((s) => {
      if (s.p !== undefined) {
        const pg = pages.get(s.p);
        return pg && pg.offsetHeight ? pg.offsetTop + (s.y ?? 0) * pg.offsetHeight : null;
      }
      if (s.i !== undefined) {
        const h = heads[s.i];
        return snap && h ? snap.offsetTop + h.offsetTop : null;
      }
      // A heading you added to a web page: where its text is.
      const t = snap && s.at !== undefined ? textTop(snap, s.at) : null;
      return snap && t !== null ? snap.offsetTop + t : null;
    });
  }, [sections]);

  const goToSection = useCallback(
    (i: number) => {
      const el = scroller.current;
      const top = sectionTops()[i];
      if (el && top !== null && top !== undefined) el.scrollTo({ top: Math.max(0, top - el.clientHeight * 0.08), behavior: 'smooth' });
    },
    [sectionTops],
  );

  // Which section you're reading.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !sections.length) return setCur(-1);
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = el.scrollTop + el.clientHeight * 0.2;
      let k = -1;
      sectionTops().forEach((t, i) => t !== null && t <= line && (k = i));
      setCur(k);
    };
    const later = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', later, { passive: true });
    update();
    return () => {
      el.removeEventListener('scroll', later);
      cancelAnimationFrame(raf);
    };
  }, [sections, sectionTops, layoutTick]);

  /** [ and ]: the previous or next heading. */
  const stepSection = (dir: 1 | -1) => {
    if (!sections.length) return;
    const el = scroller.current;
    const tops = sectionTops();
    const here = cur >= 0 ? tops[cur] : null;
    // Partway into a section, [ goes back to its start first.
    const inside = el && here !== null && el.scrollTop - (here - el.clientHeight * 0.08) > 40;
    const target = dir > 0 ? cur + 1 : inside ? cur : cur - 1;
    if (target >= 0 && target < sections.length) goToSection(target);
  };

  // Opened from a pin on the map: go to that bookmark once the pages are laid out.
  useEffect(() => {
    if (!focusBookmark) return;
    const b = bookmarks.find((x) => x.id === focusBookmark);
    if (!b) return;
    let tries = 0;
    let t = 0;
    const go = () => {
      const el = scroller.current;
      const ready = !!el && (kind === 'pdf' ? !!el.querySelector('.pdf-page canvas') : !!el.querySelector('.snapshot')?.textContent);
      if (ready && goToBookmark(b, 'auto')) {
        // Once more after the page has settled (fonts, late images, the first page jump).
        t = window.setTimeout(() => goToBookmark(b, 'auto'), 450);
        return;
      }
      if (++tries < 60) t = window.setTimeout(go, 100);
    };
    go();
    return () => clearTimeout(t);
  }, [focusBookmark]); // eslint-disable-line react-hooks/exhaustive-deps

  const marksInOrder = useMemo(() => [...bookmarks].sort((x, y) => (x.p ?? 0) - (y.p ?? 0) || x.y - y.y), [bookmarks]);
  const bmPopped = bmPop ? bookmarks.find((b) => b.id === bmPop.id) : undefined;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      // With Ctrl (or Cmd) only the zoom keys are ours; Ctrl+F, Ctrl+W and the rest stay the browser's.
      if ((e.ctrlKey || e.metaKey) && !['=', '+', '-', '_', '0'].includes(e.key)) return;
      if (e.key === 'Escape') return focus ? toggleFocus() : onClose();
      if (e.key === 'ArrowRight' || e.key === 'PageDown') (e.preventDefault(), goTo(current() + 1));
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') (e.preventDefault(), goTo(current() - 1));
      if (e.key === 'f' || e.key === 'F') toggleFocus();
      if (e.key === 'w' || e.key === 'W') cyclePaper();
      if (e.key === 'o' || e.key === 'O') toggleToc();
      if (e.key === ']') (e.preventDefault(), stepSection(1));
      if (e.key === '[') (e.preventDefault(), stepSection(-1));
      if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); // or the b lands in the label box that opens
        placeBookmark();
      }
      // + and - zoom the page; with Ctrl too, instead of the browser. Ctrl+0 back to 100%.
      if (kind && (e.key === '=' || e.key === '+')) (e.preventDefault(), zoomTo(zoomRef.current + 0.15));
      if (kind && (e.key === '-' || e.key === '_')) (e.preventDefault(), zoomTo(zoomRef.current - 0.15));
      if (kind && e.key === '0' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), zoomTo(1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, kind, goTo, page.n, focus, toggleFocus, placeBookmark, sections, cur]); // eslint-disable-line react-hooks/exhaustive-deps

  // In focus mode the page counter and the pointer get out of the way when
  // nothing is moving.
  useEffect(() => {
    if (!focus) return setIdle(false);
    let t = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), 1600);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [focus]);

  // Clicking a highlight in the document brings its card in the side rail into view.
  useEffect(() => {
    if (active) rail.current?.querySelector(`[data-h="${active}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [active]);

  const create = useCallback(
    (h: Omit<Highlight, 'id' | 'created' | 'note'>, mode: MarkMode, x: number, y: number) => {
      if (mode === 'heading') {
        const r = h.rects?.[0];
        // On a two-column page, the heading knows its column.
        const twoCol = !!r && sections.some((s) => s.p === r.p && s.c !== undefined);
        addHeading(r ? { p: r.p, y: r.y, ...(twoCol ? { c: r.x >= 0.45 ? 1 : 0 } : {}) } : { at: h.start ?? 0 }, h.text.slice(0, 140));
        setTocOpen(true);
        pref.set('toc', '1');
        actions.toast(`“${h.text.length > 60 ? `${h.text.slice(0, 60)}…` : h.text}” is in the contents now`);
        return;
      }
      const short = looksLikeTerm(h.text);
      const hid = actions.addHighlight(
        id,
        mode === 'note'
          ? { ...h, kind: 'note' }
          : mode === 'definition'
            ? { ...h, kind: 'definition', term: short ? h.text : '', note: short ? '' : h.text }
            : mode === 'reference'
              ? { ...h, kind: 'reference', cite: cleanCite(h.text) }
              : h,
      );
      setActive(hid);
      // Every kind opens its box ready to type: a highlight's note is optional,
      // and Enter (or Esc) finishes, so the hands can stay on the keyboard.
      setPop({ id: hid, x, y });
    },
    [id, sections], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const pick = useCallback((hid: string | null, x: number, y: number) => {
    setActive(hid);
    setPop(hid ? { id: hid, x, y } : null);
  }, []);

  const closePop = useCallback(() => {
    // A note you opened and left empty goes away. A definition with no term
    // keeps the passage as a plain highlight rather than losing it.
    if (popped?.kind === 'note' && !popped.note.trim()) actions.removeHighlight(id, popped.id);
    if (popped?.kind === 'definition' && !popped.term?.trim()) {
      actions.updateHighlight(id, popped.id, { kind: undefined, term: undefined });
      if (popped.note.trim() === popped.text.trim()) actions.updateHighlight(id, popped.id, { note: '' });
    }
    // Likewise a reference that never said what it cites.
    if (popped?.kind === 'reference' && !popped.cite?.trim())
      actions.updateHighlight(id, popped.id, { kind: undefined, cite: undefined });
    setPop(null);
  }, [popped, id]);

  const addGeneralNote = () => {
    const hid = actions.addHighlight(id, { text: '' });
    setFresh(hid);
    setActive(hid);
  };

  function cyclePaper() {
    setPaper((p) => {
      const next = PAPERS[(PAPERS.indexOf(p) + 1) % PAPERS.length];
      pref.set('paper', next);
      return next;
    });
  }

  if (!a) return null;

  /** Items sorted into folders by the heading they sit under (nothing to sort without headings). */
  const foldered = <T,>(items: T[], key: string, sec: (t: T) => number | null | undefined, render: (t: T) => ReactNode) => {
    if (!sections.length) return items.map(render);
    const n = sections.length;
    const by = new Map<number, T[]>();
    const loose: T[] = [];
    for (const t of items) {
      const k = sec(t);
      if (k === null || k === undefined || k < 0) loose.push(t);
      else by.set(k, [...(by.get(k) ?? []), t]);
    }
    const endOf = (i: number) => {
      let j = i + 1;
      while (j < n && sections[j].level > sections[i].level) j++;
      return j;
    };
    const total = sections.map((_, i) => {
      let c = 0;
      for (let j = i; j < endOf(i); j++) c += by.get(j)?.length ?? 0;
      return c;
    });
    const out: ReactNode[] = loose.map(render);
    let hideUntil = -1;
    for (let i = 0; i < n; i++) {
      // Every heading is a folder, empty or not: a way to get there, and a place for what you mark in it.
      if (i < hideUntil) continue;
      const k = `${key}${i}`;
      const shut = shutSecs.has(k);
      const lvl = sections[i].level;
      const holds = total[i] > 0 || endOf(i) > i + 1;
      out.push(
        <div key={`sec-${k}`} className={`sec-row lvl-${lvl} ${cur === i ? 'here' : ''} ${total[i] ? '' : 'sec-empty'}`}>
          {holds ? (
            <button className={`ly-caret ${shut ? 'closed' : ''}`} onClick={() => toggleSec(k)} aria-label={shut ? 'Open' : 'Close'} />
          ) : (
            <span className="ly-caret-space" />
          )}
          <button className="sec-title" onClick={() => goToSection(i)} title="Go to this heading">
            {sections[i].title}
          </button>
          {total[i] > 0 && <span className="sec-count">{total[i]}</span>}
        </div>,
      );
      if (shut) {
        hideUntil = endOf(i);
        continue;
      }
      const mine = by.get(i);
      if (mine?.length)
        out.push(
          <div key={`items-${k}`} className={`sec-items lvl-${lvl}`}>
            {mine.map(render)}
          </div>,
        );
    }
    return out;
  };
  const busy = pending.has(id);
  const notesOnly = !kind && !EDITABLE;

  // Focus mode: click the empty space left or right of the page to turn it.
  const turn = (e: React.MouseEvent) => {
    if (!focus) return;
    const t = e.target as HTMLElement;
    if (!(t === scroller.current || t.classList.contains('pdf') || t.classList.contains('page-wrap'))) return;
    goTo(current() + (e.clientX > window.innerWidth / 2 ? 1 : -1));
  };

  return (
    <div
      ref={root}
      className={`reader paper-${paper} kind-${kind ?? 'none'} ${notesOnly ? 'notes-view' : ''} ${focus ? 'focus' : ''} ${idle ? 'idle' : ''}`}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {focus && <div className="r-peek" />}
      <header className="r-head">
        <button className="ghost" onClick={focus ? toggleFocus : onClose}>
          {focus ? '← exit focus' : '← map'}
        </button>
        <div className="r-title">
          <span>{a.title}</span>
          <span className="faint">{[a.authors, a.year].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="r-tools">
          {kind && (
            <span className="pager">
              <button className="ghost" onClick={() => goTo(current() - 1)} disabled={page.n <= 1} aria-label="Previous page">
                ‹
              </button>
              <span className="mono">
                {page.n} <span className="faint">/ {page.total}</span>
              </span>
              <button className="ghost" onClick={() => goTo(current() + 1)} disabled={page.n >= page.total} aria-label="Next page">
                ›
              </button>
            </span>
          )}
          {kind && (
            <>
              <span className="tool-sep" />
              <button className="ghost" onClick={() => zoomTo(zoom - 0.15)} aria-label="Zoom out" title="Zoom out (−, or Ctrl + scroll)">
                −
              </button>
              <button className="ghost mono zoom-pct" onClick={() => zoomTo(1)} title="Back to 100% (Ctrl+0)">
                {Math.round(zoom * 100)}%
              </button>
              <button className="ghost" onClick={() => zoomTo(zoom + 0.15)} aria-label="Zoom in" title="Zoom in (+, or Ctrl + scroll)">
                +
              </button>
            </>
          )}
          {kind && (
            <>
              <span className="tool-sep" />
              <button
                className={`ghost ${tocOpen ? 'on' : ''}`}
                onClick={toggleToc}
                title="The headings in this document (O). [ and ] jump between them."
              >
                contents
              </button>
            </>
          )}
          {kind && EDITABLE && (
            <>
              <span className="tool-sep" />
              <button className="ghost bm-btn" onClick={placeBookmark} title="Bookmark the line you're on (B)">
                <span className="bm-glyph" />
                bookmark
              </button>
            </>
          )}
          {kind && (
            <>
              <span className="tool-sep" />
              <button className="ghost paper-btn" onClick={cyclePaper} title="Page colour: white, warm or dark (W)">
                <span className={`paper-dot ${paper}`} />
                {paper}
              </button>
            </>
          )}
          {kind && (
            <button className={`ghost ${focus ? 'on' : ''}`} onClick={toggleFocus} title="Full screen, just the text (F)">
              focus
            </button>
          )}
          {(EDITABLE || a.done) && (
            <button
              className={`ghost done-btn ${a.done ? 'on' : ''}`}
              disabled={!EDITABLE}
              onClick={() => {
                actions.update(id, { done: a.done ? undefined : new Date().toISOString() });
                if (!a.done) actions.toast('Checked off: read and annotated.');
              }}
              title={a.done ? `Completed ${new Date(a.done).toLocaleDateString()}. Click to undo.` : 'Check it off when you’ve read and annotated it'}
            >
              <span className="done-box" />
              {a.done ? 'completed' : 'complete'}
            </button>
          )}
          {EDITABLE && (
            <button
              className="ghost"
              onClick={() => download(exportName(a.title, 'md'), articleMarkdown(a, tree, lib, 1) + '\n')}
              title="Download this article's summary and notes as Markdown"
            >
              export
            </button>
          )}
          {a.url && (
            <a className="ghost" href={a.url} target="_blank" rel="noreferrer">
              source ↗
            </a>
          )}
        </div>
      </header>

      <div className={`r-body ${notesOnly ? 'notes-only' : ''} ${tocOpen && kind && !focus ? 'with-toc' : ''}`}>
        {tocOpen && kind && !focus && (
          <Contents
            sections={sections}
            known={outlineKnown}
            edited={!!a.outline?.edited}
            cur={cur}
            counts={secCounts}
            onGo={goToSection}
            onClose={toggleToc}
            onEdit={editSections}
            onAdd={() => {
              const spot = readingSpot();
              return spot ? addHeading(spot, 'New heading') : -1;
            }}
            onRedetect={redetect}
            onClear={() => editSections([])}
          />
        )}
        {!notesOnly && (
          <main className="r-doc" ref={scroller} onClick={turn} style={{ '--doc-zoom': zoom } as React.CSSProperties}>
            {marksInOrder.length > 0 && (
              <div className="bm-layer">
                {marksInOrder.map((b) => {
                  const s = spots[b.id];
                  if (!s) return null;
                  return (
                    <Fragment key={b.id}>
                      <div className="bm-line" style={{ top: s.top, left: s.left, width: s.width }} />
                      <button
                        className={`bm ${bmPop?.id === b.id ? 'on' : ''}`}
                        style={{ top: s.top - 6, left: s.left + s.width - 7 }}
                        title={b.label || 'Bookmark'}
                        aria-label={`Bookmark${b.label ? `: ${b.label}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setBmPop({ id: b.id, x: e.clientX, y: e.clientY });
                        }}
                      />
                    </Fragment>
                  );
                })}
              </div>
            )}
            {kind === 'pdf' && (
              <PdfDoc
                url={fileUrl(a.file!)}
                highlights={highlights}
                active={active}
                zoom={zoom}
                fit={focus ? 'page' : 'width'}
                editable={EDITABLE}
                jump={jump}
                onPick={pick}
                onCreate={create}
                findOutline={!stored}
                outlineTick={findTick}
                onOutline={onOutline}
              />
            )}
            {kind === 'html' && (
              <HtmlDoc
                url={fileUrl(a.file!)}
                highlights={highlights}
                active={active}
                editable={EDITABLE}
                jump={jump}
                onPick={pick}
                onCreate={create}
                onOutline={onOutline}
              />
            )}
            {!kind && (
              <div className="nofile">
                <p>{busy ? 'Fetching…' : 'No document attached yet.'}</p>
                {EDITABLE && !busy && (
                  <div className="row">
                    <button className="pill solid" onClick={() => picker.current?.click()}>
                      attach a PDF
                    </button>
                    {a.url && (
                      <button className="pill" onClick={() => fetchInto(id, a.url!)}>
                        grab it from the link
                      </button>
                    )}
                  </div>
                )}
                {EDITABLE && <p className="faint">You can also drop a PDF anywhere on this screen, or just write notes on the right.</p>}
                <input
                  ref={picker}
                  type="file"
                  accept="application/pdf"
                  hidden
                  onChange={(e) => e.target.files?.[0] && attachPdf(id, e.target.files[0])}
                />
              </div>
            )}
          </main>
        )}

        <aside className="r-rail" ref={rail}>
          {notesOnly && (
            <div className="r-hero">
              <h1>{a.title}</h1>
              <p className="faint">{[a.authors, a.year, a.site].filter(Boolean).join(' · ')}</p>
            </div>
          )}
          {marksInOrder.length > 0 && (
            <section className={`marks ${fold.marks ? 'folded' : ''}`}>
              <button className="fold-head" onClick={() => toggleFold('marks')} aria-expanded={!fold.marks}>
                <h4>
                  Bookmarks <span className="faint">{marksInOrder.length}</span>
                </h4>
                <span className="fold-caret" />
              </button>
              {!fold.marks &&
                marksInOrder.map((b) => (
                  <div key={b.id} className={`bm-item ${bmPop?.id === b.id ? 'on' : ''}`}>
                    <button className="bm-go" onClick={() => goToBookmark(b)}>
                      <span className="bm-glyph" />
                      <span className="mono faint">{bookmarkPlace(b)}</span>
                      <span className="bm-label">{b.label || <span className="faint">no label</span>}</span>
                    </button>
                    {EDITABLE && (
                      <button className="icon faint" onClick={() => actions.removeBookmark(id, b.id)} aria-label="Remove bookmark">
                        ×
                      </button>
                    )}
                  </div>
                ))}
            </section>
          )}
          <section className={fold.summary ? 'folded' : ''}>
            <button className="fold-head" onClick={() => toggleFold('summary')} aria-expanded={!fold.summary}>
              <h4>Summary</h4>
              <span className="fold-caret" />
            </button>
            {!fold.summary && (
              <>
                <Edit multiline value={a.summary} onChange={(summary) => actions.update(id, { summary })} placeholder="The point, in your words…" />
                {!EDITABLE && !a.summary && <p className="faint">—</p>}
              </>
            )}
          </section>
          {(terms.length > 0 || (EDITABLE && kind)) && (
            <section className={`terms ${fold.terms ? 'folded' : ''}`}>
              <button className="fold-head" onClick={() => toggleFold('terms')} aria-expanded={!fold.terms}>
                <h4>
                  Terms <span className="faint">{terms.length || ''}</span>
                </h4>
                <span className="fold-caret" />
              </button>
              {fold.terms ? null : terms.length ? (
                <div className="term-chips">
                  {terms.map((t) => (
                    <button
                      key={t.key}
                      className={`term-chip ${openTerm === t.key ? 'on' : ''}`}
                      onClick={() => {
                        const next = openTerm === t.key ? null : t.key;
                        setOpenTerm(next);
                        const hid = t.defs[0]?.sources[0]?.highlightId;
                        if (next && hid) {
                          setActive(hid);
                          setJump({ id: hid, n: Date.now() });
                        }
                      }}
                    >
                      {t.term}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="faint">Select a word and press D to define it. Every term you define also goes in the glossary on the map.</p>
              )}
              {!fold.terms &&
                terms
                .filter((t) => t.key === openTerm)
                .map((t) => (
                  <div key={t.key} className="term-open">
                    {t.defs.map((d, i) => (
                      <p key={i}>{d.text || <span className="faint">No definition written yet.</span>}</p>
                    ))}
                    {EDITABLE && (
                      <button
                        className="ghost tiny"
                        onClick={(e) => {
                          const hid = t.defs[0]?.sources[0]?.highlightId;
                          if (hid) setPop({ id: hid, x: e.clientX - 320, y: e.clientY - 10 });
                        }}
                      >
                        edit
                      </button>
                    )}
                  </div>
                ))}
            </section>
          )}
          {(refs.length > 0 || (EDITABLE && kind)) && (
            <section className={`refs ${fold.refs ? 'folded' : ''}`}>
              <button className="fold-head" onClick={() => toggleFold('refs')} aria-expanded={!fold.refs}>
                <h4>
                  References <span className="faint">{refs.length || ''}</span>
                </h4>
                <span className="fold-caret" />
              </button>
              {!fold.refs &&
                (refs.length ? (
                  refsInOrder.map((r) => {
                    const src = r.sources[0];
                    const link = citeLink(r.cite);
                    const note = r.sources.map((x) => x.note).filter(Boolean).join(' ');
                    return (
                      <div key={r.key} data-h={src.highlightId} className={`ref-item ${active === src.highlightId ? 'on' : ''}`}>
                        <button
                          className="ref-cite"
                          onClick={() => {
                            setActive(src.highlightId);
                            setJump({ id: src.highlightId, n: Date.now() });
                          }}
                          title="Go to where the paper cites it"
                        >
                          {r.cite}
                        </button>
                        {note && <p className="ref-note">{note}</p>}
                        <div className="ref-actions">
                          {src.page !== undefined && <span className="faint">p. {src.page + 1}</span>}
                          {EDITABLE && (
                            <button
                              className="ghost tiny"
                              onClick={(e) => setPop({ id: src.highlightId, x: e.clientX - 320, y: e.clientY - 10 })}
                            >
                              edit
                            </button>
                          )}
                          {r.onMap ? (
                            <button className="ghost tiny" onClick={() => onOpenReading?.(r.onMap!)}>
                              on the map →
                            </button>
                          ) : (
                            EDITABLE &&
                            onAddReference && (
                              <button className="ghost tiny" onClick={() => onAddReference(id, src.highlightId)}>
                                + add to map
                              </button>
                            )
                          )}
                          <a className="ghost tiny" href={link ?? scholarUrl(r.cite)} target="_blank" rel="noreferrer">
                            {link ? 'open ↗' : 'find ↗'}
                          </a>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="faint">
                    Select a citation, in the text or in the reference list, and press R. It goes on your reading list on the map.
                  </p>
                ))}
            </section>
          )}
          <section className={`notes ${fold.notes ? 'folded' : ''}`}>
            <div className="rail-head">
              <button className="fold-head" onClick={() => toggleFold('notes')} aria-expanded={!fold.notes}>
                <h4>
                  Notes & highlights <span className="faint">{sorted.length || ''}</span>
                </h4>
                <span className="fold-caret" />
              </button>
              {!fold.notes && sorted.length > 1 && (
                <button
                  className="ghost tiny"
                  onClick={() => {
                    pref.set('notes-open', allOpen ? '0' : '1');
                    setAllOpen(!allOpen);
                  }}
                  title={allOpen ? 'Show each note as a short preview' : 'Show every note in full'}
                >
                  {allOpen ? 'collapse all' : 'expand all'}
                </button>
              )}
              {EDITABLE && !fold.notes && (
                <button className="ghost tiny" onClick={addGeneralNote}>
                  + note
                </button>
              )}
            </div>
            {!fold.notes &&
              foldered(sorted, 'n', (h) => secOf.get(h.id), (h) => {
                const open = allOpen || active === h.id || fresh === h.id || (!h.text && !h.note.trim());
                return (
                  <div
                    key={h.id}
                    data-h={h.id}
                    className={`hcard ${active === h.id ? 'on' : ''} ${open ? 'open' : 'shut'} ${h.text ? '' : 'general'} ${isQuestion(h) ? 'question' : ''}`}
                    onClick={(e) => {
                      // Clicking the passage of the open card closes it again.
                      if (active === h.id && !allOpen && (e.target as HTMLElement).closest('blockquote')) return setActive(null);
                      setActive(h.id);
                      if (h.text) setJump({ id: h.id, n: Date.now() });
                    }}
                  >
                    {h.text && <blockquote className={h.kind === 'note' ? 'note' : ''}>{h.text}</blockquote>}
                    <div className="hmeta">
                      {isQuestion(h) && <span className="q-label">question</span>}
                      <span className="faint">
                        {h.rects?.length ? `p. ${h.rects[0].p + 1}` : ''}
                        {open && h.text && hasNote(h) && !isQuestion(h) ? (h.rects?.length ? ' · note' : 'note') : ''}
                      </span>
                      {/* Closed: the note's first line, beside its page. */}
                      {!open && h.note.trim() && <span className="hnote hnote-preview">{h.note}</span>}
                      {EDITABLE && open && (
                        <button
                          className="ghost tiny"
                          onClick={(e) => {
                            e.stopPropagation();
                            actions.removeHighlight(id, h.id);
                          }}
                        >
                          remove
                        </button>
                      )}
                    </div>
                    {open && (
                      <Edit
                        multiline
                        enterFinishes
                        className="hnote"
                        value={h.note}
                        autoFocus={fresh === h.id}
                        onChange={(note) => actions.updateHighlight(id, h.id, { note })}
                        placeholder={h.text ? 'Add a note…' : 'A note about this reading…'}
                      />
                    )}
                  </div>
                );
              })}
            {!fold.notes && !sorted.length && (
              <p className="faint">
                {EDITABLE
                  ? kind
                    ? 'Select text in the document to highlight it or attach a note to that line.'
                    : 'Write notes with “+ note”.'
                  : '—'}
              </p>
            )}
          </section>
        </aside>
      </div>

      {kind && focus && (
        <div className="pager-float mono" aria-hidden="true">
          {page.n} / {page.total}
        </div>
      )}

      {bmPop && bmPopped && (
        <BookmarkPop
          b={bmPopped}
          x={bmPop.x}
          y={bmPop.y}
          editable={EDITABLE}
          onLabel={(label) => actions.updateBookmark(id, bmPopped.id, { label })}
          onRemove={() => {
            actions.removeBookmark(id, bmPopped.id);
            setBmPop(null);
          }}
          onClose={() => setBmPop(null)}
        />
      )}

      {pop && popped && (
        <NotePop
          h={popped}
          x={pop.x}
          y={pop.y}
          editable={EDITABLE}
          onChange={(note) => actions.updateHighlight(id, popped.id, { note })}
          onTerm={(term) => actions.updateHighlight(id, popped.id, { term })}
          onCite={(cite) => actions.updateHighlight(id, popped.id, { cite })}
          onRemove={() => {
            actions.removeHighlight(id, popped.id);
            setPop(null);
          }}
          onClose={closePop}
        />
      )}
    </div>
  );
}

/** Every heading in the document: where you are, and one click to go anywhere.
 * In the local app they can be edited: renamed, moved a level, removed, added. */
function Contents({
  sections,
  known,
  edited,
  cur,
  counts,
  onGo,
  onClose,
  onEdit,
  onAdd,
  onRedetect,
  onClear,
}: {
  sections: Section[];
  known: boolean;
  edited: boolean;
  cur: number;
  counts: number[];
  onGo: (i: number) => void;
  onClose: () => void;
  onEdit: (sections: Section[]) => void;
  /** Adds a heading at the line you're reading; returns its place in the list. */
  onAdd: () => number;
  onRedetect: () => void;
  onClear: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [arm, setArm] = useState(false);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 3500);
    return () => clearTimeout(t);
  }, [arm]);

  const change = (i: number, patch: Partial<Section>) => onEdit(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const level = (i: number, by: number) => change(i, { level: Math.max(1, Math.min(3, sections[i].level + by)) });
  const add = () => {
    const i = onAdd();
    setEditing(true);
    setFocusAt(i);
  };

  const tools = EDITABLE && (editing || !sections.length) && (
    <div className="toc-tools">
      <button className="ghost tiny" onClick={add}>
        + heading at the line you’re reading
      </button>
      <p className="faint toc-tip">Or select a heading in the text and press T.</p>
      <div className="toc-tools-row">
        <button className="ghost tiny" onClick={onRedetect} title="Throw these away and look for the headings again">
          find them again
        </button>
        {sections.length > 0 && (
          <button className={`ghost tiny ${arm ? 'armed' : ''}`} onClick={() => (arm ? (onClear(), setArm(false)) : setArm(true))}>
            {arm ? 'click again to clear all' : 'clear all'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <nav className={`toc ${editing ? 'editing' : ''}`} aria-label="Contents">
      <div className="toc-head">
        <h4>Contents</h4>
        <span className="toc-head-tools">
          {EDITABLE && sections.length > 0 && (
            <button className={`ghost tiny ${editing ? 'on' : ''}`} onClick={() => setEditing(!editing)}>
              {editing ? 'done' : 'edit'}
            </button>
          )}
          <button className="icon" onClick={onClose} aria-label="Hide contents">
            ×
          </button>
        </span>
      </div>
      {sections.length ? (
        <div className="toc-list" ref={list}>
          {sections.map((s, i) =>
            editing ? (
              <div key={i} className={`toc-edit lvl-${s.level} ${cur === i ? 'on' : ''}`}>
                <input
                  value={s.title}
                  autoFocus={focusAt === i}
                  onFocus={(e) => focusAt === i && e.currentTarget.select()}
                  onChange={(e) => change(i, { title: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      level(i, e.shiftKey ? -1 : 1);
                    }
                  }}
                  onBlur={() => setFocusAt(null)}
                  aria-label="Heading"
                />
                <button className="toc-btn" onClick={() => level(i, -1)} disabled={s.level <= 1} title="Up a level (Shift+Tab)">
                  ‹
                </button>
                <button className="toc-btn" onClick={() => level(i, 1)} disabled={s.level >= 3} title="Down a level (Tab)">
                  ›
                </button>
                <button className="toc-btn" onClick={() => onGo(i)} title="Go there">
                  ↓
                </button>
                <button className="toc-btn" onClick={() => onEdit(sections.filter((_, j) => j !== i))} title="Remove this heading">
                  ×
                </button>
              </div>
            ) : (
              <button key={i} className={`toc-row lvl-${s.level} ${cur === i ? 'on' : ''}`} onClick={() => onGo(i)} title={s.title}>
                <span className="toc-title">{s.title}</span>
                {counts[i] > 0 && <span className="toc-count">{counts[i]}</span>}
              </button>
            ),
          )}
        </div>
      ) : (
        <p className="faint toc-empty">{known ? 'No headings in this document yet.' : 'Looking for headings…'}</p>
      )}
      {tools}
      {!editing && sections.length > 0 && (
        <p className="toc-keys faint">
          [ and ] jump between headings{edited ? ' · your edits are kept' : ''}
        </p>
      )}
    </nav>
  );
}
