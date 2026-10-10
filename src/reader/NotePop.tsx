import { useEffect, useRef } from 'react';
import type { Highlight } from '../types';
import { Edit } from '../ui/Edit';

interface Props {
  h: Highlight;
  x: number;
  y: number;
  editable: boolean;
  onChange: (note: string) => void;
  onTerm: (term: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** The note attached to a line, shown right where it is in the text. */
export function NotePop({ h, x, y, editable, onChange, onTerm, onRemove, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLDivElement>(null);
  const isDef = h.kind === 'definition';

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
  // A definition whose passage is the term itself doesn't repeat it as a quote.
  const showQuote = quote && !(isDef && h.term && h.term.trim().toLowerCase() === h.text.trim().toLowerCase());
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
      {showQuote && <blockquote>{quote}</blockquote>}
      {isDef && (
        <div className="np-term">
          <span className="np-label">term</span>
          {editable ? (
            <input
              className="np-term-input"
              value={h.term ?? ''}
              placeholder="The word or phrase"
              autoFocus={!h.term}
              onChange={(e) => onTerm(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  defRef.current?.querySelector('textarea')?.focus();
                }
                if (e.key === 'Escape') onClose();
              }}
            />
          ) : (
            <b>{h.term}</b>
          )}
        </div>
      )}
      {isDef && <span className="np-label">definition</span>}
      {editable ? (
        <div ref={defRef}>
        <Edit
          multiline
          enterFinishes
          className="np-note"
          autoFocus={!isDef || !!h.term}
          value={h.note}
          onChange={onChange}
          onDone={onClose}
          placeholder={isDef ? 'What it means…' : 'Write a note about this line…'}
        />
        </div>
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
