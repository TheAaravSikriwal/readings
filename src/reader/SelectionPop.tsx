import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
  // Next to where the selection ends, but kept over the page: not under the
  // notes beside it, and not off the edge of the screen.
  const el = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const w = el.current?.offsetWidth ?? 440;
    const h = el.current?.offsetHeight ?? 36;
    const area = document.querySelector('.reader .r-doc')?.getBoundingClientRect();
    const lo = (area?.left ?? 0) + 8;
    const hi = (area?.right ?? window.innerWidth) - w - 8;
    setAt({ left: Math.max(lo, Math.min(x, hi)), top: Math.min(Math.max(8, y), window.innerHeight - h - 8) });
  }, [x, y]);

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
      ref={el}
      style={at ?? { left: x, top: y, visibility: 'hidden' }}
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
