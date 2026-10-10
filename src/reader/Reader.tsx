import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileUrl } from '../api';
import { attachPdf, fetchInto } from '../importer';
import { articleMarkdown, download, exportName, glossary, hasNote, isDefinition, sortNotes } from '../notes';
import type { MarkMode } from './SelectionPop';
import { actions, EDITABLE, useStore } from '../store';
import type { Highlight } from '../types';
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
}

export default function Reader({ id, onClose, focusHighlight }: ReaderProps) {
  const { tree, lib, pending } = useStore();
  const a = tree.article(id);
  const [active, setActive] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [pop, setPop] = useState<{ id: string; x: number; y: number } | null>(null);
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [paper, setPaper] = useState<Paper>(savedPaper);
  const [idle, setIdle] = useState(false);
  const [focus, setFocus] = useState(false);
  const [page, setPage] = useState({ n: 1, total: 1 });
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const highlights = a?.highlights ?? [];
  const sorted = useMemo(() => sortNotes(highlights.filter((h) => !isDefinition(h))), [highlights]);
  const terms = useMemo(() => (a ? glossary(lib, a.id) : []), [lib, a, highlights]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openTerm, setOpenTerm] = useState<string | null>(null);

  // Opened from the glossary: go to that definition.
  useEffect(() => {
    if (!focusHighlight) return;
    setActive(focusHighlight);
    setJump({ id: focusHighlight, n: Date.now() });
  }, [focusHighlight]);
  const kind = a?.file?.endsWith('.pdf') ? 'pdf' : a?.file?.endsWith('.html') ? 'html' : null;
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
      timer = window.setTimeout(update, 120);
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
      setZoom(1);
      await root.current?.requestFullscreen?.().catch(() => {});
    } else {
      setFocus(false);
      setZoom(1);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    }
  }, [focus]);

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

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'Escape') return focus ? toggleFocus() : onClose();
      if (e.key === 'ArrowRight' || e.key === 'PageDown') (e.preventDefault(), goTo(current() + 1));
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') (e.preventDefault(), goTo(current() - 1));
      if (e.key === 'f' || e.key === 'F') toggleFocus();
      if (e.key === 'w' || e.key === 'W') cyclePaper();
      if (kind === 'pdf' && (e.key === '=' || e.key === '+')) setZoom((z) => Math.min(2.5, z + 0.15));
      if (kind === 'pdf' && e.key === '-') setZoom((z) => Math.max(0.5, z - 0.15));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, kind, goTo, page.n, focus, toggleFocus]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const short = looksLikeTerm(h.text);
      const hid = actions.addHighlight(
        id,
        mode === 'note'
          ? { ...h, kind: 'note' }
          : mode === 'definition'
            ? { ...h, kind: 'definition', term: short ? h.text : '', note: short ? '' : h.text }
            : h,
      );
      setActive(hid);
      if (mode !== 'highlight') setPop({ id: hid, x, y });
    },
    [id],
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
          {kind === 'pdf' && (
            <>
              <span className="tool-sep" />
              <button className="ghost" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))} aria-label="Zoom out">
                −
              </button>
              <span className="faint mono">{Math.round(zoom * 100)}%</span>
              <button className="ghost" onClick={() => setZoom((z) => Math.min(2.5, z + 0.15))} aria-label="Zoom in">
                +
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

      <div className={`r-body ${notesOnly ? 'notes-only' : ''}`}>
        {!notesOnly && (
          <main className="r-doc" ref={scroller} onClick={turn}>
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
          <section>
            <h4>Summary</h4>
            <Edit multiline value={a.summary} onChange={(summary) => actions.update(id, { summary })} placeholder="The point, in your words…" />
            {!EDITABLE && !a.summary && <p className="faint">—</p>}
          </section>
          {(terms.length > 0 || (EDITABLE && kind)) && (
            <section className="terms">
              <h4>
                Terms <span className="faint">{terms.length || ''}</span>
              </h4>
              {terms.length ? (
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
              {terms
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
          <section>
            <div className="rail-head">
              <h4>
                Notes & highlights <span className="faint">{sorted.length || ''}</span>
              </h4>
              {EDITABLE && (
                <button className="ghost tiny" onClick={addGeneralNote}>
                  + note
                </button>
              )}
            </div>
            {sorted.map((h) => (
              <div
                key={h.id}
                data-h={h.id}
                className={`hcard ${active === h.id ? 'on' : ''} ${h.text ? '' : 'general'}`}
                onClick={() => {
                  setActive(h.id);
                  if (h.text) setJump({ id: h.id, n: Date.now() });
                }}
              >
                {h.text && <blockquote className={h.kind === 'note' ? 'note' : ''}>{h.text}</blockquote>}
                <div className="hmeta">
                  <span className="faint">
                    {h.rects?.length ? `p. ${h.rects[0].p + 1}` : ''}
                    {h.text && hasNote(h) ? (h.rects?.length ? ' · note' : 'note') : ''}
                  </span>
                  {EDITABLE && (
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
                <Edit
                  multiline
                  enterFinishes
                  className="hnote"
                  value={h.note}
                  autoFocus={fresh === h.id}
                  onChange={(note) => actions.updateHighlight(id, h.id, { note })}
                  placeholder={h.text ? 'Add a note…' : 'A note about this reading…'}
                />
              </div>
            ))}
            {!sorted.length && (
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

      {pop && popped && (
        <NotePop
          h={popped}
          x={pop.x}
          y={pop.y}
          editable={EDITABLE}
          onChange={(note) => actions.updateHighlight(id, popped.id, { note })}
          onTerm={(term) => actions.updateHighlight(id, popped.id, { term })}
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
