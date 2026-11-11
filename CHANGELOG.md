# Changelog

## 1.5.0

- Web PDFs now open in Inkfold **inside their own tab**, keeping their `https://` address, instead of moving to an extension page. This lets Gemini in Chrome (and similar tools) read and share them; previously Gemini showed "Tab cannot be shared".
- With automatic opening off, the toolbar icon opens the current PDF in place.
- Settings are kept in the extension's own storage.
- The clipboard is read by the extension itself when you add a note, so no website prompt appears.
- One fewer permission: the network redirect rule (`declarativeNetRequestWithHostAccess`) is no longer needed.

## 1.4.0: Inkfold

- New name: **Inkfold** (previously "PDF Shapes"). Files saved by earlier versions stay fully editable.
- Cleaner, flatter toolbar; messages appear as small pop-ups, with **Undo** for page deletions and notes.
- Welcome on first run, explaining automatic PDF opening, file access and privacy.
- One-time explanations: before the first clipboard note (with a preview), after the first page deletion and the first save.
- Tip when trying to highlight a page that has no selectable text.
- Documentation, privacy policy, Chrome Web Store listing and images.

## 1.3.0

- The select tool is the default.
- A keyboard shortcut for every action, shown in brackets on every button; redo; shortcut list (`?`).
- Much smoother window resizing on long documents.
- Chrome's native text selection, readable by assistants such as Gemini in Chrome.
- Notes: smaller text, plus LaTeX math (inline, display and `align`-style environments).

## 1.2.0

- Rotate and delete pages, singly or by range; split into several PDFs.
- Markdown note pages from the clipboard.

## 1.1.0

- Highlighter and selectable text; fit width / fit page; two-page view.
- Opens every PDF automatically; "Save as" dialog; new icon.

## 1.0.0

- Rectangles and ellipses on PDFs, saved as standard annotations.
