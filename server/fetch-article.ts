// Turns a pasted link into something readable: a PDF on disk, or a clean
// text snapshot of the page. Also looks up paper metadata (arXiv, Crossref).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export interface Meta {
  title?: string;
  authors?: string;
  year?: string;
  site?: string;
}

export interface FetchResult extends Meta {
  url: string;
  file?: string;
  error?: string;
}

const ARXIV_RE = /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

export function normalizeUrl(raw: string): string {
  let s = raw.trim();
  if (/^10\.\d{4,9}\//.test(s)) return `https://doi.org/${s}`;
  if (/^arxiv:/i.test(s)) return `https://arxiv.org/abs/${s.slice(6).trim()}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

export function formatAuthors(names: string[]): string | undefined {
  const clean = names.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) return undefined;
  return clean.length > 8 ? `${clean.slice(0, 8).join(', ')} et al.` : clean.join(', ');
}

const yearOf = (s?: string | null) => s?.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];

async function get(url: string, accept = '*/*') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export async function lookupMeta(q: { arxiv?: string; doi?: string }): Promise<Meta> {
  try {
    if (q.arxiv) {
      const res = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(q.arxiv)}`);
      const xml = await res.text();
      const entry = xml.split('<entry>')[1];
      if (!entry) return {};
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      const names = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]);
      return {
        title: title?.replace(/\s+/g, ' ').trim(),
        authors: formatAuthors(names),
        year: yearOf(entry.match(/<published>(.*?)<\/published>/)?.[1]),
        site: 'arXiv',
      };
    }
    if (q.doi) {
      const res = await get(`https://api.crossref.org/works/${encodeURIComponent(q.doi)}`, 'application/json');
      const m = (await res.json()).message ?? {};
      const issued = m.issued?.['date-parts']?.[0]?.[0] ?? m.published?.['date-parts']?.[0]?.[0];
      return {
        title: m.title?.[0]?.replace(/\s+/g, ' ').trim(),
        authors: formatAuthors((m.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ') || a.name)),
        year: issued ? String(issued) : undefined,
        site: m['container-title']?.[0],
      };
    }
  } catch {
    // metadata is best-effort
  }
  return {};
}

function decode(buf: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim() || 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function metaTags(doc: Document) {
  const all = (name: string) =>
    [...doc.querySelectorAll(`meta[name="${name}"], meta[property="${name}"]`)]
      .map((m) => m.getAttribute('content') ?? '')
      .filter(Boolean);
  const one = (...names: string[]) => names.map((n) => all(n)[0]).find(Boolean);
  return {
    title: one('citation_title', 'dc.title'),
    ogTitle: one('og:title'),
    authors: formatAuthors(all('citation_author').length ? all('citation_author') : all('dc.creator')),
    year: yearOf(one('citation_publication_date', 'citation_date', 'citation_year', 'dc.date', 'article:published_time')),
    site: one('citation_journal_title', 'og:site_name'),
    pdf: one('citation_pdf_url'),
  };
}

const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

export async function fetchArticle(rawUrl: string, id: string, filesDir: string): Promise<FetchResult> {
  const url = normalizeUrl(rawUrl);
  const arxiv = url.match(ARXIV_RE)?.[1];
  const doi = !arxiv ? decodeURIComponent(url).match(DOI_RE)?.[1]?.replace(/[.,;)]+$/, '') : undefined;
  const known = await lookupMeta({ arxiv, doi });
  const out: FetchResult = { url, ...known };

  const savePdf = async (buf: Buffer) => {
    const file = `${id}.pdf`;
    await fsp.writeFile(path.join(filesDir, file), buf);
    out.file = file;
  };

  try {
    const res = await get(arxiv ? `https://arxiv.org/pdf/${arxiv}` : url, 'text/html,application/pdf;q=0.9,*/*;q=0.8');
    const ct = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());

    if (isPdf(buf)) {
      await savePdf(buf);
      return out;
    }
    if (!/html|xml|text\/plain/i.test(ct) && ct) throw new Error(`Unsupported content (${ct})`);

    const html = decode(buf, ct);
    const dom = new JSDOM(html, { url: res.url });
    const tags = metaTags(dom.window.document);
    out.title ??= tags.title;
    out.authors ??= tags.authors;
    out.year ??= tags.year;
    out.site ??= tags.site;

    // Academic pages often point at the full PDF; use it when it's freely available.
    if (tags.pdf) {
      try {
        const pdfRes = await get(new URL(tags.pdf, res.url).href, 'application/pdf');
        const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
        if (isPdf(pdfBuf)) {
          await savePdf(pdfBuf);
          return out;
        }
      } catch {
        // fall through to the text snapshot
      }
    }

    const article = new Readability(dom.window.document).parse();
    out.title ??= article?.title?.trim() || tags.ogTitle;
    out.authors ??= article?.byline?.trim() || undefined;
    out.site ??= article?.siteName?.trim() || undefined;
    out.year ??= yearOf(article?.publishedTime);
    if (article?.content && (article.textContent?.trim().length ?? 0) > 200) {
      const purify = createDOMPurify(new JSDOM('').window as any);
      const clean = purify.sanitize(article.content, { FORBID_TAGS: ['style', 'form', 'iframe'] });
      const file = `${id}.html`;
      await fsp.writeFile(path.join(filesDir, file), clean, 'utf8');
      out.file = file;
    } else {
      out.error = 'Could not extract readable text from this page.';
    }
  } catch (e: any) {
    out.error = e?.message ?? String(e);
  }
  return out;
}
