import { useEffect } from 'react';

interface Props {
  x: number;
  y: number;
  onHighlight: () => void;
  onNote: () => void;
  onDismiss: () => void;
}

/** Floats next to a text selection: highlight it (H) or attach a note to it (N). */
export function SelectionPop({ x, y, onHighlight, onNote, onDismiss }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea')) return;
      const k = e.key.toLowerCase();
      if (k === 'h' || k === 'n') {
        e.preventDefault();
        e.stopPropagation();
        (k === 'h' ? onHighlight : onNote)();
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onHighlight, onNote, onDismiss]);

  return (
    <div
      className="selpop"
      style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(Math.max(8, y), window.innerHeight - 50) }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <button onClick={onHighlight}>
        highlight <kbd>H</kbd>
      </button>
      <button onClick={onNote}>
        note <kbd>N</kbd>
      </button>
    </div>
  );
}
