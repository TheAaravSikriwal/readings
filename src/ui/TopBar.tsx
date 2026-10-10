import { actions, EDITABLE, useStore } from '../store';
import { Edit } from './Edit';

interface Props {
  focus: string | null;
  onGo: (id: string | null) => void;
  onRename: (id: string | null) => void;
  onConnect: (from: string) => void;
}

export function TopBar({ focus, onGo, onRename, onConnect }: Props) {
  const { tree, lib, save } = useStore();
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
    <header className="topbar">
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
      {EDITABLE && (
        <div className={`save ${save}`} title={save === 'error' ? 'Could not save. Is the dev server running?' : ''}>
          {save === 'saved' ? 'saved' : save === 'saving' ? 'saving' : 'not saved'}
        </div>
      )}
    </header>
  );
}
