import { api, type Meta } from '../api';
import { openPdf } from './pdfjs';

const ARXIV_RE = /arXiv:\s*([a-z-]+\/\d{7}|\d{4}\.\d{4,5})/i;
const ARXIV_NAME_RE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

const decentTitle = (t?: string) =>
  !!t && t.length > 5 && t.length < 300 && !/^(untitled|microsoft|document\d*|.*\.(pdf|docx?|tex))$/i.test(t.trim());

/** Best guess at a paper's title/authors/year from the file itself, then arXiv/Crossref. */
export async function readPdfMeta(file: File): Promise<Meta> {
  const task = openPdf(await file.arrayBuffer());
  try {
    const doc = await task.promise;
    const { info } = (await doc.getMetadata().catch(() => ({ info: {} }))) as { info: Record<string, any> };
    const page = await doc.getPage(1);
    const items = (await page.getTextContent()).items.filter((i: any) => 'str' in i && i.str.trim()) as any[];
    const text = items.map((i) => i.str).join(' ');

    const base = file.name.replace(/\.pdf$/i, '');
    const arxiv = text.match(ARXIV_RE)?.[1] ?? base.match(ARXIV_NAME_RE)?.[1];
    const doi = arxiv ? undefined : text.match(DOI_RE)?.[1]?.replace(/[.,;)]+$/, '');
    const looked = arxiv || doi ? await api.meta({ arxiv, doi }).catch(() => ({}) as Meta) : {};
    if (looked.title) return looked;

    // The title is usually the biggest text on page one.
    const maxH = Math.max(0, ...items.map((i) => i.height));
    const big = items
      .filter((i) => i.height >= maxH * 0.92)
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      ...looked,
      title: decentTitle(info.Title) ? info.Title.trim() : decentTitle(big) ? big : undefined,
      authors: looked.authors ?? (info.Author?.trim() || undefined),
    };
  } finally {
    task.destroy();
  }
}
