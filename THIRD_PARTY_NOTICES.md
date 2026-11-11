# Third-party notices

Inkfold bundles the following open-source libraries in `extension/lib/`. Their full licence texts are included next to them.

| Library | Version | Licence | Files | Licence text |
|---|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) by Mozilla | 6.5.438 | Apache-2.0 | `pdf.min.mjs`, `pdf.worker.min.mjs`, `cmaps/`, `standard_fonts/`, `wasm/` | [`LICENSE-pdfjs`](extension/lib/LICENSE-pdfjs) |
| [pdf-lib](https://github.com/Hopding/pdf-lib) by Andrew Dillon | 1.17.1 | MIT | `pdf-lib.esm.min.js` | [`LICENSE-pdf-lib`](extension/lib/LICENSE-pdf-lib) |
| [MathJax](https://github.com/mathjax/MathJax) | 3.2.2 | Apache-2.0 | `mathjax/tex-svg-full.js` | [`mathjax/LICENSE`](extension/lib/mathjax/LICENSE) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (onnxruntime-web) | 1.23.2 | MIT | `ort/ort.wasm.min.mjs`, `ort/ort-wasm-simd-threaded.mjs`, `ort/ort-wasm-simd-threaded.wasm` | [`ort/LICENSE-onnxruntime`](extension/lib/ort/LICENSE-onnxruntime) |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 models (mobile text detection, mobile English recognition, PP-LCNet text-line orientation), in ONNX form from [RapidOCR](https://github.com/RapidAI/RapidOCR) | PP-OCRv5 | Apache-2.0 | `extension/ocr/models/` (det.onnx, rec.onnx, cls.onnx, dict.txt) | [`ocr/models/NOTICE`](extension/ocr/models/NOTICE), [`LICENSE-Apache-2.0`](extension/ocr/models/LICENSE-Apache-2.0) |

The files are unmodified copies from the published npm packages, except that source-map comments were removed. The `wasm/` folder of pdf.js contains decoders with their own licence files (JBIG2, OpenJPEG, QCMS, QuickJS), included in that folder.

Part of Inkfold's text-layer CSS (`extension/viewer.css`) is adapted from pdf.js's `web/pdf_viewer.css` (Apache-2.0).
