import { useEffect, useRef } from 'react';
import type { Highlight } from '../types';
import { Edit } from '../ui/Edit';

interface Props {
  h: Highlight;
  x: number;
  y: number;
  editable: boolean;
  onChange: (note: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** The note attached to a line, shown right where it is in the text. */
export function NotePop({ h, x, y, editable, onChange, onRemove, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const quote = h.text.length > 240 ? `${h.text.slice(0, 240).trimEnd()}…` : h.text;
  return (
    <div
      ref={ref}
      className="notepop"
      style={{
        left: Math.max(8, Math.min(x - 20, window.innerWidth - 348)),
        top: Math.max(8, Math.min(y + 12, window.innerHeight - 280)),
      }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {quote && <blockquote>{quote}</blockquote>}
      {editable ? (
        <Edit
          multiline
          enterFinishes
          className="np-note"
          autoFocus
          value={h.note}
          onChange={onChange}
          onDone={onClose}
          placeholder="Write a note about this line…"
        />
      ) : (
        <p className="np-note">{h.note || <span className="faint">No note, just highlighted.</span>}</p>
      )}
      <div className="np-actions">
        {editable && <span className="np-hint faint">enter to finish · shift+enter for a new line</span>}
        {editable && (
          <button className="ghost tiny" onClick={onRemove}>
            remove
          </button>
        )}
        <button className="ghost tiny" onClick={onClose}>
          done
        </button>
      </div>
    </div>
  );
}
