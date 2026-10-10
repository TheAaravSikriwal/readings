import { useEffect } from 'react';

export type MarkMode = 'highlight' | 'note' | 'definition' | 'reference' | 'heading';

interface Props {
  x: number;
  y: number;
  onPick: (mode: MarkMode) => void;
  onDismiss: () => void;
}

const KEYS: Record<string, MarkMode> = { h: 'highlight', n: 'note', d: 'definition', r: 'reference', t: 'heading' };

/** Floats next to a text selection: highlight it (H), attach a note to it (N),
 * save it as a term and its definition (D), or log it as a reference to read (R). */
export function SelectionPop({ x, y, onPick, onDismiss }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea')) return;
      const mode = KEYS[e.key.toLowerCase()];
      if (mode && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        onPick(mode);
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onPick, onDismiss]);

  return (
    <div
      className="selpop"
      style={{ left: Math.min(x, window.innerWidth - 480), top: Math.min(Math.max(8, y), window.innerHeight - 50) }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <button onClick={() => onPick('highlight')}>
        highlight <kbd>H</kbd>
      </button>
      <button onClick={() => onPick('note')}>
        note <kbd>N</kbd>
      </button>
      <button onClick={() => onPick('definition')}>
        define <kbd>D</kbd>
      </button>
      <button onClick={() => onPick('reference')}>
        reference <kbd>R</kbd>
      </button>
      <button onClick={() => onPick('heading')} title="Add it to the contents, as a heading">
        heading <kbd>T</kbd>
      </button>
    </div>
  );
}
