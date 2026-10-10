// pdf.js, loaded lazily (it's big). The legacy build runs in older browsers too.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const asset = (p: string) => new URL(p, document.baseURI).href;

/** Returns the loading task: await `.promise` for the document, call `.destroy()` when done. */
export function openPdf(src: string | ArrayBuffer) {
  return pdfjs.getDocument({
    ...(typeof src === 'string' ? { url: src } : { data: new Uint8Array(src) }),
    cMapUrl: asset('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('pdfjs/standard_fonts/'),
    wasmUrl: asset('pdfjs/wasm/'),
  });
}

export { pdfjs };
