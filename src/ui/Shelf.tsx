import { useMemo, useState } from 'react';
import { citeLink, scholarUrl, type GlossaryEntry, type ReferenceEntry } from '../notes';
import { EDITABLE } from '../store';

export type ShelfPart = 'glossary' | 'references';

interface Source {
  articleId: string;
  highlightId: string;
}

interface Props {
  terms: GlossaryEntry[];
  refs: ReferenceEntry[];
  open: Record<ShelfPart, boolean>;
  onToggle: (part: ShelfPart) => void;
  /** Open the reader at a definition or a reference. */
  onOpenSource: (source: Source) => void;
  onAddReference: (articleId: string, highlightId: string) => void;
  /** Go to a reading on the map (a reference that is already there). */
  onShow: (id: string) => void;
}

/** The map's corner: every term you've defined and every reference you've
 * logged, each its own section that you can put away. */
export function Shelf({ terms, refs, open, onToggle, onOpenSource, onAddReference, onShow }: Props) {
  const parts: { part: ShelfPart; label: string; count: number; title: string }[] = [
    { part: 'glossary', label: 'glossary', count: terms.length, title: "Every term you've defined" },
    { part: 'references', label: 'references', count: refs.length, title: 'Every reference you’ve logged: what to read next' },
  ];
  const present = parts.filter((p) => p.count > 0);
  if (!present.length) return null;
  const closed = present.filter((p) => !open[p.part]);

  return (
    <div className="shelf" onKeyDown={(e) => e.stopPropagation()}>
      {open.glossary && terms.length > 0 && (
        <GlossaryPanel entries={terms} onClose={() => onToggle('glossary')} onOpenSource={onOpenSource} />
      )}
      {open.references && refs.length > 0 && (
        <ReferencePanel
          entries={refs}
          onClose={() => onToggle('references')}
          onOpenSource={onOpenSource}
          onAdd={onAddReference}
          onShow={onShow}
        />
      )}
      {closed.length > 0 && (
        <div className="shelf-tabs">
          {closed.map((p) => (
            <button key={p.part} className="gloss-tab" onClick={() => onToggle(p.part)} title={p.title}>
              {p.label} <span className="faint">{p.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PanelHead({ title, count, onClose }: { title: string; count: number; onClose: () => void }) {
  return (
    <div className="gloss-head">
      <h4>
        {title} <span className="faint">{count}</span>
      </h4>
      <button className="icon" onClick={onClose} aria-label={`Hide the ${title.toLowerCase()}`}>
        ×
      </button>
    </div>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input className="gloss-search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Every term defined in every reading, one entry per term. */
function GlossaryPanel({
  entries,
  onClose,
  onOpenSource,
}: {
  entries: GlossaryEntry[];
  onClose: () => void;
  onOpenSource: (s: Source) => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (e) => e.term.toLowerCase().includes(needle) || e.defs.some((d) => d.text.toLowerCase().includes(needle)),
    );
  }, [entries, q]);

  let letter = '';
  return (
    <aside className="gloss">
      <PanelHead title="Glossary" count={entries.length} onClose={onClose} />
      {entries.length > 6 && <Search value={q} onChange={setQ} placeholder="Find a term…" />}
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

/** Every reference logged in every reading, one entry per cited work: still to
 * read first, then the ones already on the map. */
function ReferencePanel({
  entries,
  onClose,
  onOpenSource,
  onAdd,
  onShow,
}: {
  entries: ReferenceEntry[];
  onClose: () => void;
  onOpenSource: (s: Source) => void;
  onAdd: (articleId: string, highlightId: string) => void;
  onShow: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (e) =>
        e.cite.toLowerCase().includes(needle) ||
        e.sources.some((s) => s.title.toLowerCase().includes(needle) || s.note.toLowerCase().includes(needle)),
    );
  }, [entries, q]);
  const toRead = entries.filter((e) => !e.onMap).length;
  const split = toRead > 0 && toRead < entries.length;

  return (
    <aside className="gloss refs-panel">
      <PanelHead title="References" count={entries.length} onClose={onClose} />
      {entries.length > 6 && <Search value={q} onChange={setQ} placeholder="Find a reference…" />}
      <div className="gloss-list">
        {shown.map((e, i) => {
          const link = citeLink(e.cite);
          const notes = e.sources.map((s) => s.note).filter(Boolean);
          const first = e.sources[0];
          return (
            <div key={e.key}>
              {split && !q && i === toRead && <div className="gloss-letter">ALREADY ON THE MAP</div>}
              <div className={`gloss-entry ref-entry ${e.onMap ? 'mapped' : ''}`}>
                <p className="ref-text" title={e.cite.length > 160 ? e.cite : undefined}>
                  {e.cite}
                </p>
                {notes.map((n, k) => (
                  <p key={k} className="ref-why">
                    {n}
                  </p>
                ))}
                <div className="gloss-src">
                  <span className="faint">cited in</span>
                  {e.sources.map((s) => (
                    <button key={s.highlightId} onClick={() => onOpenSource(s)}>
                      {s.title}
                      {s.page !== undefined ? `, p. ${s.page + 1}` : ''}
                    </button>
                  ))}
                </div>
                <div className="ref-actions">
                  {e.onMap ? (
                    <button className="ghost tiny" onClick={() => onShow(e.onMap!)}>
                      on the map →
                    </button>
                  ) : (
                    EDITABLE && (
                      <button className="ghost tiny" onClick={() => onAdd(first.articleId, first.highlightId)}>
                        + add to map
                      </button>
                    )
                  )}
                  <a className="ghost tiny" href={link ?? scholarUrl(e.cite)} target="_blank" rel="noreferrer">
                    {link ? 'open ↗' : 'find ↗'}
                  </a>
                </div>
              </div>
            </div>
          );
        })}
        {!shown.length && <p className="faint">Nothing matches.</p>}
      </div>
    </aside>
  );
}
