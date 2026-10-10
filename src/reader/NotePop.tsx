import { useEffect, useRef } from 'react';
import { isQuestion } from '../notes';
import type { Highlight } from '../types';
import { Edit } from '../ui/Edit';

interface Props {
  h: Highlight;
  x: number;
  y: number;
  editable: boolean;
  onChange: (note: string) => void;
  onTerm: (term: string) => void;
  onCite: (cite: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** The note attached to a line, shown right where it is in the text. */
export function NotePop({ h, x, y, editable, onChange, onTerm, onCite, onRemove, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLDivElement>(null);
  const isDef = h.kind === 'definition';
  const isRef = h.kind === 'reference';
  const focusNote = () => defRef.current?.querySelector('textarea')?.focus();

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
  const same = (a = '', b = '') => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
  const showQuote = quote && !(isDef && same(h.term, h.text)) && !(isRef && (!h.cite || h.text.includes(h.cite.slice(0, 40))));
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
                  focusNote();
                }
                if (e.key === 'Escape') onClose();
              }}
            />
          ) : (
            <b>{h.term}</b>
          )}
        </div>
      )}
      {isRef && (
        <div className="np-term">
          <span className="np-label">reference</span>
          {editable ? (
            <textarea
              className="np-term-input np-cite"
              rows={Math.min(4, Math.max(1, Math.ceil((h.cite?.length ?? 0) / 46)))}
              value={h.cite ?? ''}
              placeholder="The work it cites, e.g. Vaswani et al. 2017, Attention Is All You Need"
              autoFocus={!h.cite}
              onChange={(e) => onCite(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  focusNote();
                }
                if (e.key === 'Escape') onClose();
              }}
            />
          ) : (
            <b className="np-cite">{h.cite}</b>
          )}
        </div>
      )}
      {isDef && <span className="np-label">definition</span>}
      {isRef && <span className="np-label">why follow it</span>}
      {editable ? (
        <div ref={defRef}>
        <Edit
          multiline
          enterFinishes
          className="np-note"
          autoFocus={isDef ? !!h.term : isRef ? !!h.cite : true}
          value={h.note}
          onChange={onChange}
          onDone={onClose}
          placeholder={
            isDef
              ? 'What it means…'
              : isRef
                ? 'What it backs up here, or just press Enter…'
                : h.kind === 'note' ? 'Write a note about this line…' : 'Add a note, or just press Enter…'
          }
        />
        </div>
      ) : (
        <p className="np-note">{h.note || <span className="faint">{isRef ? '' : 'No note, just highlighted.'}</span>}</p>
      )}
      <div className="np-actions">
        {isQuestion(h) && <span className="q-label">question</span>}
        {editable && (
          <span className="np-hint faint">
            {isDef && !h.term
              ? 'enter to go to the definition'
              : isRef && !h.cite
                ? 'enter to go to the note'
                : isQuestion(h)
                  ? 'enter to finish' // the question label takes the room
                  : 'enter to finish · shift+enter for a new line'}
          </span>
        )}
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
