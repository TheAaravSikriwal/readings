import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type NoteFile } from '../api';
import { actions } from '../store';

interface Props {
  onClose: () => void;
}

const newId = () => `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const titleOf = (body: string) => body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() || 'Untitled';
const previewOf = (body: string) =>
  body
    .split('\n')
    .filter((l) => l.trim())
    .slice(1)
    .join(' ')
    .replace(/[#*`>_]/g, '')
    .slice(0, 120);
const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString();
};

/** Your own notes, about anything: one Markdown file each, kept in data/notes. */
export function Notes({ onClose }: Props) {
  const [notes, setNotes] = useState<NoteFile[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved');
  const [deleted, setDeleted] = useState<NoteFile | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    api
      .notes()
      .then((ns) => {
        setNotes(ns);
        if (ns.length) setOpenId(ns[0].id);
      })
      .catch(() => setNotes([]));
  }, []);

  const open = notes?.find((n) => n.id === openId) ?? null;

  const save = useCallback((id: string, body: string) => {
    setSaving('saving');
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      window.setTimeout(() => {
        api
          .saveNote(id, body)
          .then(({ updated }) => {
            setNotes((ns) => ns?.map((n) => (n.id === id ? { ...n, updated } : n)) ?? ns);
            setSaving('saved');
          })
          .catch(() => setSaving('error'));
      }, 450),
    );
  }, []);

  // Anything still waiting to be written goes out when the tab closes.
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  const change = (body: string) => {
    if (!open) return;
    setNotes((ns) => ns?.map((n) => (n.id === open.id ? { ...n, body } : n)) ?? ns);
    if (body.trim()) save(open.id, body);
  };

  const create = () => {
    const n: NoteFile = { id: newId(), body: '', updated: new Date().toISOString() };
    setNotes((ns) => [n, ...(ns ?? [])]);
    setOpenId(n.id);
    setEditing(true);
    setQ('');
    requestAnimationFrame(() => area.current?.focus());
  };

  const remove = async (n: NoteFile) => {
    setNotes((ns) => ns?.filter((x) => x.id !== n.id) ?? ns);
    if (openId === n.id) setOpenId(null);
    if (n.body.trim()) {
      await api.deleteNote(n.id).catch(() => actions.toast('Couldn’t delete that note.'));
      setDeleted(n);
    }
  };

  const undoDelete = async () => {
    if (!deleted) return;
    const n = deleted;
    setDeleted(null);
    await api.saveNote(n.id, n.body);
    setNotes((ns) => [n, ...(ns ?? [])]);
    setOpenId(n.id);
  };

  // Keys: Esc leaves the editor, then the tab. N is a new note.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.('input, textarea');
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typing) (e.target as HTMLElement).blur();
        else if (editing) setEditing(false);
        else onClose();
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        create();
      }
      if (e.key === 'Enter' && open) {
        e.preventDefault();
        setEditing(true);
        requestAnimationFrame(() => area.current?.focus());
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (notes ?? []).filter((n) => n.body.trim() || n.id === openId);
    return needle ? list.filter((n) => n.body.toLowerCase().includes(needle)) : list;
  }, [notes, q, openId]);

  return (
    <div className="notes-screen" onKeyDown={(e) => e.stopPropagation()}>
      <header className="r-head">
        <button className="ghost" onClick={onClose}>
          ← map
        </button>
        <div className="r-title">
          <span>Notes</span>
          <span className="faint">Yours alone: kept on this computer, never on the website.</span>
        </div>
        <div className="r-tools">
          <span className={`faint notes-status ${saving}`}>
            {saving === 'saving' ? 'saving…' : saving === 'error' ? 'not saved' : 'saved'}
          </span>
          <button className="pill solid small" onClick={create}>
            + new note <kbd>N</kbd>
          </button>
        </div>
      </header>

      <div className="notes-body">
        <aside className="notes-list">
          {(notes?.length ?? 0) > 6 && (
            <input className="gloss-search" value={q} placeholder="Find in your notes…" onChange={(e) => setQ(e.target.value)} />
          )}
          {shown.map((n) => (
            <button
              key={n.id}
              className={`note-row ${n.id === openId ? 'on' : ''}`}
              onClick={() => {
                setOpenId(n.id);
                setEditing(false);
              }}
            >
              <span className="note-row-title">{n.body.trim() ? titleOf(n.body) : 'New note'}</span>
              <span className="note-row-meta">
                <span className="mono">{when(n.updated)}</span> {previewOf(n.body)}
              </span>
            </button>
          ))}
          {notes && !shown.length && <p className="faint pad">{q ? 'Nothing matches.' : 'No notes yet.'}</p>}
          {deleted && (
            <div className="note-undo">
              Deleted “{titleOf(deleted.body)}”.{' '}
              <button className="ghost tiny" onClick={undoDelete}>
                undo
              </button>
            </div>
          )}
        </aside>

        <main className="note-pane">
          {open ? (
            <>
              <div className="note-tools">
                <span className="faint mono">{when(open.updated)}</span>
                <button
                  className={`ghost tiny ${editing ? 'on' : ''}`}
                  onClick={() => {
                    setEditing(!editing);
                    if (!editing) requestAnimationFrame(() => area.current?.focus());
                  }}
                >
                  {editing ? 'done' : 'edit'}
                </button>
                <button className="ghost tiny" onClick={() => remove(open)}>
                  delete
                </button>
              </div>
              {editing || !open.body.trim() ? (
                <textarea
                  ref={area}
                  className="note-editor"
                  value={open.body}
                  placeholder={'Title on the first line\n\nThen anything. # headings, **bold**, *italics*, - lists and [links](https://…) show when you’re done.'}
                  onChange={(e) => change(e.target.value)}
                  autoFocus={editing}
                />
              ) : (
                <article
                  className="note-read"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a')) return;
                    setEditing(true);
                    requestAnimationFrame(() => area.current?.focus());
                  }}
                  title="Click to edit"
                  dangerouslySetInnerHTML={{ __html: markdown(open.body) }}
                />
              )}
            </>
          ) : (
            <div className="note-empty">
              <p>{notes === null ? 'Opening your notes…' : 'Pick a note, or start one.'}</p>
              {notes !== null && (
                <button className="pill" onClick={create}>
                  + new note
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a little Markdown

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string) {
  return escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
}

/** Headings, paragraphs, lists (nested, with paragraphs inside), quotes, code blocks and rules: enough for notes. */
function markdown(src: string) {
  const out: string[] = [];
  const lines = src.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
  const LI = /^(\s*)(?:[-*]|(\d+)[.)])\s+(.*)$/;
  const indentOf = (l: string) => l.match(/^\s*/)![0].length;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flushPara();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(l)) {
      flushPara();
      out.push('<hr>');
      continue;
    }
    const q = l.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }
    if (LI.test(l)) {
      flushPara();
      // The whole list: its items, anything indented under them, and blank lines between.
      const items: { indent: number; ordered: boolean; parts: string[] }[] = [];
      for (; i < lines.length; i++) {
        const cur = lines[i];
        const m = cur.match(LI);
        if (m) {
          items.push({ indent: m[1].length, ordered: !!m[2], parts: [m[3]] });
          continue;
        }
        if (!cur.trim()) {
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next && (LI.test(next) || indentOf(next) >= 2)) {
            items.at(-1)!.parts.push('');
            continue;
          }
          break;
        }
        if (indentOf(cur) >= 2) {
          items.at(-1)!.parts.push(cur.trim());
          continue;
        }
        break;
      }
      i--;
      out.push(listHtml(items));
      continue;
    }
    if (!l.trim()) {
      flushPara();
      continue;
    }
    para.push(l);
  }
  flushPara();
  return out.join('\n');
}

/** Nested lists from indentation. An item's later lines, after a blank one, are a paragraph inside it. */
function listHtml(items: { indent: number; ordered: boolean; parts: string[] }[]) {
  let html = '';
  const stack: { indent: number; tag: 'ul' | 'ol' }[] = [];
  const body = (parts: string[]) =>
    parts
      .join('\n')
      .trim()
      .split(/\n\n+/)
      .map((p) => p.split('\n').map(inline).join('<br>'))
      .join('</p><p>');
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (stack.length && it.indent < stack.at(-1)!.indent) html += `</li></${stack.pop()!.tag}>`;
    const top = stack.at(-1);
    if (!top || it.indent > top.indent) {
      html += `<${tag}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      html += '</li>';
      if (top.tag !== tag) {
        html += `</${top.tag}><${tag}>`;
        top.tag = tag;
      }
    }
    const text = body(it.parts);
    html += text.includes('</p><p>') ? `<li><p>${text}</p>` : `<li>${text}`;
  }
  while (stack.length) html += `</li></${stack.pop()!.tag}>`;
  return html;
}
