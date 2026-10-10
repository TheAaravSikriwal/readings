import { actions, EDITABLE, useStore } from '../store';
import { Edit } from './Edit';

interface Props {
  focus: string | null;
  onGo: (id: string | null) => void;
  onRename: (id: string | null) => void;
}

export function TopBar({ focus, onGo, onRename }: Props) {
  const { tree, lib, save } = useStore();
  const trail = tree.path(focus);
  const here = tree.get(focus);

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
          value={here.note}
          onChange={(note) => actions.update(here.id, { note })}
          placeholder="A note about this topic…"
        />
      )}
      {EDITABLE && (
        <div className={`save ${save}`} title={save === 'error' ? 'Could not save. Is the dev server running?' : ''}>
          {save === 'saved' ? 'saved' : save === 'saving' ? 'saving' : 'not saved'}
        </div>
      )}
    </header>
  );
}
