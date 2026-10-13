import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Pages read at most: a conversation longer than this is more than an agent can take in anyway */
const MAX_PAGES = 300;

/**
 * The text of a PDF, line by line and page after page, for importing a conversation from it. Read here rather
 * than in the service worker, which cannot start the worker PDF.js parses in. PDF.js loads only when needed.
 */
export async function pdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false })
    .promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text.trim());
      page.cleanup();
    }
    return pages.filter(Boolean).join('\n\n');
  } finally {
    await doc.destroy();
  }
}
