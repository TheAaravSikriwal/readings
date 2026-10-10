import { useEffect, useRef, useState } from 'react';
import { bookmarkPlace } from '../reader/BookmarkPop';
import { actions, EDITABLE, useStore } from '../store';
import type { Article } from '../types';
import { Edit } from './Edit';

interface Props {
  focus: string | null;
  onGo: (id: string | null) => void;
  onRename: (id: string | null) => void;
  onConnect: (from: string) => void;
  onReadBookmark: (articleId: string, bookmarkId: string) => void;
}

export function TopBar({ focus, onGo, onRename, onConnect, onReadBookmark }: Props) {
  const { tree, lib, save } = useStore();
  const [openPin, setOpenPin] = useState<string | null>(null);
  // The panels in the bottom corner stop below whatever the top bar shows.
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty('--top-h', `${Math.round(el.getBoundingClientRect().bottom)}px`),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Readings with bookmarks are pinned here, the one you marked last first.
  const latest = (a: Article) => (a.bookmarks ?? []).reduce((m, b) => (b.created > m.created ? b : m));
  const pinned = lib.nodes
    .filter((n): n is Article => n.type === 'article' && !!n.bookmarks?.length)
    .sort((x, y) => latest(y).created.localeCompare(latest(x).created));
  const trail = tree.path(focus);
  const here = tree.get(focus);
  // The topic you're in can connect to anything, like a reading can.
  const links = here
    ? lib.links
        .filter((l) => l.a === here.id || l.b === here.id)
        .map((l) => ({ link: l, other: tree.get(l.a === here.id ? l.b : l.a) }))
        .filter((x) => x.other)
    : [];

  return (
    <header className="topbar" ref={bar}>
      <nav className="crumbs">
        <button
          className={`crumb ${!focus ? 'here' : ''}`}
          onClick={() => onGo(null)}
          onDoubleClick={() => EDITABLE && onRename(null)}
          title={EDITABLE ? 'Double-click to rename' : undefined}
        >
          {lib.title}
        </button>
        {trail.map((n) => (
          <span key={n.id} className="crumb-wrap">
            <span className="sep">/</span>
            <button
              className={`crumb ${n.id === focus ? 'here' : ''}`}
              onClick={() => onGo(n.id)}
              onDoubleClick={() => EDITABLE && onRename(n.id)}
            >
              {n.title}
            </button>
          </span>
        ))}
      </nav>
      {here?.type === 'topic' && (
        <Edit
          className="topic-note"
          multiline
          enterFinishes
          value={here.note}
          onChange={(note) => actions.update(here.id, { note })}
          placeholder="A note about this topic…"
        />
      )}
      {here?.type === 'topic' && (links.length > 0 || EDITABLE) && (
        <div className="topic-links">
          {links.length > 0 && <span className="faint">connected to</span>}
          {links.map(({ link, other }) => (
            <span key={link.id} className="topic-link" title={link.note || undefined}>
              <button className="topic-link-name" onClick={() => onGo(other!.id)}>
                <span className={`glyph ${other!.type}`} />
                {other!.title}
              </button>
              {EDITABLE && (
                <button className="icon faint" onClick={() => actions.disconnect(link.id)} aria-label="Remove connection">
                  ×
                </button>
              )}
            </span>
          ))}
          {EDITABLE && (
            <button className="ghost tiny" onClick={() => onConnect(here.id)}>
              + connect <span className="faint">or shift-click a bubble</span>
            </button>
          )}
        </div>
      )}
      {pinned.length > 0 && (
        <div className="pins">
          {pinned.map((a) => {
            const last = latest(a);
            const all = [...a.bookmarks!].sort((x, y) => (x.p ?? 0) - (y.p ?? 0) || x.y - y.y);
            return (
              <span key={a.id} className={`pin ${openPin === a.id ? 'open' : ''}`}>
                <button
                  className="pin-main"
                  onClick={() => onReadBookmark(a.id, last.id)}
                  title={`Back to ${last.label ? `“${last.label}”` : bookmarkPlace(last)} in ${a.title}`}
                >
                  <span className="bm-glyph" />
                  <span className="pin-title">{a.title}</span>
                  <span className="faint mono">{bookmarkPlace(last)}</span>
                </button>
                {all.length > 1 && (
                  <button
                    className="pin-more"
                    onClick={() => setOpenPin(openPin === a.id ? null : a.id)}
                    aria-label={`All ${all.length} bookmarks`}
                  >
                    {all.length}
                  </button>
                )}
                {openPin === a.id && (
                  <div className="pin-list" onMouseLeave={() => setOpenPin(null)}>
                    {all.map((b) => (
                      <button key={b.id} onClick={() => onReadBookmark(a.id, b.id)}>
                        <span className="mono faint">{bookmarkPlace(b)}</span>
                        <span>{b.label || <span className="faint">no label</span>}</span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            );
          })}
        </div>
      )}
      {EDITABLE && (
        <div className={`save ${save}`} title={save === 'error' ? 'Could not save. Is the dev server running?' : ''}>
          {save === 'saved' ? 'saved' : save === 'saving' ? 'saving' : 'not saved'}
        </div>
      )}
    </header>
  );
}
