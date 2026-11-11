# Third-party notices

Inkfold bundles the following open-source libraries in `extension/lib/`. Their full licence texts are included next to them.

| Library | Version | Licence | Files | Licence text |
|---|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) by Mozilla | 6.5.438 | Apache-2.0 | `pdf.min.mjs`, `pdf.worker.min.mjs`, `cmaps/`, `standard_fonts/`, `wasm/` | [`LICENSE-pdfjs`](extension/lib/LICENSE-pdfjs) |
| [pdf-lib](https://github.com/Hopding/pdf-lib) by Andrew Dillon | 1.17.1 | MIT | `pdf-lib.esm.min.js` | [`LICENSE-pdf-lib`](extension/lib/LICENSE-pdf-lib) |
| [MathJax](https://github.com/mathjax/MathJax) | 3.2.2 | Apache-2.0 | `mathjax/tex-svg-full.js` | [`mathjax/LICENSE`](extension/lib/mathjax/LICENSE) |
| [tesseract.js](https://github.com/naptha/tesseract.js) | 6.0.1 | Apache-2.0 | `tesseract/tesseract.esm.min.js`, `tesseract/worker.min.js` | [`tesseract/LICENSE-tesseract.js`](extension/lib/tesseract/LICENSE-tesseract.js) |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core): [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (Apache-2.0) and [Leptonica](http://www.leptonica.org/) (BSD-2-Clause), compiled to WebAssembly | 6.1.2 | Apache-2.0 | `tesseract/tesseract-core-simd-lstm.wasm.js`, `tesseract/tesseract-core-lstm.wasm.js` | [`tesseract/LICENSE-tesseract.js-core`](extension/lib/tesseract/LICENSE-tesseract.js-core) |
| English language model from [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) (integer version, via `@tesseract.js-data/eng`) | 4.0.0 | Apache-2.0 | `tesseract/eng.traineddata.gz` | (Apache-2.0, as above) |

The files are unmodified copies from the published npm packages, except that source-map comments were removed. The `wasm/` folder of pdf.js contains decoders with their own licence files (JBIG2, OpenJPEG, QCMS, QuickJS), included in that folder.

Part of Inkfold's text-layer CSS (`extension/viewer.css`) is adapted from pdf.js's `web/pdf_viewer.css` (Apache-2.0).
