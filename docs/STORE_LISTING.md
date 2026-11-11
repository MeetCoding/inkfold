# Chrome Web Store submission

Everything the Chrome Web Store developer dashboard asks for, ready to paste. Images are in [`../store`](../store).

## Package

Run `scripts/package.sh` and upload `dist/inkfold-<version>.zip`.

## Store listing

**Name:** Inkfold

**Summary** (manifest description, 131 of 132 characters):

> Highlight, draw, add text with LaTeX and notes, OCR scans, and rotate, delete or split pages in any PDF. Private, nothing uploaded.

**Category:** Productivity → Tools (or Workflow & Planning)

**Language:** English

**Description:** paste [`store/description.txt`](../store/description.txt) as it is.

**Screenshots** (1280×800, captioned), in this order: `store/screenshot-1-annotate.png`, `screenshot-2-notes.png`, `screenshot-3-pages.png`, `screenshot-4-shortcuts.png`, `screenshot-5-ocr.png`

**Small promo tile** (440×280): `store/promo-small-440x280.png`

**Marquee promo tile** (1400×560): `store/promo-marquee-1400x560.png`

**Promo video:** the store takes a YouTube link. Upload `store/inkfold-promo.mp4` (37 s, 1280×720, no sound) to YouTube as Public or Unlisted, and paste its URL.

**Store icon** (128×128): `extension/icons/128.png`

**Homepage URL:** https://github.com/MeetCoding/inkfold

**Support URL:** https://github.com/MeetCoding/inkfold/issues

## Privacy practices tab

**Single purpose:**

> Inkfold lets users view and annotate PDF documents in Chrome (highlights, shapes, notes and page changes) and save the result as a new PDF.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | When the user clicks the toolbar icon on a tab showing a PDF, the viewer opens that PDF. |
| `clipboardRead` | Reads the clipboard only when the user explicitly uses "Magic paste" (the toolbar button or Ctrl+V). A small card shows what was copied (a picture, Markdown or text) and offers to add it; nothing is used unless the user picks an option. |
| `offscreen` | One offscreen document (reasons `CLIPBOARD`, `BLOBS` and `WORKERS`) does three things a PDF tab can't do itself: reads the clipboard when the user opens "Add a note" (reading it from a web PDF's tab would prompt on behalf of that website); reads the bytes of a local `file://` PDF the user opened (a file:// page can't read its own file); and runs the bundled Tesseract OCR engine in a worker, to recognise text on scanned pages of the PDF the user opened. Nothing is sent anywhere. |
| `contextMenus` | A checkbox on the toolbar icon's right-click menu to turn automatic PDF opening on or off. |
| `storage` | Remembers the automatic-opening setting. |
| Host permission `<all_urls>` and content script on `http(s)://*/*` and `file:///*` | PDFs can be hosted on any site. The content script only checks `document.contentType`; on ordinary web pages it does nothing else. When the page is a PDF (and the user has automatic opening on, or clicks the toolbar icon), it replaces Chrome's built-in PDF viewer with Inkfold's viewer in the same tab and re-reads the PDF from its URL. Web pages are never read or modified. |

**Are you using remote code?** No. All JavaScript and WebAssembly, including pdf.js, pdf-lib, MathJax and the Tesseract OCR engine (tesseract.js, its WebAssembly core and the English language model), is bundled in the package; nothing is downloaded at run time. (In PDF tabs, the pdf.js worker is started from a blob copy of the bundled `lib/pdf.worker.min.mjs`, because pages can't start workers from extension URLs. The code is the same bundled file.) The only `eval`-like code in MathJax runs only under Node.js and is never reached in the browser.

**Data usage:** Inkfold does not collect or transmit any of the listed data types. Tick none of the categories, and certify:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/MeetCoding/inkfold/blob/main/PRIVACY.md

## Notes for the reviewer

```
To test: open any PDF link on the web (for example the PDF of any arXiv paper). It opens in Inkfold.
• Press H and drag across text to highlight it; R or O and drag to draw a shape; T and click to type a text box (LaTeX between $ signs works).
• Press N to type a note page, or copy some Markdown and press Ctrl+V (Magic paste).
• Open a scanned PDF (no text layer): text is recognised in the background, with a small progress bar, and becomes selectable. Saved copies contain it as invisible text.
• Open a PDF with large images (several MB): a card offers to compress it.
• Right-click a page to rotate or delete it; press P to work on ranges or split. Ctrl+S saves a new copy.
Automatic opening can be turned off from the toolbar icon's right-click menu. No account or setup is needed.
```
