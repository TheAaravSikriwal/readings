import { useEffect, useRef } from 'react';
import type { Bookmark } from '../types';

/** Where a bookmark is, in a few characters: its page, or how far through a web page. */
export const bookmarkPlace = (b: Pick<Bookmark, 'p' | 'y'>) =>
  b.p !== undefined ? `p. ${b.p + 1}` : `${Math.round(b.y * 100)}%`;

interface Props {
  b: Bookmark;
  x: number;
  y: number;
  editable: boolean;
  onLabel: (label: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** A bookmark's label, right where the ribbon is. Enter or Esc finishes. */
export function BookmarkPop({ b, x, y, editable, onLabel, onRemove, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest?.('.bm')) onClose();
    };
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

  return (
    <div
      ref={ref}
      className="notepop bmpop"
      style={{
        left: Math.max(8, Math.min(x - 300, window.innerWidth - 348)),
        top: Math.max(8, Math.min(y + 10, window.innerHeight - 170)),
      }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="bm-head">
        <span className="bm-glyph" />
        <span className="np-label">bookmark · {bookmarkPlace(b)}</span>
      </div>
      {editable ? (
        <input
          className="np-term-input"
          autoFocus
          value={b.label}
          placeholder="Label it, or just press Enter"
          onChange={(e) => onLabel(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
      ) : (
        <p className="np-note">{b.label}</p>
      )}
      <div className="np-actions">
        {editable && <span className="np-hint faint">enter to finish</span>}
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
