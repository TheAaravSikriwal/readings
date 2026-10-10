import { useEffect, useState } from 'react';
import { actions, useStore } from '../store';

export type MenuAction = 'open' | 'read' | 'rename' | 'add' | 'new-topic' | 'connect' | 'move';

interface Props {
  id: string;
  x: number;
  y: number;
  onAction: (a: MenuAction) => void;
  onClose: () => void;
}

export function ContextMenu({ id, x, y, onAction, onClose }: Props) {
  const { tree } = useStore();
  const [arm, setArm] = useState(false);
  const n = tree.get(id);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('wheel', close);
    };
  }, [onClose]);

  if (!n) return null;
  const topic = n.type === 'topic';
  const item = (label: string, fn: () => void, cls = '') => (
    <button className={`mi ${cls}`} onClick={fn}>
      {label}
    </button>
  );
  const run = (a: MenuAction) => () => {
    onAction(a);
    onClose();
  };

  return (
    <div
      className="menu"
      style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 300) }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-title">{n.title}</div>
      {item(topic ? 'Open' : 'Show', run('open'))}
      {!topic && item('Read', run('read'))}
      {item('Rename', run('rename'))}
      {topic && item('Add material here', run('add'))}
      {topic && item('New topic inside', run('new-topic'))}
      {item('Connect to…', run('connect'))}
      {item('Move to…', run('move'))}
      {item(n.hidden ? 'Show on website' : 'Hide from website', () => {
        actions.update(id, { hidden: !n.hidden });
        onClose();
      })}
      <div className="menu-sep" />
      {item(
        arm ? (topic ? 'Click again. Its contents move up' : 'Click again to delete') : 'Delete',
        () => {
          if (!arm) return setArm(true);
          actions.remove(id);
          onClose();
        },
        'danger',
      )}
    </div>
  );
}
