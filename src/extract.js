// Text extraction (OSS only, $0) + chunking. Handles PDF, DOCX, XLSX/CSV, plain
// text, and images (Tesseract OCR). Google-native docs are exported to text/csv
// upstream (src/drive.js) so they arrive here as plain text.
//
// Note: scanned-PDF OCR (rasterising pages) is a Phase-2 refinement; today a
// PDF with no embedded text yields no chunks and is marked "skipped".
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
// Import the lib entry directly — pdf-parse's index.js runs a debug harness when
// imported without a module.parent (which breaks under ESM).
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const CHUNK_CHARS = 900;
const OVERLAP = 120;

export async function extractText(buffer, mime = '', name = '') {
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  try {
    if (m.includes('pdf') || n.endsWith('.pdf')) {
      let text = '';
      try { const data = await pdfParse(buffer); text = (data.text || '').trim(); } catch { /* try OCR */ }
      // Little/no embedded text ⇒ likely a scanned PDF ⇒ rasterise + OCR (bounded, best-effort).
      if (text.length < 40) {
        const ocr = (await ocrPdf(buffer).catch(() => '')).trim();
        if (ocr.length > text.length) return { text: ocr, ocrUsed: true };
      }
      return { text, ocrUsed: false };
    }
    if (m.includes('word') || m.includes('officedocument.wordprocessing') || n.endsWith('.docx')) {
      const { value } = await mammoth.extractRawText({ buffer });
      return { text: (value || '').trim(), ocrUsed: false };
    }
    if (m.includes('sheet') || m.includes('excel') || n.endsWith('.xlsx') || n.endsWith('.xls')) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parts = wb.SheetNames.map((s) => `# ${s}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s]));
      return { text: parts.join('\n\n').trim(), ocrUsed: false };
    }
    if (m.startsWith('image/')) {
      const text = await ocrImage(buffer);
      return { text: (text || '').trim(), ocrUsed: true };
    }
    // text/plain, csv, markdown, json, html, google-exported docs, unknown text
    return { text: buffer.toString('utf8').trim(), ocrUsed: false };
  } catch (e) {
    // A single unreadable file should not kill the whole sync.
    return { text: '', ocrUsed: false, error: e.message };
  }
}

// Lazy, single shared Tesseract worker (the model downloads once).
let _worker = null;
async function ocrImage(buffer) {
  const { createWorker } = await import('tesseract.js');
  if (!_worker) _worker = await createWorker('eng');
  const { data } = await _worker.recognize(buffer);
  return data.text || '';
}

// Scanned-PDF OCR: render each page to a PNG (pdfjs + @napi-rs/canvas, both
// prebuilt — no system binaries) and OCR it. Bounded to MAX_OCR_PAGES; wrapped
// in try/catch by the caller so a rendering hiccup degrades to "no text" rather
// than failing the whole document.
const MAX_OCR_PAGES = Number(process.env.MAX_OCR_PAGES || 15);
async function ocrPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = Math.min(doc.numPages, MAX_OCR_PAGES);
  let out = '';
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    out += (await ocrImage(canvas.toBuffer('image/png'))) + '\n';
  }
  return out;
}

// Overlapping character chunks on whitespace boundaries. Small + simple; good
// enough for retrieval and cheap to embed.
export function chunkText(text) {
  const clean = (text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const nl = clean.lastIndexOf('\n', end);
      const sp = clean.lastIndexOf(' ', end);
      const brk = Math.max(nl, sp);
      if (brk > i + CHUNK_CHARS * 0.5) end = brk;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    i = Math.max(end - OVERLAP, i + 1);
  }
  return chunks.slice(0, 400); // safety cap per document
}
