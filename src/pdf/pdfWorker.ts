import * as pdfjs from "pdfjs-dist";
// Vite resolves this to a hashed URL for the worker bundle.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Point PDF.js at its web worker. Must run before any getDocument() call.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type PdfDocument = pdfjs.PDFDocumentProxy;
export type PdfPageProxy = pdfjs.PDFPageProxy;
