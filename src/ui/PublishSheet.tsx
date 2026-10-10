import { useEffect, useMemo, useState } from 'react';
import { flush, useStore } from '../store';

type Phase = 'ready' | 'running' | 'done' | 'error';

interface Result {
  ok: boolean;
  changed?: boolean;
  url?: string;
  commit?: string;
  error?: string;
}

/** Puts the map on the website: what will go up, then one button. */
export function PublishSheet({ onClose }: { onClose: () => void }) {
  const { lib } = useStore();
  const [info, setInfo] = useState<{ configured: boolean; url: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    fetch('api/publish')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo({ configured: false, url: '' }));
  }, []);

  // What the public copy will hold: the same rules as the build (server/library-plugin.ts).
  const pub = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const n of lib.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
    const hidden = new Set<string>();
    const hide = (id: string) => {
      if (hidden.has(id)) return;
      hidden.add(id);
      (kids.get(id) ?? []).forEach(hide);
    };
    lib.nodes.filter((n) => n.hidden).forEach((n) => hide(n.id));
    const shown = lib.nodes.filter((n) => !hidden.has(n.id));
    return {
      articles: shown.filter((n) => n.type === 'article').length,
      topics: shown.filter((n) => n.type === 'topic').length,
      links: lib.links.filter((l) => !hidden.has(l.a) && !hidden.has(l.b)).length,
      hidden: lib.nodes.filter((n) => hidden.has(n.id) && n.type === 'article').length,
      files: shown.filter((n) => n.type === 'article' && n.share && n.file).length,
    };
  }, [lib]);

  const run = async () => {
    setPhase('running');
    setSteps([]);
    try {
      await flush();
      const res = await fetch('api/publish', { method: 'POST' });
      if (!res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let last: Result | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('@@')) last = JSON.parse(line.slice(2));
          else if (line.trim()) setSteps((s) => [...s, line]);
        }
      }
      if (!last) throw new Error('The publish stopped without saying why.');
      setResult(last);
      setPhase(last.ok ? 'done' : 'error');
    } catch (e: any) {
      setResult({ ok: false, error: e?.message ?? String(e) });
      setPhase('error');
    }
  };

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const where = info?.url.replace(/^https?:\/\//, '') || 'your website';

  return (
    <div className="scrim" onPointerDown={() => phase !== 'running' && onClose()}>
      <div
        className="sheet"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && phase !== 'running' && onClose()}
      >
        <div className="sheet-head">
          <div className="sheet-title">Publish</div>
          {phase !== 'running' && (
            <button className="icon" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>

        {info && !info.configured ? (
          <p className="pub-lede">
            No website is set up yet. Put its folder in <code>readings.config.json</code>, then try again.
          </p>
        ) : (
          <>
            <p className="pub-lede">
              Puts your map, summaries and notes on <b>{where}</b>.
            </p>
            <ul className="pub-list">
              <li>
                {plural(pub.articles, 'reading')}, {plural(pub.topics, 'topic')}, {plural(pub.links, 'connection')}
              </li>
              <li className="faint">
                {pub.hidden
                  ? `${plural(pub.hidden, 'reading')} marked hidden ${pub.hidden === 1 ? 'stays' : 'stay'} on this computer`
                  : 'Nothing is marked hidden'}
              </li>
              <li className="faint">
                {pub.files
                  ? `${plural(pub.files, 'file')} you marked open access ${pub.files === 1 ? 'goes' : 'go'} up too`
                  : 'No PDFs or saved pages go up, only your notes and the source links'}
              </li>
            </ul>
          </>
        )}

        {phase !== 'ready' && (
          <ol className="pub-steps">
            {steps.map((s, i) => (
              <li key={i} className={phase === 'running' && i === steps.length - 1 ? 'busy' : ''}>
                {s}
              </li>
            ))}
          </ol>
        )}

        {phase === 'done' && result && (
          <p className="pub-done">
            {result.changed ? 'Done. It goes live in about two minutes.' : 'Already up to date.'}{' '}
            {result.url && (
              <a href={result.url} target="_blank" rel="noreferrer">
                Open the site ↗
              </a>
            )}
          </p>
        )}
        {phase === 'error' && result && <p className="pub-error">Couldn’t publish: {result.error}</p>}

        <div className="sheet-actions">
          {phase === 'ready' && (
            <>
              <button className="ghost" onClick={onClose}>
                cancel
              </button>
              <button className="pill solid" disabled={!info?.configured} onClick={run} autoFocus>
                publish now
              </button>
            </>
          )}
          {phase === 'running' && <span className="faint">publishing…</span>}
          {phase === 'error' && (
            <button className="pill solid" onClick={run}>
              try again
            </button>
          )}
          {phase === 'done' && (
            <button className="pill solid" onClick={onClose} autoFocus>
              close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
