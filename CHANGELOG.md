# Changelog

## 2.6.0: simpler note and image buttons

- **Add a note** is now an icon on the left of the toolbar, next to **Add an image**. Its dialog is just a box to type in; copied Markdown goes in with Magic paste (<kbd>Ctrl</kbd>+<kbd>V</kbd>).
- **Add an image** opens the file picker straight away. Copied pictures go in with Magic paste.
- The clipboard is now read only by Magic paste.
- Fixed: the very first Magic paste after starting Chrome could say the clipboard was empty (two reads raced to start Inkfold's helper page).

## 2.5.0: magic paste

- **Magic paste** (<kbd>Ctrl</kbd>+<kbd>V</kbd>, or the clipboard button in the toolbar) looks at what you copied and offers the right action in a small card with a preview: a **picture** is pasted onto the current page; **Markdown** (headings, lists, tables, code, links, math…) becomes a note page after it; **plain text** becomes a text box on it, wrapped to a comfortable width. For text, the other option is offered too. <kbd>Ctrl</kbd>+<kbd>V</kbd> inside text boxes and fields pastes as usual.
- Toolbar buttons are a touch narrower, so everything still fits on one line in 1,280-px-wide windows.

## 2.4.0: images

- **Add an image** (<kbd>I</kbd>, or the picture button in the toolbar): a dialog offers **Paste from the clipboard** (with a preview; unavailable when the clipboard holds no picture) or **Upload from your computer**. The image goes in the middle of the part of the page you're looking at, scaled down to fit the page if it's big.
- Move it by dragging, resize it from a corner (it keeps its proportions; hold <kbd>Shift</kbd> to stretch it), and remove it with <kbd>Del</kbd> or the eraser, like a rectangle. Undo works for all of it.
- Images are saved as standard `Stamp` annotations, so other PDF readers show them, and they're editable again when you reopen the file in Inkfold. Transparent PNGs stay transparent.
- The toolbar is a little more compact, so it stays on one line in windows 1,280 px wide (narrower windows wrap it onto two lines).
- The eraser: a click now removes only the topmost thing under it (so clicking a small picture on top of a big one removes just the small one); dragging still removes everything it passes over.

## 2.3.0: smooth arrow-key scrolling, ← → between pages

- <kbd>↑</kbd> / <kbd>↓</kbd> now glide smoothly instead of jumping in steps: a tap moves a few lines, holding speeds up gently, and letting go eases to a stop.
- <kbd>←</kbd> / <kbd>→</kbd> glide to the previous or next page (the previous or next pair in two-page view). Quick presses add up. Arrow keys still work as usual in text boxes and fields.

## 2.2.1: full-screen button and F11

- Fixed: after going full screen with Chrome's F11, the full-screen button seemed to stop working (it showed "enter full screen" and clicking it did nothing visible). It now recognises F11, shows the "exit" state, and says to press F11 to leave, since a page isn't allowed to end Chrome's own full screen. Once F11 is off, the button works as before.

## 2.2.0: eraser

- **Eraser** (<kbd>E</kbd>) in the toolbar: click a highlight, rectangle, ellipse or text box to remove it, or drag across several to remove them all in one stroke (one <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings the stroke back). Whatever the eraser would remove fades as you point at it. Shapes are caught by their outline, so clicking inside a rectangle doesn't remove it.
- The delete button at the corner of a selected annotation is gone. <kbd>Del</kbd> still removes the selected one.
- Fixed: the full-screen button's icon sat a little high in the toolbar.

## 2.1.0: full screen

- A **full screen** button next to two-page view (or <kbd>Shift</kbd>+<kbd>F</kbd>). In full screen the same button, <kbd>Shift</kbd>+<kbd>F</kbd> or <kbd>Esc</kbd> leaves it.

## 2.0.0: text recognition for scanned PDFs, and compression

- **Text recognition (OCR)**: when you open a PDF with pages that have no text (a scan, photos of pages), Inkfold recognises the text in the background, with a small progress bar you can stop. The text becomes selectable and searchable, works with the highlighter and with assistants such as Gemini in Chrome, and copies you save contain it as invisible text, so they're searchable in any PDF reader. PDFs that already have text are left alone. It all runs on your computer, with the Tesseract engine and an English model bundled in the extension (about 7 MB).
- **Compression**: the first time you open a PDF that could be more than 20% smaller, a small card offers to compress it. Compressing re-encodes oversized images (JPEG, at most 2,400 px on the long side), compresses uncompressed data and writes compact cross-references; pages, text, links and annotations are untouched. Copies you save are then smaller. Each PDF is checked only once.

## 1.10.0: type notes, and note pages sized to fit

- **Add a note** (<kbd>N</kbd> or **+ Note**) now opens a dialog: type the note right there, or use the Markdown on your clipboard. The clipboard option shows what you copied, and is unavailable when the clipboard has no text. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> adds the note.
- Note pages are as wide as the page they follow and exactly as tall as the note, so a short note is a short page and a long one is a single long page, instead of always being A4/Letter-sized.

## 1.9.1: fixed text boxes vanishing; a set of standard colours

- Fixed: clicking with the text tool opened a text box that disappeared a moment later (with an ordinary-speed click). Every click anywhere was also quietly re-selecting the current tool, which closed the box; that's gone too.
- Colours are now five standard ones, shown as dots in the toolbar: red, orange, green, blue and black for shapes and text, and light yellow, green, blue, pink and orange for the highlighter. <kbd>C</kbd> moves to the next one.
- With the select tool and nothing selected, the colour and thickness controls are hidden. Select an annotation to change its colour or thickness.

## 1.9.0: text boxes with LaTeX

- **Text boxes** (<kbd>T</kbd>): click anywhere on a page and type. Text between `$` signs is LaTeX and is typeset when you finish. Change the colour, and the size with the new size buttons or <kbd>−</kbd> / <kbd>+</kbd>. Double-click a box to edit it, drag to move it. The font is Helvetica, one of the fonts every PDF reader has, so boxes look the same everywhere. Saved as standard `FreeText` annotations, editable again in Inkfold.
- Line thickness is now three line buttons instead of a drop-down.

## 1.8.1: fixes for opening PDFs

- Fixed: opening a second PDF over one already open (with Open or by dropping a file) failed with "d.pdf.destroy is not a function", and the old PDF stayed on screen.
- Fixed: PDFs from your computer were read on the page's main thread ("Warning: Setting up fake worker"), which made big files slow to open and could freeze the tab. Chrome refuses the usual background worker on file:// pages, so Inkfold now starts it in a form those pages allow.
- Fixed: a harmless but noisy CORS error in the console every time a PDF from your computer was opened.

## 1.8.0: page number and jump to page, delete button on annotations

- **Page number** in the toolbar shows the page you're on and the total. Type a number and press Enter (or press <kbd>G</kbd>) to jump to that page.
- The selected annotation gets its own **delete button** at its top-right corner. The delete button on the toolbar is gone; <kbd>Del</kbd> still works.
- The Pages panel's range box starts empty, so its example (`e.g. 3, 5-7, 10-end`) shows that it takes a page, a range or several.
- With a PDF open, **Open** (and <kbd>Ctrl</kbd>+<kbd>O</kbd>, and dropping a file) is no longer offered. Open another PDF in its own tab instead.

## 1.7.0: right-click page menu, no flash when opening

- **Right-click a page** to rotate it, delete it, or add a note after it. The buttons that appeared when hovering over a page are gone; the page number still shows there. With text selected, or with Shift held, Chrome's own menu (Copy, Gemini and so on) appears as before. The Pages panel (P) is still there for ranges and splitting.
- Opening a PDF, especially one from your computer, no longer flashes Chrome's viewer, an unstyled page or the "Open a PDF" screen first. Placeholder pages show until the document is ready.

## 1.6.0: PDFs from your computer open in place too

- PDFs on your computer now also open in Inkfold **inside their own tab**, keeping their `file://` address, so Gemini in Chrome can share them too. (Needs "Allow access to file URLs".)
- Files dropped onto, or opened from, Inkfold's own page show a one-time tip explaining that Gemini can't read that page, and how to open the PDF so it can.
- One fewer permission: `webNavigation` is no longer needed.

## 1.5.0: web PDFs open in their own tab, so Gemini can read them

- Web PDFs now open in Inkfold **inside their own tab**, keeping their `https://` address, instead of moving to an extension page. This lets Gemini in Chrome (and similar tools) read and share them; previously Gemini showed "Tab cannot be shared".
- With automatic opening off, the toolbar icon opens the current PDF in place.
- Settings are kept in the extension's own storage.
- The clipboard is read by the extension itself when you add a note, so no website prompt appears.
- One fewer permission: the network redirect rule (`declarativeNetRequestWithHostAccess`) is no longer needed.

## 1.4.0: new name (Inkfold), cleaner interface

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
