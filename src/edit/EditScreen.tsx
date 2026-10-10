import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { attachPdf, replacePdf } from '../importer';
import { pullShare, type MapView } from '../map/MapView';
import { actions, getState, useStore } from '../store';
import type { LibNode } from '../types';
import { isParentLine, type Editor, type QuickSpec } from './useEditor';

interface Props {
  ed: Editor;
  api: MutableRefObject<MapView | null>;
  layersOpen: boolean;
  onLayers: (open: boolean) => void;
  onRead: (id: string) => void;
  onExit: () => void;
}

/** Arrow keys slide the view, like dragging it. */
export const nudge = (api: MutableRefObject<MapView | null>, key: string) => {
  const d = 110;
  api.current?.nudge(key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0);
};

const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]');

/** The edit screen: the map with everything on it, a list of every bubble on
 * the left, the settings of whatever you click on the right. */
export function EditScreen({ ed, api, layersOpen, onLayers, onRead, onExit }: Props) {
  const { lib } = useStore();

  // Keys while editing. Ctrl+Z and Ctrl+Shift+Z are the app's own, everywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing(e.target) || ed.quick || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.scrim')) return; // the add sheet is open
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (e.key === 'Escape')
        run(() => (ed.connectFrom ? ed.setConnectFrom(null) : ed.sel ? ed.setSel(null) : onExit()));
      else if (e.key === 'Delete' || e.key === 'Backspace') run(ed.remove);
      else if (e.key === 'Enter') run(ed.focusTitle);
      else if (k === 't') run(() => ed.newTopic());
      else if (k === 'a') run(() => ed.addReading());
      else if (k === 'c') run(() => ed.startConnect());
      else if (k === 'f') run(ed.fit);
      else if (k === 'l') run(() => onLayers(!layersOpen));
      else if (k === 'e') run(onExit);
      else if (e.key.startsWith('Arrow')) run(() => nudge(api, e.key));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const hint = ed.connectFrom
    ? `Click the bubble to connect “${getState().tree.get(ed.connectFrom)?.title}” to. Esc to stop.`
    : ed.selLink
      ? isParentLine(ed.selLink)
        ? 'Drag the dot at the topic end onto another topic to move it there. + puts a new topic in between.'
        : 'Drag either end onto another bubble to re-route it. + puts a new bubble in the middle.'
      : ed.selNode
        ? 'Drag it onto a topic to move it inside, or into open space to pin it there. Drag its dot onto another bubble to connect them.'
        : 'Click a bubble or a line to change it. Hover a line for +. Double-click empty space for a new topic.';

  return (
    <div className="ed" onKeyDown={(e) => e.stopPropagation()}>
      <div className="ed-left">
        <div className="ed-head ed-panel">
          <div className="ed-head-top">
            <span className="ed-badge">editing</span>
            <span className="ed-head-title">{lib.title}</span>
            <button className="pill solid small" onClick={onExit}>
              done
            </button>
          </div>
          <p className="ed-hint">{hint}</p>
        </div>
        {layersOpen ? (
          <Layers ed={ed} api={api} onClose={() => onLayers(false)} />
        ) : (
          <button className="gloss-tab ed-layers-tab" onClick={() => onLayers(true)}>
            layers <span className="faint">L</span>
          </button>
        )}
      </div>

      <Inspector ed={ed} api={api} onRead={onRead} />

      <div className="toolbar ed-dock">
        <button className="strong" onClick={() => ed.newTopic()}>
          + topic <kbd>T</kbd>
        </button>
        <button onClick={() => ed.addReading()}>
          + reading <kbd>A</kbd>
        </button>
        <button className={ed.connectFrom ? 'on' : ''} onClick={() => (ed.connectFrom ? ed.setConnectFrom(null) : ed.startConnect())}>
          {ed.connectFrom ? 'connecting…' : 'connect'} <kbd>C</kbd>
        </button>
        <span className="tsep" />
        <button onClick={() => actions.toast(actions.undo() ? 'Undone.' : 'Nothing to undo.')} title="Undo (Ctrl+Z)">
          undo
        </button>
        <button onClick={() => actions.toast(actions.redo() ? 'Redone.' : 'Nothing to redo.')} title="Redo (Ctrl+Shift+Z)">
          redo
        </button>
        <span className="tsep" />
        <button onClick={ed.fit} title="Fit the map, or the selected bubble, in view">
          fit <kbd>F</kbd>
        </button>
      </div>

      {ed.quick && <QuickAdd spec={ed.quick} onClose={() => ed.setQuick(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- layers

/** Every bubble as a list: click to select it, drag onto a topic to move it. */
function Layers({ ed, api, onClose }: { ed: Editor; api: MutableRefObject<MapView | null>; onClose: () => void }) {
  const { tree, lib } = useStore();
  const [q, setQ] = useState('');
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = ed.selNode;

  // The selected bubble's row comes into view, and its topics open.
  useEffect(() => {
    if (!selected) return;
    const up = tree.path(tree.parentOf(selected)).map((n) => n.id);
    if (up.some((id) => shut.has(id))) setShut((s) => new Set([...s].filter((id) => !up.includes(id))));
    requestAnimationFrame(() => list.current?.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const order = (ns: LibNode[]) =>
    [...ns].sort((a, b) => (a.type === b.type ? 0 : a.type === 'topic' ? -1 : 1));

  const drop = (into: string | null) => (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/x-bubble');
    setOver(null);
    if (!id) return;
    e.preventDefault();
    if (actions.move(id, into)) actions.toast(`Moved “${tree.get(id)?.title}” into “${into ? tree.get(into)?.title : lib.title}”`);
  };
  const dragOver = (id: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('text/x-bubble')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (over !== id) setOver(id);
  };

  const row = (n: LibNode, depth: number, path?: string) => {
    const topic = n.type === 'topic';
    const kids = topic ? tree.children(n.id) : [];
    const closed = shut.has(n.id);
    return (
      <div key={n.id}>
        <div
          data-id={n.id}
          className={`ly-row ${n.type} ${selected === n.id ? 'on' : ''} ${over === n.id ? 'over' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/x-bubble', n.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={topic ? dragOver(n.id) : undefined}
          onDragLeave={() => over === n.id && setOver(null)}
          onDrop={topic ? drop(n.id) : undefined}
          onClick={() => {
            ed.setSel({ node: n.id });
            api.current?.frameNode(n.id);
          }}
          onDoubleClick={ed.focusTitle}
        >
          {topic && kids.length > 0 && !path ? (
            <button
              className={`ly-caret ${closed ? 'closed' : ''}`}
              aria-label={closed ? 'Open' : 'Close'}
              onClick={(e) => {
                e.stopPropagation();
                setShut((s) => {
                  const next = new Set(s);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                });
              }}
            />
          ) : (
            <span className="ly-caret-space" />
          )}
          <span className={`glyph ${n.type}`} />
          <span className="ly-title">
            {n.title || 'Untitled'}
            {path && <span className="faint"> · {path}</span>}
          </span>
          {n.pin && <span className="ly-flag">pinned</span>}
          {n.hidden && <span className="ly-flag">hidden</span>}
          {n.type === 'article' && n.done && <span className="ly-flag">done</span>}
        </div>
        {topic && !closed && !path && order(kids).map((k) => row(k, depth + 1))}
      </div>
    );
  };

  const needle = q.trim().toLowerCase();
  const found = needle ? lib.nodes.filter((n) => n.title.toLowerCase().includes(needle)) : [];

  return (
    <div className="ed-layers ed-panel">
      <div className="ly-head">
        <h4>
          Layers <span className="faint">{lib.nodes.length}</span>
        </h4>
        <button className="icon" onClick={onClose} aria-label="Hide layers">
          ×
        </button>
      </div>
      {lib.nodes.length > 8 && (
        <input className="gloss-search" value={q} placeholder="Find a bubble…" onChange={(e) => setQ(e.target.value)} />
      )}
      <div className="ly-list" ref={list}>
        <div
          className={`ly-row ly-root ${over === '__top' ? 'over' : ''}`}
          onDragOver={dragOver('__top')}
          onDragLeave={() => over === '__top' && setOver(null)}
          onDrop={drop(null)}
          onClick={() => {
            ed.setSel(null);
            api.current?.frameAll();
          }}
        >
          <span className="ly-title">{lib.title}</span>
          <span className="ly-flag">top level</span>
        </div>
        {needle
          ? found.map((n) => row(n, 0, tree.path(n.parent).map((p) => p.title).join(' / ') || lib.title))
          : order(tree.children(null)).map((n) => row(n, 0))}
        {needle && !found.length && <p className="faint pad">Nothing matches.</p>}
        {!lib.nodes.length && <p className="faint pad">Nothing yet. Double-click the map, or press T, for a first topic.</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- inspector

function Inspector({ ed, api, onRead }: { ed: Editor; api: MutableRefObject<MapView | null>; onRead: (id: string) => void }) {
  const { tree, lib } = useStore();
  let body: ReactNode;
  const node = ed.selNode ? tree.get(ed.selNode) : undefined;
  const link = ed.selLink;
  if (node) body = <BubblePanel key={node.id} n={node} ed={ed} onRead={onRead} />;
  else if (link && isParentLine(link) && tree.get(link.slice(2)) && tree.parentOf(link.slice(2)))
    body = <InsideLinePanel key={link} child={link.slice(2)} ed={ed} />;
  else if (link && lib.links.some((l) => l.id === link)) body = <ConnectionPanel key={link} id={link} ed={ed} api={api} />;
  else body = <MapPanel api={api} />;
  return <aside className="ed-inspector ed-panel">{body}</aside>;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ed-sec">
      <div className="ed-sec-head">
        <h4>{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Toggle({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <div className="ed-toggle" onClick={() => onChange(!on)}>
      <span className="ed-toggle-text">
        <span>{label}</span>
        {hint && <span className="faint">{hint}</span>}
      </span>
      <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} />
    </div>
  );
}

/** Two clicks: the first arms it, the second does it. */
function Confirm({ label, armedLabel, note, onGo }: { label: string; armedLabel: string; note?: string; onGo: () => void }) {
  const [arm, setArm] = useState(false);
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 3500);
    return () => clearTimeout(t);
  }, [arm]);
  return (
    <div className="ed-danger">
      <button className={`pill small danger ${arm ? 'armed' : ''}`} onClick={() => (arm ? onGo() : setArm(true))}>
        {arm ? armedLabel : label}
      </button>
      {note && <p className="ed-help">{note}</p>}
    </div>
  );
}

function useTopicOptions(exclude?: string) {
  const { tree } = useStore();
  return useMemo(
    () =>
      tree
        .topics()
        .filter((t) => !exclude || (t.id !== exclude && !tree.isInside(t.id, exclude)))
        .map((t) => ({ id: t.id, label: tree.path(t.id).map((n) => n.title).join(' / ') }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tree, exclude],
  );
}

function TopicSelect({ value, exclude, onChange }: { value: string | null; exclude?: string; onChange: (id: string | null) => void }) {
  const { lib } = useStore();
  const options = useTopicOptions(exclude);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{lib.title} (top level)</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function BubbleSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { tree, lib } = useStore();
  const label = (n: LibNode) => [...tree.path(n.parent).map((p) => p.title), n.title].join(' / ');
  const sorted = (type: LibNode['type']) =>
    lib.nodes
      .filter((n) => n.type === type)
      .map((n) => ({ id: n.id, label: label(n) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <optgroup label="Topics">
        {sorted('topic').map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Readings">
        {sorted('article').map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/** The title, big, ready to type into (Enter on the map, or a double-click, puts you here). */
function TitleInput({ value, tick, onChange }: { value: string; tick: number; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const first = useRef(tick);
  useEffect(() => {
    if (tick === first.current) return;
    ref.current?.focus();
    ref.current?.select();
  }, [tick]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="ed-title-input"
      value={value}
      placeholder="Name it"
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Head({ kind, path }: { kind: string; path?: string }) {
  return (
    <div className="ed-kind">
      <span className="ed-chip">{kind}</span>
      {path && <span className="ed-path">{path}</span>}
    </div>
  );
}

/** A bubble's connections: jump to the other end, say why, remove. */
function Connections({ id, ed }: { id: string; ed: Editor }) {
  const { tree, lib } = useStore();
  const links = lib.links
    .filter((l) => l.a === id || l.b === id)
    .map((l) => ({ l, other: tree.get(l.a === id ? l.b : l.a) }))
    .filter((x) => x.other);
  return (
    <Section
      title={`Connections${links.length ? ` · ${links.length}` : ''}`}
      aside={
        <button className="ghost tiny" onClick={() => ed.startConnect(id)}>
          + connect
        </button>
      }
    >
      {links.map(({ l, other }) => (
        <div className="ed-conn" key={l.id}>
          <button className="ed-conn-name" onClick={() => ed.setSel({ link: l.id })} title="Select this connection">
            <span className={`glyph ${other!.type}`} />
            {other!.title}
          </button>
          <button className="icon faint" onClick={() => actions.disconnect(l.id)} aria-label="Remove connection">
            ×
          </button>
          <input
            className="ed-why"
            value={l.note ?? ''}
            placeholder="why they connect"
            onChange={(e) => actions.updateLink(l.id, { note: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
      ))}
      {!links.length && <p className="ed-help">None yet. Drag the dot on the bubble onto another one, or press C.</p>}
    </Section>
  );
}

function Position({ n }: { n: LibNode }) {
  return (
    <Section title="Position">
      {n.pin ? (
        <div className="ed-row">
          <p className="ed-help">Pinned where you put it.</p>
          <button className="pill small" onClick={() => actions.pin(n.id, null)}>
            let it float
          </button>
        </div>
      ) : (
        <p className="ed-help">
          Floats near its topic, drawn toward what it connects to. Drag it into open space on the map to pin it there.
        </p>
      )}
    </Section>
  );
}

function BubblePanel({ n, ed, onRead }: { n: LibNode; ed: Editor; onRead: (id: string) => void }) {
  const { tree } = useStore();
  const topic = n.type === 'topic';
  const path = tree.path(n.parent).map((p) => p.title).join(' / ');
  const kids = topic ? tree.children(n.id) : [];
  const set = (patch: Parameters<typeof actions.update>[1]) => actions.update(n.id, patch);
  const parentTitle = tree.get(n.parent)?.title;

  return (
    <>
      <Head kind={topic ? 'topic' : 'reading'} path={path || undefined} />
      <TitleInput value={n.title} tick={ed.titleTick} onChange={(title) => set({ title })} />

      {n.type === 'article' && (
        <div className="form ed-form">
          <Field label="Authors">
            <input value={n.authors ?? ''} placeholder="Who wrote it" onChange={(e) => set({ authors: e.target.value })} />
          </Field>
          <Field label="Year">
            <input value={n.year ?? ''} placeholder="When" onChange={(e) => set({ year: e.target.value })} />
          </Field>
          <label className="field wide">
            <span>Link</span>
            <input value={n.url ?? ''} placeholder="Where it can be read" onChange={(e) => set({ url: e.target.value })} />
          </label>
        </div>
      )}
      {topic && (
        <Section title="Note">
          <textarea
            className="ed-note"
            rows={2}
            value={n.note ?? ''}
            placeholder="What this topic is about"
            onChange={(e) => set({ note: e.target.value })}
          />
        </Section>
      )}

      <Section title="Lives in">
        <TopicSelect
          value={tree.parentOf(n.id)}
          exclude={topic ? n.id : undefined}
          onChange={(p) => actions.move(n.id, p) && actions.toast(`Moved into “${p ? tree.get(p)?.title : 'the top level'}”`)}
        />
        <p className="ed-help">Or drag it onto a topic on the map, or in the layers list.</p>
      </Section>

      {topic && (
        <Section title={`Inside · ${kids.length}`}>
          <p className="ed-help">
            {kids.filter((k) => k.type === 'topic').length} topics, {kids.filter((k) => k.type === 'article').length} readings
          </p>
          <div className="ed-btns">
            <button className="pill small" onClick={() => ed.newTopic(n.id)}>
              + topic inside
            </button>
            <button className="pill small" onClick={() => ed.addReading(n.id)}>
              + reading inside
            </button>
          </div>
        </Section>
      )}

      {n.type === 'article' && (
        <Section title="Reading">
          <div className="ed-btns">
            <button className="pill small solid" onClick={() => onRead(n.id)}>
              open it
            </button>
            <label className="pill small">
              {n.file ? 'replace PDF…' : 'attach a PDF…'}
              <input
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) (n.file ? replacePdf : attachPdf)(n.id, f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <Toggle
            on={!!n.done}
            label="Completed"
            hint={n.done ? `Checked off ${new Date(n.done).toLocaleDateString()}` : 'Read and annotated'}
            onChange={(on) => set({ done: on ? new Date().toISOString() : undefined })}
          />
          <p className="ed-help">
            {n.highlights.length} marks{n.summary?.trim() ? ', a summary' : ''}
            {n.file ? `, ${n.file.endsWith('.pdf') ? 'a PDF' : 'a saved page'}` : ', no file'}
          </p>
        </Section>
      )}

      <Connections id={n.id} ed={ed} />

      <Section title="Website">
        <Toggle
          on={!n.hidden}
          label="Show it on the website"
          hint={topic ? 'Off hides it and everything inside it.' : undefined}
          onChange={(on) => set({ hidden: !on })}
        />
        {n.type === 'article' && n.file && (
          <Toggle
            on={!!n.share}
            label={`Publish the ${n.file.endsWith('.pdf') ? 'PDF' : 'saved page'} too`}
            hint="Only for open-access material."
            onChange={(share) => set({ share })}
          />
        )}
      </Section>

      <Position n={n} />

      <Confirm
        label={topic ? 'delete topic' : 'delete reading'}
        armedLabel="click again to delete"
        note={topic && kids.length ? `What's inside moves up to “${parentTitle ?? 'the top level'}”.` : undefined}
        onGo={() => {
          ed.setSel(null);
          actions.remove(n.id);
          actions.toast(`Deleted “${n.title}”. Ctrl+Z brings it back.`);
        }}
      />
    </>
  );
}

/** The line from a topic to something inside it. */
function InsideLinePanel({ child, ed }: { child: string; ed: Editor }) {
  const { tree } = useStore();
  const c = tree.get(child)!;
  const parent = tree.parentOf(child)!;
  const p = tree.get(parent)!;
  return (
    <>
      <Head kind="inside" />
      <p className="ed-line-say">
        <button className="ed-link" onClick={() => ed.setSel({ node: child })}>
          {c.title}
        </button>{' '}
        is inside{' '}
        <button className="ed-link" onClick={() => ed.setSel({ node: parent })}>
          {p.title}
        </button>
      </p>
      <Section title="Move it into">
        <TopicSelect
          value={parent}
          exclude={c.type === 'topic' ? child : undefined}
          onChange={(to) => {
            if (actions.move(child, to)) {
              actions.toast(`Moved “${c.title}” into “${to ? tree.get(to)?.title : 'the top level'}”`);
              ed.setSel(to ? { link: `p:${child}` } : { node: child });
            }
          }}
        />
        <p className="ed-help">Or drag the dot at the topic end of the line onto another topic.</p>
      </Section>
      <Section title="In between">
        <div className="ed-btns">
          <button className="pill small" onClick={(e) => ed.insertOn(`p:${child}`, e.clientX, e.clientY)}>
            + topic in between
          </button>
        </div>
        <p className="ed-help">A new topic inside “{p.title}”, with “{c.title}” inside it. Same as the + on the line.</p>
      </Section>
      <Section title="Take it out">
        <div className="ed-btns">
          <button
            className="pill small"
            onClick={() => {
              if (actions.move(child, null)) {
                actions.toast(`“${c.title}” is at the top level now`);
                ed.setSel({ node: child });
              }
            }}
          >
            move to the top level
          </button>
        </div>
      </Section>
    </>
  );
}

/** A connection between two bubbles. */
function ConnectionPanel({ id, ed, api }: { id: string; ed: Editor; api: MutableRefObject<MapView | null> }) {
  const { lib } = useStore();
  const l = lib.links.find((x) => x.id === id)!;
  const relink = (which: 'a' | 'b') => (target: string) => {
    const why = actions.relink(id, which, target);
    if (why) actions.toast(why);
  };
  return (
    <>
      <Head kind="connection" />
      <Section title="Between">
        <div className="ed-ends">
          <BubbleSelect value={l.a} onChange={relink('a')} />
          <span className="ed-ends-mid">and</span>
          <BubbleSelect value={l.b} onChange={relink('b')} />
        </div>
        <p className="ed-help">Or drag either end of the line onto another bubble.</p>
      </Section>
      <Section title="Why they connect">
        <textarea
          className="ed-note"
          rows={3}
          autoFocus={!l.note}
          value={l.note ?? ''}
          placeholder="What one has to do with the other"
          onChange={(e) => actions.updateLink(id, { note: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </Section>
      <Section title="In the middle">
        <div className="ed-btns">
          <button className="pill small" onClick={(e) => ed.insertOn(id, e.clientX, e.clientY)}>
            + bubble in the middle
          </button>
        </div>
        <p className="ed-help">The connection becomes two, through the new bubble. Same as the + on the line.</p>
      </Section>
      <Section title="Go to">
        <div className="ed-btns">
          {[l.a, l.b].map((x) => (
            <button
              key={x}
              className="pill small"
              onClick={() => {
                ed.setSel({ node: x });
                api.current?.frameNode(x);
              }}
            >
              {getState().tree.get(x)?.title}
            </button>
          ))}
        </div>
      </Section>
      <Confirm
        label="remove connection"
        armedLabel="click again to remove"
        onGo={() => {
          ed.setSel(null);
          actions.disconnect(id);
          actions.toast('Connection removed. Ctrl+Z brings it back.');
        }}
      />
    </>
  );
}

const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Nothing selected: the map as a whole. */
function MapPanel({ api }: { api: MutableRefObject<MapView | null> }) {
  const { lib } = useStore();
  const spacing = lib.settings?.spacing ?? 1;
  const pull = lib.settings?.pull ?? 1;
  const pinned = lib.nodes.filter((n) => n.pin).length;
  const topics = lib.nodes.filter((n) => n.type === 'topic').length;
  const [drift, setDrift] = useState(() => {
    try {
      return localStorage.getItem('drift') !== 'off';
    } catch {
      return true;
    }
  });
  const half = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20].find((c) => pullShare(c, pull) >= 0.5);

  return (
    <>
      <Head kind="map" />
      <TitleInput value={lib.title} tick={0} onChange={(t) => actions.setTitle(t)} />
      <p className="ed-help">
        {topics} topics · {lib.nodes.length - topics} readings · {lib.links.length} connections
      </p>

      <Section
        title="Layout"
        aside={
          (spacing !== 1 || pull !== 1) && (
            <button className="ghost tiny" onClick={() => actions.setSettings({ spacing: 1, pull: 1 })}>
              reset
            </button>
          )
        }
      >
        <div className="ed-range">
          <div className="ed-range-top">
            <span>Spacing</span>
            <span className="mono faint">×{spacing.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.05}
            value={spacing}
            onChange={(e) => actions.setSettings({ spacing: Number(e.target.value) })}
          />
          <div className="ed-range-ends">
            <span>tight</span>
            <span>roomy</span>
          </div>
        </div>
        <div className="ed-range">
          <div className="ed-range-top">
            <span>Connection pull</span>
            <span className="mono faint">×{pull.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={pull}
            onChange={(e) => actions.setSettings({ pull: Number(e.target.value) })}
          />
          <div className="ed-range-ends">
            <span>stays home</span>
            <span>pulled far</span>
          </div>
          <p className="ed-help">
            {pull === 0
              ? 'Connections don’t move bubbles: each stays by its topic.'
              : `One connection draws a bubble ${pct(pullShare(1, pull))} of the way from its topic toward what it connects to. ${
                  half ? `${half} take it halfway.` : 'It never gets halfway.'
                } Never past 65%: its topic always holds it most.`}
          </p>
        </div>
      </Section>

      <Section title="Pinned">
        <p className="ed-help">
          {pinned ? `${pinned} bubble${pinned === 1 ? '' : 's'} stay where you put them.` : 'Nothing pinned. Drag a bubble into open space to pin it.'}
        </p>
        {pinned > 0 && (
          <div className="ed-btns">
            <button className="pill small" onClick={() => actions.unpinAll()}>
              let them all float
            </button>
          </div>
        )}
      </Section>

      <Section title="Motion">
        <Toggle
          on={drift}
          label="Drift slowly when idle"
          hint="The map turns on its own after a while untouched."
          onChange={(on) => {
            setDrift(on);
            try {
              localStorage.setItem('drift', on ? 'on' : 'off');
            } catch {
              // private mode
            }
            api.current?.setDrift(on);
          }}
        />
      </Section>

      <Section title="Keys">
        <div className="ed-keys">
          <kbd>T</kbd>
          <span>new topic (inside the selected one)</span>
          <kbd>A</kbd>
          <span>new reading</span>
          <kbd>C</kbd>
          <span>connect the selected bubble</span>
          <kbd>Enter</kbd>
          <span>rename the selected bubble</span>
          <kbd>Del</kbd>
          <span>delete what's selected</span>
          <kbd>F</kbd>
          <span>fit it in view</span>
          <kbd>L</kbd>
          <span>show or hide layers</span>
          <kbd>Ctrl Z</kbd>
          <span>undo (Ctrl Shift Z to redo)</span>
          <kbd>Esc</kbd>
          <span>step back, then leave</span>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- quick add

/** A small box to name a new bubble, right where it's being made. */
function QuickAdd({ spec, onClose }: { spec: QuickSpec; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState(spec.kinds[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onClose]);

  const submit = () => {
    if (!title.trim()) return;
    spec.onSubmit(title.trim(), kind);
    onClose();
  };
  const W = 310;
  return (
    <div
      ref={ref}
      className="ed-quick"
      style={{
        left: Math.max(8, Math.min(spec.x - W / 2, window.innerWidth - W - 8)),
        top: Math.max(8, Math.min(spec.y + 16, window.innerHeight - 170)),
        width: W,
      }}
    >
      <div className="np-label">{spec.label}</div>
      {spec.kinds.length > 1 && (
        <div className="seg small">
          {spec.kinds.map((k) => (
            <button key={k} className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'topic' ? 'Topic' : 'Reading'}
            </button>
          ))}
        </div>
      )}
      <input
        className="np-term-input"
        autoFocus
        value={title}
        placeholder={kind === 'topic' ? 'Name the topic' : 'Title of the reading'}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Tab' && spec.kinds.length > 1) {
            e.preventDefault();
            setKind((k) => spec.kinds[(spec.kinds.indexOf(k) + 1) % spec.kinds.length]);
          }
        }}
      />
      <div className="np-actions">
        <span className="np-hint faint">enter to add{spec.kinds.length > 1 ? ' · tab: topic or reading' : ''}</span>
        <button className="ghost tiny" onClick={onClose}>
          cancel
        </button>
      </div>
    </div>
  );
}
