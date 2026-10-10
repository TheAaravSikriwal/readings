// Vite plugin: in dev it serves and saves your library to ./data;
// at build time it writes a public, read-only copy into dist/data.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fetchArticle, lookupMeta } from './fetch-article.ts';
import { publish, siteConfig } from './publish.ts';

export interface LibraryOptions {
  /** Folder that holds library.json and files/. */
  dataDir?: string;
}

const ID_RE = /^[a-z0-9_-]{1,64}$/i;
const FILE_RE = /^[a-z0-9_-]{1,64}\.(pdf|html)$/i;
const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.html': 'text/plain; charset=utf-8', // snapshots are read as text, never run as pages
  '.wasm': 'application/wasm',
};
const EMPTY = { version: 1, title: 'Readings', nodes: [], links: [] };

function readBody(req: IncomingMessage, limit = 300 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function serveFile(res: ServerResponse, file: string) {
  try {
    const buf = await fsp.readFile(file);
    res.setHeader('content-type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

/** The public library: hidden branches removed, and files kept only for
 * readings marked `share` (open-access PDFs and pages you may republish). */
export function publicLibrary(lib: any) {
  const kids = new Map<string, string[]>();
  for (const n of lib.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
  const hidden = new Set<string>();
  const hide = (id: string) => {
    if (hidden.has(id)) return;
    hidden.add(id);
    (kids.get(id) ?? []).forEach(hide);
  };
  lib.nodes.filter((n: any) => n.hidden).forEach((n: any) => hide(n.id));
  return {
    ...lib,
    nodes: lib.nodes
      .filter((n: any) => !hidden.has(n.id))
      .map(({ hidden: _h, ...n }: any) => (n.share && n.file ? n : { ...n, file: undefined, share: undefined })),
    links: lib.links.filter((l: any) => !hidden.has(l.a) && !hidden.has(l.b)),
  };
}

export function library(opts: LibraryOptions = {}): Plugin {
  let dataDir = '';
  let outDir = '';
  let pdfjsDir = '';
  let root = '';
  let publishing = false;

  const libFile = () => path.join(dataDir, 'library.json');
  const filesDir = () => path.join(dataDir, 'files');

  async function backup() {
    const dir = path.join(dataDir, 'backups');
    await fsp.mkdir(dir, { recursive: true });
    const list = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    const last = list.at(-1);
    if (last && Date.now() - (await fsp.stat(path.join(dir, last))).mtimeMs < 10 * 60 * 1000) return;
    if (!fs.existsSync(libFile())) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await fsp.copyFile(libFile(), path.join(dir, `library-${stamp}.json`));
    for (const old of list.slice(0, Math.max(0, list.length - 29))) await fsp.rm(path.join(dir, old));
  }

  return {
    name: 'readings-library',

    configResolved(config) {
      root = config.root;
      dataDir = path.resolve(config.root, opts.dataDir ?? 'data');
      outDir = path.resolve(config.root, config.build.outDir);
      pdfjsDir = path.resolve(config.root, 'node_modules/pdfjs-dist');
    },

    configureServer(server) {
      fs.mkdirSync(filesDir(), { recursive: true });

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
        const p = decodeURIComponent(url.pathname);
        try {
          // ---- static: library + files + pdf.js assets
          if (req.method === 'GET' && p === '/data/library.json') {
            if (!fs.existsSync(libFile())) return send(res, 200, EMPTY);
            return serveFile(res, libFile());
          }
          if (req.method === 'GET' && p.startsWith('/data/files/')) {
            const name = p.slice('/data/files/'.length);
            if (!FILE_RE.test(name)) return send(res, 400, { error: 'Bad file name' });
            return serveFile(res, path.join(filesDir(), name));
          }
          if (req.method === 'GET' && p.startsWith('/pdfjs/')) {
            const rel = path.normalize(p.slice('/pdfjs/'.length));
            if (!/^(cmaps|standard_fonts|wasm)[\\/][\w.-]+$/.test(rel)) return send(res, 404, {});
            return serveFile(res, path.join(pdfjsDir, rel));
          }
          if (!p.startsWith('/api/')) return next();

          // ---- api
          if (p === '/api/library' && (req.method === 'PUT' || req.method === 'POST')) {
            const body = (await readBody(req, 50 * 1024 * 1024)).toString('utf8');
            const lib = JSON.parse(body);
            if (!Array.isArray(lib.nodes) || !Array.isArray(lib.links)) throw new Error('Invalid library');
            await backup();
            const tmp = libFile() + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify(lib, null, 2), 'utf8');
            await fsp.rename(tmp, libFile());
            return send(res, 200, { ok: true });
          }
          if (p === '/api/upload' && req.method === 'POST') {
            const id = url.searchParams.get('id') ?? '';
            if (!ID_RE.test(id)) return send(res, 400, { error: 'Bad id' });
            const buf = await readBody(req);
            if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return send(res, 400, { error: 'Not a PDF' });
            const file = `${id}.pdf`;
            await fsp.writeFile(path.join(filesDir(), file), buf);
            return send(res, 200, { file });
          }
          if (p === '/api/fetch' && req.method === 'POST') {
            const { url: target, id } = JSON.parse((await readBody(req, 1e5)).toString('utf8'));
            if (!ID_RE.test(id) || typeof target !== 'string') return send(res, 400, { error: 'Bad request' });
            return send(res, 200, await fetchArticle(target, id, filesDir()));
          }
          if (p === '/api/meta' && req.method === 'POST') {
            const q = JSON.parse((await readBody(req, 1e5)).toString('utf8'));
            return send(res, 200, await lookupMeta(q));
          }
          if (p === '/api/publish' && req.method === 'GET') {
            const cfg = await siteConfig(root);
            return send(res, 200, { configured: !!cfg, url: cfg?.url ?? '', busy: publishing });
          }
          if (p === '/api/publish' && req.method === 'POST') {
            // Streams one line per step, then a final line of JSON after '@@'.
            if (publishing) return send(res, 409, { error: 'Already publishing.' });
            publishing = true;
            res.statusCode = 200;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            try {
              const result = await publish(root, (line) => res.write(`${line}\n`));
              res.end(`@@${JSON.stringify({ ok: true, ...result })}\n`);
            } catch (e: any) {
              const msg = (e?.stderr || e?.message || String(e)).toString().trim().split('\n').slice(-3).join(' ');
              res.end(`@@${JSON.stringify({ ok: false, error: msg })}\n`);
            } finally {
              publishing = false;
            }
            return;
          }
          if (p === '/api/trash' && req.method === 'POST') {
            const { file } = JSON.parse((await readBody(req, 1e5)).toString('utf8'));
            if (!FILE_RE.test(file)) return send(res, 400, { error: 'Bad file name' });
            const trash = path.join(dataDir, 'trash');
            await fsp.mkdir(trash, { recursive: true });
            const src = path.join(filesDir(), file);
            if (fs.existsSync(src)) await fsp.rename(src, path.join(trash, `${Date.now()}-${file}`));
            return send(res, 200, { ok: true });
          }
          return send(res, 404, { error: 'Unknown endpoint' });
        } catch (e: any) {
          return send(res, 500, { error: e?.message ?? String(e) });
        }
      });
    },

    async writeBundle() {
      const lib = fs.existsSync(libFile()) ? JSON.parse(await fsp.readFile(libFile(), 'utf8')) : EMPTY;
      const pub = publicLibrary(lib);
      const outData = path.join(outDir, 'data');
      await fsp.mkdir(outData, { recursive: true });
      const shared = pub.nodes.filter(
        (n: any) => n.file && FILE_RE.test(n.file) && fs.existsSync(path.join(filesDir(), n.file)),
      );
      for (const n of pub.nodes) if (n.file && !shared.includes(n)) delete n.file;
      await fsp.writeFile(path.join(outData, 'library.json'), JSON.stringify(pub));
      if (!shared.length) return;
      await fsp.mkdir(path.join(outData, 'files'), { recursive: true });
      for (const n of shared) await fsp.copyFile(path.join(filesDir(), n.file), path.join(outData, 'files', n.file));
      // pdf.js needs its fonts, character maps and image decoders to show the shared PDFs.
      if (!shared.some((n: any) => n.file.endsWith('.pdf'))) return;
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        await fsp.cp(path.join(pdfjsDir, dir), path.join(outDir, 'pdfjs', dir), { recursive: true });
      }
    },
  };
}
