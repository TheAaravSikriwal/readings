import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FetchResult } from '../api';
import { fetchInto, looksLikeUrl, nameOf, shortUrl } from '../importer';
import { actions, uid, useStore } from '../store';

type Mode = 'pdf' | 'link' | 'none';

interface Fields {
  title: string;
  authors: string;
  year: string;
  site: string;
  url: string;
  summary: string;
}

const BLANK: Fields = { title: '', authors: '', year: '', site: '', url: '', summary: '' };

export interface AddSeed {
  file?: File;
  url?: string;
  topic?: string | null;
  /** Details known up front (from a citation), which anything fetched replaces. */
  fields?: Partial<Fields>;
  /** Added from a reference: the reading that cites it. */
  cites?: { articleId: string; highlightId: string; title: string };
}

interface Props {
  seed: AddSeed;
  topic: string | null;
  /** A PDF dropped on the window while this sheet is open. */
  dropped: { file: File; n: number } | null;
  onClose: () => void;
  onAdded: (id: string) => void;
}

const MODES: { mode: Mode; title: string; hint: string }[] = [
  { mode: 'pdf', title: 'PDF', hint: 'Upload or drop a file' },
  { mode: 'link', title: 'Link', hint: 'Web page, DOI or arXiv' },
  { mode: 'none', title: 'No file', hint: 'A book, a talk, anything' },
];

/** One place to add any reading: pick the kind, fill in (or confirm) the details, add. */
export function AddMaterial({ seed, topic: here, dropped, onClose, onAdded }: Props) {
  const { tree, lib } = useStore();
  const id = useMemo(() => uid('a'), []);
  const [mode, setMode] = useState<Mode | null>(seed.file ? 'pdf' : seed.url ? 'link' : seed.fields ? 'none' : null);
  const [file, setFile] = useState<File | null>(seed.file ?? null);
  const [link, setLink] = useState(seed.url ?? '');
  const [f, setF] = useState<Fields>(() => ({ ...BLANK, ...seed.fields }));
  const [topic, setTopic] = useState<string | null>(seed.topic !== undefined ? seed.topic : here);
  const [status, setStatus] = useState({ busy: false, text: '' });
  const touched = useRef(new Set<keyof Fields>());
  const fetched = useRef<{ url: string; promise: Promise<FetchResult | null> } | null>(null);
  const saved = useRef(new Set<string>()); // files the link fetch wrote to disk
  const added = useRef(false);
  const alive = useRef(true);
  const picker = useRef<HTMLInputElement>(null);

  const set = (k: keyof Fields) => (v: string) => {
    touched.current.add(k);
    setF((p) => ({ ...p, [k]: v }));
  };
  /** Detected details only fill fields you haven't typed in. */
  const suggest = (m: Partial<Fields>) =>
    setF((p) => {
      const n = { ...p };
      for (const k of Object.keys(m) as (keyof Fields)[]) if (m[k] && !touched.current.has(k)) n[k] = m[k]!;
      return n;
    });

  // Cancelled? Throw away anything the link fetch saved.
  useEffect(
    () => () => {
      alive.current = false;
      if (!added.current) saved.current.forEach((file) => api.trash(file).catch(() => {}));
    },
    [],
  );

  useEffect(() => {
    if (!dropped) return;
    setMode('pdf');
    setFile(dropped.file);
  }, [dropped]);

  // A PDF was chosen: read its details.
  useEffect(() => {
    if (!file) return;
    let live = true;
    setStatus({ busy: true, text: 'reading the PDF…' });
    import('../reader/pdfMeta')
      .then((m) => m.readPdfMeta(file))
      .catch(() => ({}) as Partial<Fields>)
      .then((meta) => {
        if (!live) return;
        suggest({ title: meta.title || nameOf(file), authors: meta.authors, year: meta.year, site: meta.site });
        setStatus({ busy: false, text: meta.title ? 'Details found. Change anything below.' : 'Fill in the details below.' });
      });
    return () => {
      live = false;
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link was typed or pasted: fetch it (PDF or a clean copy of the page) and its details.
  useEffect(() => {
    if (mode !== 'link') return;
    const url = link.trim();
    if (!looksLikeUrl(url)) {
      setStatus({ busy: false, text: '' });
      return;
    }
    const t = setTimeout(() => {
      setStatus({ busy: true, text: 'fetching…' });
      const promise = api.fetchUrl(url, id).catch(() => null);
      fetched.current = { url, promise };
      promise.then((r) => {
        if (r?.file) {
          saved.current.add(r.file);
          if (!alive.current && !added.current) api.trash(r.file).catch(() => {});
        }
        if (!alive.current || fetched.current?.promise !== promise) return;
        if (!r) return setStatus({ busy: false, text: "Couldn't reach that link. You can still add it." });
        suggest({ title: r.title, authors: r.authors, year: r.year, site: r.site });
        setStatus({
          busy: false,
          text: r.file
            ? r.file.endsWith('.pdf')
              ? 'Got the PDF.'
              : 'Saved a readable copy of the page.'
            : `Link saved. The page text couldn't be grabbed${r.error ? ` (${r.error})` : ''}.`,
        });
      });
    }, 500);
    return () => clearTimeout(t);
  }, [link, mode, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fallback = mode === 'pdf' && file ? nameOf(file) : mode === 'link' ? shortUrl(link) : '';
  const ready = mode === 'pdf' ? !!file : mode === 'link' ? looksLikeUrl(link.trim()) : mode === 'none' && !!f.title.trim();

  const add = async () => {
    if (!ready || !mode) return;
    added.current = true;
    const opt = (s: string) => s.trim() || undefined;
    const url = mode === 'link' ? link.trim() : opt(f.url);
    actions.addArticle(topic, {
      id,
      title: f.title.trim() || fallback,
      authors: opt(f.authors),
      year: opt(f.year),
      site: opt(f.site),
      summary: opt(f.summary),
      url,
    });
    onAdded(id);
    onClose();

    if (mode === 'pdf' && file) {
      for (const s of saved.current) if (s !== `${id}.pdf`) api.trash(s).catch(() => {});
      actions.setPending(id, true);
      try {
        const { file: name } = await api.upload(id, file);
        actions.update(id, { file: name });
      } catch (e: any) {
        actions.toast(`Couldn't save the PDF: ${e?.message ?? e}`);
      } finally {
        actions.setPending(id, false);
      }
    } else if (mode === 'link') {
      const pending = fetched.current;
      if (!pending || pending.url !== url) return fetchInto(id, url!, f.title.trim() ? undefined : fallback);
      actions.setPending(id, true);
      const r = await pending.promise;
      actions.setPending(id, false);
      for (const s of saved.current) if (s !== r?.file) api.trash(s).catch(() => {});
      if (!r) return;
      actions.update(id, { url: r.url, ...(r.file ? { file: r.file } : {}) });
      actions.fill(id, { title: r.title, authors: r.authors, year: r.year, site: r.site }, f.title.trim() ? undefined : fallback);
    }
  };

  const topics = useMemo(
    () =>
      tree
        .topics()
        .map((t) => ({ id: t.id, label: tree.path(t.id).map((n) => n.title).join(' / ') }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tree],
  );
  const submitOnEnter = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') add();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="scrim" onPointerDown={onClose}>
      <div className="sheet addm" onPointerDown={(e) => e.stopPropagation()} onKeyDown={submitOnEnter}>
        <div className="sheet-head">
          <div className="sheet-title">Add material</div>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {seed.cites && (
          <p className="addm-from faint">
            Cited in “{seed.cites.title}”. It will be connected to it.
            {mode === 'none' && ' Have a link or the PDF? Switch to Link or PDF.'}
          </p>
        )}

        {!mode ? (
          <div className="tiles">
            {MODES.map((m) => (
              <button
                key={m.mode}
                className="tile"
                autoFocus={m.mode === 'pdf'}
                onClick={() => {
                  setMode(m.mode);
                  if (m.mode === 'pdf') picker.current?.click();
                }}
              >
                <span className={`tile-glyph ${m.mode}`} />
                <span className="tile-title">{m.title}</span>
                <span className="tile-hint">{m.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="seg">
              {MODES.map((m) => (
                <button key={m.mode} className={mode === m.mode ? 'on' : ''} onClick={() => setMode(m.mode)}>
                  {m.title}
                </button>
              ))}
            </div>

            {mode === 'pdf' && (
              <button className={`dropbox ${file ? 'has' : ''}`} onClick={() => picker.current?.click()}>
                {file ? (
                  <>
                    <span className="dropbox-name">{file.name}</span>
                    <span className="faint">{(file.size / 1e6).toFixed(1)} MB · change</span>
                  </>
                ) : (
                  <span>Drop a PDF here, or click to choose one</span>
                )}
              </button>
            )}
            {mode === 'link' && (
              <input
                className="sheet-input"
                autoFocus
                value={link}
                placeholder="Paste a URL, DOI or arXiv link"
                onChange={(e) => setLink(e.target.value)}
              />
            )}

            <div className={`status ${status.busy ? 'busy' : ''}`}>{status.text}</div>

            <div className="form">
              <label className="field wide">
                <span>Title</span>
                <input
                  value={f.title}
                  placeholder={fallback || 'What is it called?'}
                  autoFocus={mode === 'none'}
                  onChange={(e) => set('title')(e.target.value)}
                />
              </label>
              <label className="field wide">
                <span>Authors</span>
                <input value={f.authors} placeholder="e.g. Alan M. Turing" onChange={(e) => set('authors')(e.target.value)} />
              </label>
              <label className="field">
                <span>Year</span>
                <input value={f.year} placeholder="1950" onChange={(e) => set('year')(e.target.value)} />
              </label>
              <label className="field">
                <span>Published in</span>
                <input value={f.site} placeholder="Journal, publisher, site" onChange={(e) => set('site')(e.target.value)} />
              </label>
              {mode !== 'link' && (
                <label className="field wide">
                  <span>Link</span>
                  <input value={f.url} placeholder="Optional" onChange={(e) => set('url')(e.target.value)} />
                </label>
              )}
              <label className="field wide">
                <span>Topic</span>
                <select value={topic ?? ''} onChange={(e) => setTopic(e.target.value || null)}>
                  <option value="">{lib.title} (top level)</option>
                  {topics.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field wide">
                <span>Summary</span>
                <textarea
                  rows={2}
                  value={f.summary}
                  placeholder="Optional. You can write it after reading."
                  onChange={(e) => set('summary')(e.target.value)}
                />
              </label>
            </div>

            <div className="sheet-actions">
              <button className="ghost" onClick={onClose}>
                cancel
              </button>
              <button className="pill solid" disabled={!ready} onClick={add}>
                add to {topic ? `“${tree.get(topic)?.title}”` : lib.title}
              </button>
            </div>
          </>
        )}

        <input
          ref={picker}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) {
              setMode('pdf');
              setFile(picked);
            }
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
