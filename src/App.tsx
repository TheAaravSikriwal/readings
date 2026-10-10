import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditScreen, nudge } from './edit/EditScreen';
import { useEditor } from './edit/useEditor';
import { attachPdf, importPdf, looksLikeUrl } from './importer';
import { MapCanvas } from './map/MapCanvas';
import type { MapCallbacks, MapView } from './map/MapView';
import { glossary, guessCite, referenceList } from './notes';
import { actions, EDITABLE, getState, useStore } from './store';
import { AddMaterial, type AddSeed } from './ui/AddMaterial';
import { Card, CARD_WIDTH } from './ui/Card';
import { ContextMenu, type MenuAction } from './ui/ContextMenu';
import { ExportSheet } from './ui/ExportSheet';
import { PublishSheet } from './ui/PublishSheet';
import { Palette, type PaletteMode } from './ui/Palette';
import { Prompt, type PromptSpec } from './ui/Prompt';
import { Shelf, type ShelfPart } from './ui/Shelf';
import { TopBar } from './ui/TopBar';

const Reader = lazy(() => import('./reader/Reader'));

// The address bar remembers where you are: #t=<topic>&a=<article>&r=1 (reading)
const fromHash = () => {
  const h = new URLSearchParams(location.hash.slice(1));
  return { t: h.get('t'), a: h.get('a'), r: h.get('r') === '1' };
};
const start = fromHash();

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]');

/** The glossary and the references on the map: open unless you put them away. */
const shelfOpen = (part: ShelfPart) => {
  try {
    return localStorage.getItem(part) !== 'closed';
  } catch {
    return true;
  }
};

export default function App() {
  const { tree, lib, rev, loaded, error, toast } = useStore();
  const [focusId, setFocus] = useState<string | null>(start.t);
  const [selectedId, setSelected] = useState<string | null>(start.a);
  const [readingId, setReading] = useState<string | null>(start.r ? start.a : null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [adding, setAdding] = useState<AddSeed | null>(null);
  const [addDrop, setAddDrop] = useState<{ file: File; n: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [shelf, setShelf] = useState(() => ({ glossary: shelfOpen('glossary'), references: shelfOpen('references') }));
  const terms = useMemo(() => glossary(lib), [lib, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useMemo(() => referenceList(lib), [lib, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const shelfUp = (shelf.glossary && terms.length > 0) || (shelf.references && refs.length > 0);
  /* A definition or reference to scroll to when the reader opens from the map. */
  const [readHl, setReadHl] = useState<string | null>(null);
  /* A bookmark to go to when the reader opens from a pin. */
  const [readBm, setReadBm] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 680px)').matches);
  // The edit screen (local app only): the whole map, with every bubble and line editable.
  const [editing, setEditing] = useState(false);
  const [layersOpen, setLayersOpen] = useState(() => {
    try {
      return localStorage.getItem('layers') !== 'closed';
    } catch {
      return true;
    }
  });
  const mapApi = useRef<MapView | null>(null);
  const ed = useEditor(mapApi, (topic) => setAdding({ topic }));

  useEffect(() => {
    const mq = matchMedia('(max-width: 680px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Ignore ids that no longer exist (deleted, moved out, …).
  const focus = tree.get(focusId)?.type === 'topic' ? focusId : null;
  const selected = tree.article(selectedId) ? selectedId : null;
  const reading = tree.article(readingId) ? readingId : null;

  /** Topics open like folders; articles open their card. */
  const open = useCallback((id: string | null) => {
    const t = getState().tree; // fresh: may be called right after adding something
    const n = t.get(id);
    if (!n) {
      setFocus(null);
      setSelected(null);
    } else if (n.type === 'topic') {
      setFocus(n.id);
      setSelected(null);
    } else {
      setFocus(t.parentOf(n.id));
      setSelected(n.id);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const h = new URLSearchParams();
    if (focus) h.set('t', focus);
    if (reading || selected) h.set('a', (reading ?? selected)!);
    if (reading) h.set('r', '1');
    const s = h.toString();
    history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
    // Framed on the website: tell the page where we are, so its address can follow.
    if (window.parent !== window) window.parent.postMessage({ type: 'readings:place', hash: s ? `#${s}` : '' }, '*');
  }, [loaded, focus, selected, reading]);

  // A shared link may name just the article; open its topic too.
  useEffect(() => {
    if (loaded && selected) setFocus(tree.parentOf(selected));
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const back = () => {
      const h = fromHash();
      setFocus(h.t);
      setSelected(h.a);
      setReading(h.r ? h.a : null);
    };
    window.addEventListener('hashchange', back);
    return () => window.removeEventListener('hashchange', back);
  }, []);

  /** A reference to read next: the add sheet, filled in from the citation, and
   * the new reading connected to the one that cites it. */
  const addReference = (articleId: string, highlightId: string) => {
    const h = tree.article(articleId)?.highlights.find((x) => x.id === highlightId);
    if (!h) return;
    const g = guessCite(h.cite || h.text);
    setAdding({
      url: g.url,
      topic: tree.parentOf(articleId),
      fields: { title: g.title, authors: g.authors ?? '', year: g.year ?? '' },
      cites: { articleId, highlightId, title: tree.get(articleId)?.title ?? '' },
    });
  };

  const enterEdit = () => {
    if (!EDITABLE) return;
    setMenu(null);
    setPalette(null);
    ed.setConnectFrom(null);
    ed.setSel(selected ? { node: selected } : focus ? { node: focus } : null);
    setEditing(true);
  };
  const exitEdit = () => {
    ed.setConnectFrom(null);
    ed.setQuick(null);
    setEditing(false);
    // Back on the map, where you were in the editor.
    if (ed.selNode) open(ed.selNode);
  };

  const up = () => {
    if (selected) setSelected(null);
    else if (focus) setFocus(tree.parentOf(focus));
  };

  const newTopic = (parent: string | null) =>
    setPrompt({
      title: parent ? `New topic in “${tree.get(parent)?.title}”` : 'New topic',
      placeholder: 'e.g. Attention mechanisms',
      action: 'create',
      onSubmit: (title) => actions.addTopic(parent, title),
    });

  /** Several PDFs at once skip the form and go straight into the topic you're in. */
  const addFiles = (pdfs: File[]) => {
    if (pdfs.length === 1) return setAdding({ file: pdfs[0] });
    pdfs.forEach((f) => importPdf(f, focus));
    actions.toast(`Adding ${pdfs.length} PDFs to ${focus ? `“${tree.get(focus)?.title}”` : lib.title}…`);
  };

  const rename = (id: string | null) =>
    setPrompt({
      title: 'Rename',
      initial: id ? tree.get(id)?.title : lib.title,
      action: 'rename',
      onSubmit: (title) => (id ? actions.update(id, { title }) : actions.setTitle(title)),
    });

  const onMenu = (id: string, a: MenuAction) => {
    if (a === 'open') open(id);
    if (a === 'read') setReading(id);
    if (a === 'rename') rename(id);
    if (a === 'new-topic') newTopic(id);
    if (a === 'add') setAdding({ topic: id });
    if (a === 'connect') setPalette({ kind: 'connect', from: id });
    if (a === 'move') setPalette({ kind: 'move', id });
  };

  const onPick = (picked: string | null) => {
    const m = palette;
    setPalette(null);
    if (!m) return;
    if (m.kind === 'search') open(picked);
    if (m.kind === 'connect' && picked) actions.toggleConnection(m.from, picked);
    if (m.kind === 'move' && actions.move(m.id, picked)) {
      actions.toast(`Moved into ${picked ? `“${tree.get(picked)?.title}”` : 'the top level'}`);
    }
  };

  // Keyboard: / search · Esc back out · Enter read · n new topic
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (editing || reading || palette || prompt || adding || exporting || publishing || typing(e.target)) return;
      if (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        setPalette({ kind: 'search' });
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        if (menu) setMenu(null);
        else up();
      } else if (e.key === 'Enter' && selected) setReading(selected);
      else if (EDITABLE && e.key === 'n' && !e.metaKey && !e.ctrlKey) newTopic(focus);
      else if (EDITABLE && e.key === 'a' && !e.metaKey && !e.ctrlKey) setAdding({});
      else if (EDITABLE && e.key === 'e' && !e.metaKey && !e.ctrlKey) enterEdit();
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        nudge(mapApi, e.key);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) undo and redo, everywhere, map or reader.
  // Inside a text box they're left to the box's own undo.
  useEffect(() => {
    if (!EDITABLE) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || typing(e.target)) return;
      const k = e.key.toLowerCase();
      const redo = (k === 'z' && e.shiftKey) || k === 'y';
      if (k !== 'z' && !redo) return;
      e.preventDefault();
      const done = redo ? actions.redo() : actions.undo();
      actions.toast(done ? (redo ? 'Redone.' : 'Undone.') : redo ? 'Nothing to redo.' : 'Nothing to undo.');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // Paste a link or PDF anywhere to add it to the topic you're in.
  useEffect(() => {
    if (!EDITABLE) return;
    const paste = (e: ClipboardEvent) => {
      if (typing(e.target) || reading || adding) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isPdf);
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (files.length) addFiles(files);
      else if (text && looksLikeUrl(text)) setAdding({ url: text });
      else return;
      e.preventDefault();
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  });

  // Drag PDFs (or a link) onto the window.
  useEffect(() => {
    if (!EDITABLE) return;
    let depth = 0;
    const carries = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].some((t) => t === 'Files' || t === 'text/uri-list');
    const enter = (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      depth++;
      setDropping(true);
    };
    const over = (e: DragEvent) => !typing(e.target) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!carries(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (typing(e.target)) return;
      e.preventDefault(); // never let a stray drop navigate away from the app
      if (!carries(e)) return;
      depth = 0;
      setDropping(false);
      const all = [...(e.dataTransfer?.files ?? [])];
      const pdfs = all.filter(isPdf);
      const target = reading && !tree.article(reading)?.file ? reading : null;
      const url = e.dataTransfer?.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
      if (adding) {
        if (pdfs[0]) setAddDrop({ file: pdfs[0], n: Date.now() });
      } else if (pdfs.length) {
        if (target) attachPdf(target, pdfs[0]);
        else addFiles(pdfs);
      } else if (all.length) {
        actions.toast('Only PDFs can be dropped. For web pages, paste the link.');
      } else if (url) {
        setAdding({ url: url.trim() });
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  });

  const empty = loaded && !lib.nodes.length;

  const browse: MapCallbacks = {
    onClick: (id, ev) => {
      setMenu(null);
      // Shift-click connects from the open reading, or else from the topic you're in.
      const from = selected ?? focus;
      if (ev.shiftKey && EDITABLE && from && id !== from) {
        const had = actions.linkBetween(from, id);
        actions.toggleConnection(from, id);
        actions.toast(`${had ? 'Disconnected' : 'Connected'} “${tree.get(from)?.title}” and “${tree.get(id)?.title}”`);
      } else open(id);
    },
    onDblClick: (id) => tree.article(id) && setReading(id),
    onRightClick: (id, ev) => EDITABLE && setMenu({ id, x: ev.clientX, y: ev.clientY }),
    onBackground: () => {
      // Empty space backs out one step: the open card first, then the topic you're in.
      if (menu) return setMenu(null);
      up();
    },
    onDrop: (id, into) => {
      if (actions.move(id, into)) actions.toast(`Moved “${tree.get(id)?.title}” into “${into ? tree.get(into)?.title : lib.title}”`);
    },
  };

  return (
    <div className="app">
      <MapCanvas
        focus={focus}
        selected={selected}
        marked={palette?.kind === 'connect' ? palette.from : null}
        paused={!!reading}
        shiftX={narrow ? 0 : (CARD_WIDTH + 24) / 2}
        shiftY={narrow ? Math.round(window.innerHeight * 0.3) : 0}
        editing={editing}
        editNode={ed.selNode}
        editLink={ed.selLink}
        connectFrom={ed.connectFrom}
        editInsets={narrow ? undefined : { left: layersOpen ? 276 : 0, right: 356 }}
        api={mapApi}
        {...(editing ? ed.handlers : browse)}
      />

      {!editing && (
      <TopBar
        focus={focus}
        onGo={open}
        onRename={rename}
        onConnect={(from) => setPalette({ kind: 'connect', from })}
        onReadBookmark={(articleId, bookmarkId) => {
          open(articleId);
          setReadHl(null);
          setReadBm(bookmarkId);
          setReading(articleId);
        }}
      />
      )}

      {selected && !reading && !editing && (
        <Card
          id={selected}
          onRead={() => setReading(selected)}
          onConnect={() => setPalette({ kind: 'connect', from: selected })}
          onOpen={open}
          onReadAt={(hid) => {
            setReadBm(null);
            setReadHl(hid);
            setReading(selected);
          }}
          onAddReference={addReference}
          onClose={() => setSelected(null)}
        />
      )}

      {empty && !editing && (
        <div className="empty">
          <div className="empty-orb" />
          <h1>{EDITABLE ? 'Start your reading map' : 'Nothing here yet'}</h1>
          {EDITABLE && (
            <>
              <p>Add a PDF, a link or a book, or start with a topic.</p>
              <div className="row">
                <button className="pill solid" onClick={() => setAdding({})}>
                  add material
                </button>
                <button className="pill" onClick={() => newTopic(null)}>
                  new topic
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {!editing && (
      <div className="toolbar">
        {EDITABLE && (
          <>
            <button className="strong" onClick={() => setAdding({})}>
              + add material
            </button>
            <button onClick={() => newTopic(focus)}>+ topic</button>
            <button onClick={enterEdit} title="Edit the map: every bubble and line, with settings (E)">
              edit <kbd>E</kbd>
            </button>
            <span className="tsep" />
          </>
        )}
        <button onClick={() => setPalette({ kind: 'search' })}>
          search <kbd>/</kbd>
        </button>
        {EDITABLE && (
          <>
            <button onClick={() => setExporting(true)}>export</button>
            <span className="tsep" />
            <button className="strong" onClick={() => setPublishing(true)}>
              publish
            </button>
          </>
        )}
      </div>
      )}

      {!reading && !editing && (
        <Shelf
          terms={terms}
          refs={refs}
          open={shelf}
          onToggle={(part) => {
            const next = { ...shelf, [part]: !shelf[part] };
            setShelf(next);
            try {
              localStorage.setItem(part, next[part] ? 'open' : 'closed');
            } catch {
              // private mode
            }
          }}
          onOpenSource={(s) => {
            open(s.articleId);
            setReadBm(null);
            setReadHl(s.highlightId);
            setReading(s.articleId);
          }}
          onAddReference={addReference}
          onShow={open}
        />
      )}

      {editing && !reading && (
        <EditScreen
          ed={ed}
          api={mapApi}
          layersOpen={layersOpen}
          onLayers={(on) => {
            setLayersOpen(on);
            try {
              localStorage.setItem('layers', on ? 'open' : 'closed');
            } catch {
              // private mode
            }
          }}
          onRead={(id) => setReading(id)}
          onExit={exitEdit}
        />
      )}

      {!empty && !shelfUp && !editing && (
        <div className="hint">
          {EDITABLE
            ? 'drag to move around · right-drag to turn · scroll to zoom · click to open · double-click to read · drag a bubble onto a topic to move it · shift-click to connect · right-click for more'
            : 'drag to move around · right-drag to turn · scroll to zoom · click a bubble to open · double-click to read'}
        </div>
      )}

      {menu && <ContextMenu {...menu} onAction={(a) => onMenu(menu.id, a)} onClose={() => setMenu(null)} />}
      {palette && <Palette mode={palette} onPick={onPick} onClose={() => setPalette(null)} />}
      {prompt && <Prompt spec={prompt} onClose={() => setPrompt(null)} />}
      {adding && (
        <AddMaterial
          seed={adding}
          topic={focus}
          dropped={addDrop}
          onClose={() => {
            setAdding(null);
            setAddDrop(null);
          }}
          onAdded={(id) => {
            const from = adding.cites;
            if (editing && !from) return ed.setSel({ node: id });
            if (!from) return open(id);
            actions.linkReference(from.articleId, from.highlightId, id);
            if (reading) actions.toast(`Added to the map, connected to “${from.title}”`);
            else open(id);
          }}
        />
      )}
      {exporting && <ExportSheet focus={focus} onClose={() => setExporting(false)} />}
      {publishing && <PublishSheet onClose={() => setPublishing(false)} />}

      {reading && (
        <Suspense fallback={<div className="reader" />}>
          <Reader
            id={reading}
            focusHighlight={readHl}
            focusBookmark={readBm}
            onAddReference={addReference}
            onOpenReading={(id) => {
              open(id);
              setReadHl(null);
              setReadBm(null);
              setReading(id);
            }}
            onClose={() => {
              setReading(null);
              setReadHl(null);
              setReadBm(null);
            }}
          />
        </Suspense>
      )}

      {dropping && (
        <div className="dropzone">
          <div>
            {adding ? (
              'drop the PDF'
            ) : (
              <>
                drop to add to <b>{tree.get(reading && !tree.article(reading)?.file ? reading : focus)?.title ?? lib.title}</b>
              </>
            )}
          </div>
        </div>
      )}
      {(toast || error) && (
        <div className="toast" key={toast?.id ?? 'err'}>
          {toast?.text ?? `Couldn't load your library: ${error}`}
        </div>
      )}
    </div>
  );
}
