# Chrome Web Store submission

Everything the Chrome Web Store developer dashboard asks for, ready to paste. Images are in [`../store`](../store).

## Package

Run `scripts/package.sh` and upload `dist/inkfold-<version>.zip`.

## Store listing

**Name:** Inkfold

**Summary** (manifest description, 129 of 132 characters):

> Highlight, draw, add Markdown & LaTeX notes, and rotate, delete or split pages in any PDF. Private: nothing leaves your computer.

**Category:** Productivity → Tools (or Workflow & Planning)

**Language:** English

**Description:** paste [`store/description.txt`](../store/description.txt) as it is.

**Screenshots** (1280×800, captioned), in this order: `store/screenshot-1-annotate.png`, `screenshot-2-notes.png`, `screenshot-3-pages.png`, `screenshot-4-shortcuts.png`, `screenshot-5-private.png`

**Small promo tile** (440×280): `store/promo-small-440x280.png`

**Marquee promo tile** (1400×560): `store/promo-marquee-1400x560.png`

**Promo video:** the store takes a YouTube link. Upload `store/inkfold-promo.mp4` (30 s, 1280×720, no sound) to YouTube as Public or Unlisted, and paste its URL.

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
| `clipboardRead` | Reads clipboard text only when the user explicitly adds a note (button or N key), to turn their Markdown into a note page. The first time, a dialog shows exactly what will be used. |
| `offscreen` | One offscreen document (reasons `CLIPBOARD` and `BLOBS`) does two things a PDF tab can't do itself: reads the clipboard when the user adds a note (reading it from a web PDF's tab would prompt on behalf of that website), and reads the bytes of a local `file://` PDF the user opened (a file:// page can't read its own file). Nothing is sent anywhere. |
| `contextMenus` | A checkbox on the toolbar icon's right-click menu to turn automatic PDF opening on or off. |
| `storage` | Remembers the automatic-opening setting. |
| Host permission `<all_urls>` and content script on `http(s)://*/*` and `file:///*` | PDFs can be hosted on any site. The content script only checks `document.contentType`; on ordinary web pages it does nothing else. When the page is a PDF (and the user has automatic opening on, or clicks the toolbar icon), it replaces Chrome's built-in PDF viewer with Inkfold's viewer in the same tab and re-reads the PDF from its URL. Web pages are never read or modified. |

**Are you using remote code?** No. All JavaScript, including pdf.js, pdf-lib and MathJax, is bundled in the package. (In PDF tabs, the pdf.js worker is started from a blob copy of the bundled `lib/pdf.worker.min.mjs`, because pages can't start workers from extension URLs. The code is the same bundled file.) The only `eval`-like code in MathJax runs only under Node.js and is never reached in the browser.

**Data usage:** Inkfold does not collect or transmit any of the listed data types. Tick none of the categories, and certify:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/MeetCoding/inkfold/blob/main/PRIVACY.md

## Notes for the reviewer

```
To test: open any PDF link on the web (for example the PDF of any arXiv paper). It opens in Inkfold.
• Press H and drag across text to highlight it; R or O and drag to draw a shape.
• Copy any Markdown text, then press N to add a note page. A dialog explains this the first time.
• Press P to rotate, delete or split pages. Ctrl+S saves a new copy.
Automatic opening can be turned off from the toolbar icon's right-click menu. No account or setup is needed.
```
