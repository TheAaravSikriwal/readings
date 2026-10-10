import { api } from './api';
import { actions, uid } from './store';

export const nameOf = (file: File) => file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';

export const shortUrl = (url: string) => {
  try {
    const u = new URL(/^https?:/i.test(url) ? url : `https://${url}`);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
};

async function pdfMeta(file: File) {
  const { readPdfMeta } = await import('./reader/pdfMeta');
  return readPdfMeta(file).catch(() => ({}));
}

/** Adds a PDF as a new article bubble inside `parent`. */
export async function importPdf(file: File, parent: string | null) {
  const id = uid('a');
  const placeholder = nameOf(file);
  actions.addArticle(parent, { id, title: placeholder });
  actions.setPending(id, true);
  try {
    const [{ file: saved }, meta] = await Promise.all([api.upload(id, file), pdfMeta(file)]);
    actions.update(id, { file: saved });
    actions.fill(id, meta, placeholder);
  } catch (e: any) {
    actions.remove(id);
    actions.toast(`Couldn't import ${file.name}: ${e?.message ?? e}`);
  } finally {
    actions.setPending(id, false);
  }
  return id;
}

/** Attaches a PDF to an existing article (e.g. one that started as a link). */
export async function attachPdf(articleId: string, file: File) {
  actions.setPending(articleId, true);
  try {
    const [{ file: saved }, meta] = await Promise.all([api.upload(articleId, file), pdfMeta(file)]);
    actions.update(articleId, { file: saved });
    actions.fill(articleId, meta);
  } catch (e: any) {
    actions.toast(`Couldn't attach ${file.name}: ${e?.message ?? e}`);
  } finally {
    actions.setPending(articleId, false);
  }
}

/** Grabs the PDF or a clean text copy behind an article's link. */
export async function fetchInto(articleId: string, url: string, placeholder?: string) {
  actions.setPending(articleId, true);
  try {
    const r = await api.fetchUrl(url, articleId);
    actions.update(articleId, { url: r.url, ...(r.file ? { file: r.file } : {}) });
    actions.fill(articleId, { title: r.title, authors: r.authors, year: r.year, site: r.site }, placeholder);
    if (!r.file) actions.toast(`Saved the link. The page text couldn't be grabbed${r.error ? ` (${r.error})` : ''}.`);
  } catch (e: any) {
    actions.toast(`Couldn't reach that link: ${e?.message ?? e}`);
  } finally {
    actions.setPending(articleId, false);
  }
}

export const looksLikeUrl = (s: string) =>
  /^(https?:\/\/\S+|10\.\d{4,9}\/\S+|arxiv:\S+|(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*)$/i.test(s.trim());
