import { useMemo, useRef } from 'react';
import { attachPdf, replacePdf } from '../importer';
import { citeLink, referenceList, scholarUrl } from '../notes';
import { actions, EDITABLE, useStore } from '../store';
import { Edit } from './Edit';

interface Props {
  id: string;
  onRead: () => void;
  onConnect: () => void;
  onOpen: (id: string) => void;
  /** Open the reader at one of this reading's marks. */
  onReadAt: (highlightId: string) => void;
  onAddReference: (articleId: string, highlightId: string) => void;
  onClose: () => void;
}

export const CARD_WIDTH = 360;

/** The article panel that slides in when you click a pearl. */
export function Card({ id, onRead, onConnect, onOpen, onReadAt, onAddReference, onClose }: Props) {
  const { tree, lib, rev, pending } = useStore();
  const a = tree.article(id);
  const refs = useMemo(() => referenceList(lib, id), [lib, rev, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const picker = useRef<HTMLInputElement>(null);
  if (!a) return null;

  const links = lib.links
    .filter((l) => l.a === id || l.b === id)
    .map((l) => ({ link: l, other: tree.get(l.a === id ? l.b : l.a) }))
    .filter((x) => x.other);
  const where = tree.path(a.parent).map((n) => n.title).join(' / ');
  const set = (patch: Parameters<typeof actions.update>[1]) => actions.update(id, patch);
  const busy = pending.has(id);

  return (
    <aside className="card" style={{ width: CARD_WIDTH }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="card-top">
        <span className="eyebrow">{where || lib.title}</span>
        <button className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <Edit className="card-title" multiline value={a.title} onChange={(title) => set({ title })} placeholder="Title" />
      {EDITABLE ? (
        <div className="card-meta">
          <Edit value={a.authors} onChange={(authors) => set({ authors })} placeholder="Authors" />
          <span className="dot">·</span>
          <Edit value={a.year} onChange={(year) => set({ year })} placeholder="Year" />
        </div>
      ) : (
        <div className="card-meta">{[a.authors, a.year].filter(Boolean).join(' · ')}</div>
      )}
      {EDITABLE ? (
        <div className="card-link">
          <Edit value={a.url} onChange={(url) => set({ url })} placeholder="Link" />
          {a.url && (
            <a href={a.url} target="_blank" rel="noreferrer" aria-label="Open link">
              ↗
            </a>
          )}
        </div>
      ) : (
        a.url && (
          <a className="card-link" href={a.url} target="_blank" rel="noreferrer">
            {a.site || 'source'} ↗
          </a>
        )
      )}

      <div className="card-actions">
        <button className="pill solid" onClick={onRead} disabled={busy}>
          {busy ? 'working…' : 'read'}
          {a.highlights.length > 0 && <span className="count">{a.highlights.length}</span>}
        </button>
        {EDITABLE ? (
          <button
            className={`pill done-pill ${a.done ? 'on' : ''}`}
            onClick={() => set({ done: a.done ? undefined : new Date().toISOString() })}
            title={a.done ? 'Click to undo' : 'Check it off when you’ve read and annotated it'}
          >
            <span className="done-box" />
            {a.done ? 'completed' : 'complete'}
          </button>
        ) : (
          a.done && (
            <span className="done-note">
              <span className="done-box on" /> finished
            </span>
          )
        )}
      </div>
      {a.done && EDITABLE && <p className="done-when faint">Completed {new Date(a.done).toLocaleDateString()}</p>}

      {EDITABLE && (
        <div className="card-file">
          <span className="faint">
            {a.file ? (a.file.endsWith('.pdf') ? 'PDF attached.' : 'A saved copy of the page.') : 'No file attached.'}
          </span>
          <button className="ghost tiny" onClick={() => picker.current?.click()} disabled={busy}>
            {a.file ? 'replace with another PDF…' : 'attach a PDF…'}
          </button>
          <input
            ref={picker}
            type="file"
            accept="application/pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) (a.file ? replacePdf : attachPdf)(id, f);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {EDITABLE && a.file && (
        <label className="share">
          <input type="checkbox" checked={!!a.share} onChange={(e) => set({ share: e.target.checked })} />
          <span>
            Publish the {a.file.endsWith('.pdf') ? 'PDF' : 'saved page'} too
            <span className="faint">
              {' '}
              Only if it’s open access (for example CC BY). Otherwise the site shows your notes and links to the source.
            </span>
          </span>
        </label>
      )}

      <section>
        <h4>Summary</h4>
        <Edit multiline value={a.summary} onChange={(summary) => set({ summary })} placeholder="The point, in your words…" />
        {!EDITABLE && !a.summary && <p className="faint">—</p>}
      </section>

      {refs.length > 0 && (
        <section className="card-refs">
          <h4>
            References <span className="faint">{refs.length}</span>
          </h4>
          {refs.map((r) => {
            const src = r.sources[0];
            const link = citeLink(r.cite);
            return (
              <div key={r.key} className="card-ref">
                <button className="ref-cite" onClick={() => onReadAt(src.highlightId)} title="Show it in the text">
                  {r.cite}
                </button>
                <div className="ref-actions">
                  {r.onMap ? (
                    <button className="ghost tiny" onClick={() => onOpen(r.onMap!)}>
                      on the map →
                    </button>
                  ) : (
                    EDITABLE && (
                      <button className="ghost tiny" onClick={() => onAddReference(id, src.highlightId)}>
                        + add to map
                      </button>
                    )
                  )}
                  <a className="ghost tiny" href={link ?? scholarUrl(r.cite)} target="_blank" rel="noreferrer">
                    {link ? 'open ↗' : 'find ↗'}
                  </a>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section>
        <h4>Connections</h4>
        {links.map(({ link, other }) => (
          <div className="conn" key={link.id}>
            <button className="conn-name" onClick={() => onOpen(other!.id)}>
              <span className={`glyph ${other!.type}`} />
              {other!.title}
            </button>
            <Edit value={link.note} onChange={(note) => actions.updateLink(link.id, { note })} placeholder="why?" />
            {EDITABLE && (
              <button className="icon faint" onClick={() => actions.disconnect(link.id)} aria-label="Remove connection">
                ×
              </button>
            )}
          </div>
        ))}
        {!links.length && !EDITABLE && <p className="faint">—</p>}
        {EDITABLE && (
          <button className="ghost" onClick={onConnect}>
            + connect <span className="faint">or shift-click a bubble</span>
          </button>
        )}
      </section>
    </aside>
  );
}
