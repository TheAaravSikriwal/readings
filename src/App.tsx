import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { attachPdf, importPdf, looksLikeUrl } from './importer';
import { MapCanvas } from './map/MapCanvas';
import { actions, EDITABLE, getState, useStore } from './store';
import { AddMaterial, type AddSeed } from './ui/AddMaterial';
import { Card, CARD_WIDTH } from './ui/Card';
import { ContextMenu, type MenuAction } from './ui/ContextMenu';
import { ExportSheet } from './ui/ExportSheet';
import { PublishSheet } from './ui/PublishSheet';
import { Palette, type PaletteMode } from './ui/Palette';
import { Prompt, type PromptSpec } from './ui/Prompt';
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

export default function App() {
  const { tree, lib, loaded, error, toast } = useStore();
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
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 680px)').matches);

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
      if (reading || palette || prompt || adding || exporting || publishing || typing(e.target)) return;
      if (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        setPalette({ kind: 'search' });
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        if (menu) setMenu(null);
        else up();
      } else if (e.key === 'Enter' && selected) setReading(selected);
      else if (EDITABLE && e.key === 'n' && !e.metaKey && !e.ctrlKey) newTopic(focus);
      else if (EDITABLE && e.key === 'a' && !e.metaKey && !e.ctrlKey) setAdding({});
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

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

  return (
    <div className="app">
      <MapCanvas
        focus={focus}
        selected={selected}
        marked={palette?.kind === 'connect' ? palette.from : null}
        paused={!!reading}
        shiftX={narrow ? 0 : (CARD_WIDTH + 24) / 2}
        shiftY={narrow ? Math.round(window.innerHeight * 0.3) : 0}
        onClick={(id, ev) => {
          setMenu(null);
          if (ev.shiftKey && EDITABLE && selected && id !== selected) actions.toggleConnection(selected, id);
          else open(id);
        }}
        onDblClick={(id) => tree.article(id) && setReading(id)}
        onRightClick={(id, ev) => EDITABLE && setMenu({ id, x: ev.clientX, y: ev.clientY })}
        onBackground={() => {
          setMenu(null);
          setSelected(null);
        }}
        onDrop={(id, into) => {
          if (actions.move(id, into)) actions.toast(`Moved “${tree.get(id)?.title}” into “${into ? tree.get(into)?.title : lib.title}”`);
        }}
      />

      <TopBar focus={focus} onGo={open} onRename={rename} />

      {selected && !reading && (
        <Card
          id={selected}
          onRead={() => setReading(selected)}
          onConnect={() => setPalette({ kind: 'connect', from: selected })}
          onOpen={open}
          onClose={() => setSelected(null)}
        />
      )}

      {empty && (
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

      <div className="toolbar">
        {EDITABLE && (
          <>
            <button className="strong" onClick={() => setAdding({})}>
              + add material
            </button>
            <button onClick={() => newTopic(focus)}>+ topic</button>
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

      {!empty && (
        <div className="hint">
          {EDITABLE
            ? 'click to open · double-click to read · drag onto a topic to move · shift-click to connect · right-click for more'
            : 'click a bubble to open · double-click to read · drag to orbit · scroll to zoom'}
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
          onAdded={open}
        />
      )}
      {exporting && <ExportSheet focus={focus} onClose={() => setExporting(false)} />}
      {publishing && <PublishSheet onClose={() => setPublishing(false)} />}

      {reading && (
        <Suspense fallback={<div className="reader" />}>
          <Reader id={reading} onClose={() => setReading(null)} />
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
