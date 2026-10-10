import type { Library } from './types';

export interface FetchResult {
  url: string;
  file?: string;
  title?: string;
  authors?: string;
  year?: string;
  site?: string;
  error?: string;
}

export type Meta = Pick<FetchResult, 'title' | 'authors' | 'year' | 'site'>;

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const fileUrl = (file: string) => `data/files/${file}`;

export const api = {
  load: async (): Promise<Library> => json(await fetch('data/library.json', { cache: 'no-store' })),
  save: async (lib: Library) =>
    json(await fetch('api/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lib) })),
  upload: async (id: string, file: Blob): Promise<{ file: string }> =>
    json(await fetch(`api/upload?id=${encodeURIComponent(id)}`, { method: 'POST', body: file })),
  fetchUrl: async (url: string, id: string): Promise<FetchResult> => json(await post('api/fetch', { url, id })),
  meta: async (q: { arxiv?: string; doi?: string }): Promise<Meta> => json(await post('api/meta', q)),
  trash: async (file: string) => json(await post('api/trash', { file })),
};
