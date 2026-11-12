# Changelog

## 2.13.1: clearer cropping

- **Crop handles show from the start.** The corner brackets and edge bars now sit just inside the box, in the accent colour with a white rim, so they're visible even while the box covers the whole page (before, they were clipped at the page's edge and only appeared after Trim margins). They pulse briefly, with a "Drag the corners or edges" hint until the first drag.
- **The whole page is in view while cropping**: if it doesn't fit above the crop bar, Inkfold zooms out for the moment and puts your zoom back afterwards, then lines the page up under the toolbar.

## 2.13.0: filled shapes, cropping pages

- **Filled rectangles and ellipses**: an outline/filled choice sits next to the line thickness when drawing or with a shape selected, shaped like the current tool. Pressing <kbd>R</kbd> or <kbd>O</kbd> (or clicking the tool) again switches between them, and the tool's button fills in to show it. Filled shapes are saved as standard Square/Circle annotations with an interior colour, so other viewers fill them too, and they can be selected or erased anywhere inside.
- **Crop a page**: right-click a page → **Crop page**. Drag the box's corner brackets or edges, move it, or draw a new one; **Trim margins** shrinks it to the page's content, **All pages** crops every page of that size the same way. Undoable; saved as the page's CropBox (nothing is cut from the file).
- Switching to another drawing tool now deselects the selected shape, so its style isn't changed by mistake.

## 2.12.1: saving without the file dialog

- **Save writes straight over the original, with no file dialog**, when Inkfold has the file's handle: a PDF opened with **Open** or dropped onto Inkfold. Chrome asks once for permission to save changes to that file; after that, Save just saves.
- **PDFs opened straight in Chrome** (double-clicked) give no handle, so their first save still uses the save dialog. Inkfold then remembers the file (in this browser only), so every later save, even after closing and reopening it, needs only Chrome's permission. For a file directly in Downloads, Desktop or Documents, that first dialog starts in that folder.
- **Safety check**: if another program changed the file since you opened it, Save asks before replacing it. If the file was moved or deleted, Save says so, and the next Save asks where.
- **Ctrl+Shift+S** saves a copy elsewhere (the dialog suggests “name (copy).pdf”).
- Pressing Save while a save dialog was already open downloaded a stray copy; it now does nothing.

## 2.12.0: much better text recognition (PaddleOCR)

- **New OCR engine**: scanned pages are now read with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)'s PP-OCRv5 models (a text detector, an English recogniser and a small line-orientation model) on ONNX Runtime, replacing Tesseract. Everything is still bundled and runs on your computer.
- **Far more accurate on hard pages.** On test pages with known text (words recognised correctly, F1):
  - a table: 100 (Tesseract: 14);
  - photographed pages, with dim, uneven light: 98–99 (Tesseract: 69–71);
  - upside-down pages: 98 (Tesseract: 2–3);
  - small two-column print with scanner noise or low resolution: 98 (Tesseract: 94–95);
  - clean, skewed and typewriter pages: 98–100, as before.
- **Reading order**: lines come out in the order you'd read them (columns left to right, tables row by row), so selecting across lines, copying, finding phrases and assistants such as Gemini follow the text. Text on skewed, upside-down or sideways pages runs in the right direction.
- **The page you're on goes first**: scanned pages are read starting from the one you're looking at.
- **Speed**: it uses several processor cores when it can (the extension's pages are now cross-origin isolated, which allows multithreaded WebAssembly). A dense page takes a few seconds on a typical computer; it runs in the background, and you can stop it from the gear panel. The worker is let go after a minute without work, to free its memory.
- The download is about 10 MB larger (19 MB): ONNX Runtime and the models, less Tesseract. The models themselves barely compress.

## 2.11.4: fixes

- **Merge PDFs list**: rows are drawn properly again: the grip, number, name and page count sit on one line, and This PDF has its blue row. (Their styles had been dropped by mistake in 2.11.2.) The panel also scrolls again when it's taller than the window.
- **Split or extract**: the two tabs are now two buttons, **Split into files** (also Enter in the range box) and **Save as one PDF**. The Split button no longer shows "(Enter)".
- A single page split out is named `notes (page 3).pdf` rather than `notes (pages 3).pdf`.

## 2.11.3: fixes

- **Moving a page**: a clear marker now shows where the page will land: the pages either side move apart and a blue "Page 2 goes here" label sits in the gap. (The gap was too small to notice before, and the marker was placed against the pages' moving positions, so it could sit off-centre.)
- **Pasting into a text box**: long pasted lines are wrapped to fit the page from where the box starts, the same way Magic paste does, keeping the lines the text already had and never breaking a formula. On versions of Chrome without automatic text-field sizing, the box being typed in now grows with its text instead of showing only its first line.
- Buttons no longer end in "…" (Split, Save as one PDF, Merge and save, Add PDFs).

## 2.11.2: fixes

- **Disabled buttons stay disabled-looking**: "Merge and save" (and the other main buttons) no longer light up under the pointer while they can't be used.
- **Split or extract into one PDF**: under the page ranges, choose **A file for each range** (as before) or **One PDF**, which saves all the ranges, in the order typed, as one new file, such as `notes (pages 10-12, 2, 5-6).pdf`. The choice is remembered.
- **Moving a page**: the drop line is gone. Instead the two pages either side of where the page would go ease apart to make room, and the small copy following the pointer says where it will land ("Page 2 → between 5 and 6", "→ first", "→ last", or "stays here").
- **Line breaks when pasting into a text box**: pasted text now always keeps its lines, whatever the source used to break them (Windows and old Mac line endings, Word's line breaks, Unicode line and paragraph separators), and a clipboard that only has formatted text (HTML) is turned into lines too. Saved text boxes with such line breaks are drawn on separate lines as well.
- **Text tool**: the tool goes back to the pointer as soon as a box is placed, while you type into it, rather than after the box is finished.

## 2.11.1: fixes

- **Save** no longer says "Saved over" when you save a file with the same name into a different folder. For a PDF opened from its file:// address (where Chrome gives no file handle to compare), Inkfold now reads the original back after saving and checks whether it's exactly what was written.
- **Split** no longer runs into Chrome's "Can't open this folder because it contains system files". That message came from the folder picker, which Chrome doesn't allow for Downloads, Documents or the Desktop themselves. Each part now gets its own save dialog, already named and in the same folder as the last, so it's usually just Enter; if Chrome needs another click to open the next dialog, a "Save part 2" button appears.
- **Ctrl +, Ctrl −, Ctrl 0** now always zoom the pages, never the whole window with its toolbar: they're caught first whatever has the focus (also while moving a page, with a dialog open, or in the find box), and recognised by the physical key, so they work with the number pad and on any keyboard layout. **Ctrl + mouse wheel** and touchpad pinch zoom the pages too.
- **Gear icon** redrawn: a proper eight-tooth gear in the same line style as the other icons, on a square button (it was on a wider button and looked stretched); the progress ring is a circle again.
- **Merge PDFs**: rows can only be dragged within the list, and "This PDF" can't be removed from it.
- **Moving a page**: the drop line glides between gaps instead of jumping, fades in, and only moves to a new gap once the pointer is clearly nearer it, so it doesn't flicker between two.
- **Text boxes and LaTeX**: math that spans lines (for example `$$` or `\[` on lines of their own, as copied from chat assistants and editors) now renders; `\[ … \]` is supported as display math. Magic paste's text box no longer breaks a formula when wrapping long lines, so its math renders the same as when pasting into a box you're typing in.
- **Text tool**: after you finish a new text box, the tool goes back to the pointer, with the box selected. Clicking away from a box you're typing in just ends it, rather than starting another one.

## 2.11.0: move pages, merge PDFs, pictures as pages

- **Move a page.** Right-click a page and choose **Move page** (or press M over it). The page lifts and a small copy of it follows the pointer; a line shows the gap it will drop into, between any two pages (or at either end, and between the two pages of a row in two-page view). Click to drop it. The window scrolls when you near its top or bottom. Arrow keys, Home and End move the line too; Enter drops, Esc cancels; Ctrl+Z puts it back.
- **Merge PDFs**, in the gear's Pages and file panel: **Add PDFs…** (pick several at once, or drop them on the panel), put them in order by dragging their grips (or ↑ ↓ on a focused grip), remove any with ×, then **Merge and save**, which asks where to save the new file. The open PDF, with your highlights, notes and page changes, is in the list until you remove it. Page counts are shown, and password-protected files are flagged. The open PDF itself isn't changed.
- **Pictures on a page, or as a page.** Adding a picture (with Add image, or a copied picture with Magic paste) now offers **Add to page N** (on the page, to move and resize, as before) or **Add as a new page after page N**: a page of its own, as wide as the PDF's pages and as tall as the picture needs, like a note. Image pages are labelled "image" in the page number.

## 2.10.0: faster opening, large files, and back where you left off

- **Opens about twice as fast.** Before, the viewer started the PDF reader's worker only once it was on screen, then waited a fixed 0.6 s to be sure it had started, and only then began reading the file. Now the worker, the reader and the file all start loading the moment the tab opens, and the worker is used as soon as it reports ready. A small PDF's first page shows in about 0.35 s instead of 0.9 s, and a 500-page PDF in about 0.5 s instead of 1.15 s (measured on the same machine).
- **Large files on your computer open quickly, and very large ones open at all.** A local PDF used to be passed through the extension as text, which was slow (about 1 s for a 6 MB scan) and failed for files over roughly 48 MB (the message got too big). It's now read by a small extension page in a hidden frame of the PDF's own tab, which can only read that tab's file, and handed over without copying: the 6 MB scan shows in about 0.7 s instead of 2.3 s, and a 64 MB file in under 1 s.
- **Large web PDFs show their first page before they've downloaded.** Inkfold reads web PDFs in pieces (where the server allows it), first page first. On a 4 Mbit/s connection a 64 MB scanned PDF shows its first page in about 11 s instead of more than 2 minutes, and a 500-page PDF in about 1.1 s instead of 3.3 s. Pages just outside the window wait until the first one is on screen, and text recognition, the compression check and building the text of every page start after that too.
- **Uses less memory with big files**: the file is no longer kept twice (once for showing, once for saving); a copy is made only when you save, split or compress.
- **Back where you left off.** Reopening a PDF goes to the same page, the same spot on it and the same zoom, with a "Go to page 1" button in the message. Remembered for your last 300 PDFs, by an anonymous fingerprint of the file, so it works wherever the file is opened from. Links to a page (`…pdf#page=12`) still open that page.
- Low-resolution-first drawing for scans was tried and left out: drawing a scanned page is almost all decoding its picture, which takes the same time at any size (about 130 ms for a 300 dpi page), so a blurry first pass wouldn't have appeared any sooner.

## 2.9.0: find by page, a gear for pages and file, centred toolbar

- **Find** (Ctrl+F, or the new magnifier button): type a word or phrase and get a list of the pages that mention it, each page once, with how many times and a snippet of the first match. Tab (or ↓) moves to the next page in the list and scrolls the PDF there; Shift+Tab (or ↑) goes back; Enter goes there and closes the list. Matches are lit up on the pages, brighter on the page in focus. Match case and Whole word options. Scanned pages are searched once their text is recognised, and your own text boxes are searched too.
- The **Pages** button is now a **gear** ("Pages and file", P). Its panel shows text recognition progress (with Stop) and how much smaller the file could be (with a Compress button), as well as the rotate, delete and split tools. While text is being recognised, a progress ring circles the gear; the floating progress card is gone.
- The page number and zoom now sit in the **middle of the toolbar**.
- The Save button no longer shows "(Ctrl+S)"; the shortcut is in its tooltip.
- Fixed: Save opened the folder above the original file's folder for PDFs picked with Open. It now opens the folder you picked the file from.

## 2.8.0: smarter undo and a new zoom control

- **Undo** and **Redo** are greyed out when there's nothing to undo or redo.
- The zoom drop-down is replaced by a capsule (− 125% +) that opens a zoom card: **Fit width** and **Fit page** with little previews, a large readout with a zoom slider (25% to 500%, snapping gently to the presets), and one-tap preset chips. The capsule shows a WIDTH or PAGE tag while a fit mode is on.

## 2.7.0: save over the original

- One **Save** button (Ctrl+S) instead of "Save as". Chrome's save dialog opens with the original file's name; confirm Chrome's "replace" prompt to write over the original, every time. Pick another name to keep it and save a copy.
- The dialog opens in the original's folder for PDFs opened with Open or dropped on Inkfold. For PDFs opened straight from your computer in Chrome, Inkfold remembers each folder separately, so from the second save there on the dialog opens in that folder.

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
