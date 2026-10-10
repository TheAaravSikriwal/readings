import { useMemo, useState } from 'react';
import { glossary, type GlossarySource } from '../notes';
import { useStore } from '../store';

interface Props {
  open: boolean;
  onToggle: () => void;
  onOpenSource: (source: GlossarySource) => void;
}

/** Every term defined in every reading, one entry per term, on the map. */
export function Glossary({ open, onToggle, onOpenSource }: Props) {
  const { lib, rev } = useStore();
  const entries = useMemo(() => glossary(lib), [lib, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (e) => e.term.toLowerCase().includes(needle) || e.defs.some((d) => d.text.toLowerCase().includes(needle)),
    );
  }, [entries, q]);

  if (!entries.length) return null;

  if (!open) {
    return (
      <button className="gloss-tab" onClick={onToggle} title="Every term you've defined">
        glossary <span className="faint">{entries.length}</span>
      </button>
    );
  }

  let letter = '';
  return (
    <aside className="gloss" onKeyDown={(e) => e.stopPropagation()}>
      <div className="gloss-head">
        <h4>
          Glossary <span className="faint">{entries.length}</span>
        </h4>
        <button className="icon" onClick={onToggle} aria-label="Close the glossary">
          ×
        </button>
      </div>
      {entries.length > 6 && (
        <input className="gloss-search" value={q} placeholder="Find a term…" onChange={(e) => setQ(e.target.value)} />
      )}
      <div className="gloss-list">
        {shown.map((e) => {
          const first = e.term[0]?.toUpperCase() ?? '';
          const head = first !== letter ? (letter = first) : null;
          return (
            <div key={e.key}>
              {head && entries.length > 12 && <div className="gloss-letter">{head}</div>}
              <div className="gloss-entry">
                <div className="gloss-term">{e.term}</div>
                {e.defs.map((d, i) => (
                  <div key={i} className="gloss-def">
                    <p title={d.text.length > 180 ? d.text : undefined}>
                      {d.text || <span className="faint">No definition written yet.</span>}
                    </p>
                    <div className="gloss-src">
                      {d.sources.map((s) => (
                        <button key={s.highlightId} onClick={() => onOpenSource(s)}>
                          {s.title}
                          {s.year ? ` (${s.year})` : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {!shown.length && <p className="faint">Nothing matches.</p>}
      </div>
    </aside>
  );
}
