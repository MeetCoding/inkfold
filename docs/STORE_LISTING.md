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

**Description:**

```
Inkfold turns Chrome into a fast, private PDF annotator. Open any PDF and start marking it up: no account, no uploads, nothing to configure.

ANNOTATE
• Highlighter that follows the lines of real text, in any colour
• Rectangles and ellipses to call out figures, tables and anything else
• Move, resize, recolour and delete annotations at any time
• Undo and redo for everything

ADD NOTES WITH MARKDOWN AND LATEX
Copy some Markdown (from your notes app, an AI assistant or anywhere else), press N, and Inkfold adds a cleanly typeset note page after the page you're reading. Headings, lists, checklists, tables, code, quotes and links are supported, and so is LaTeX math: $inline$, $$display$$ and align-style environments, drawn as sharp vector graphics.

ORGANISE PAGES
• Rotate or delete single pages, or ranges like 2-4, 7, 10-end
• Split a PDF into several files in one step: 1-3, 4-8, 9-end
• Everything can be undone

READ COMFORTABLY
• Fit width, fit page and two-page view
• Smooth even on long documents
• Selectable, searchable text that works with Ctrl+F, screen readers and AI assistants in your browser

KEYBOARD FIRST
Every action has a shortcut, shown in brackets on its button. Press ? to see them all.

WORKS EVERYWHERE YOUR PDF GOES
Everything is saved as standard PDF annotations, so it shows up in Acrobat, Preview, Chrome's viewer and other apps, and stays editable when you reopen the file in Inkfold. Saving always creates a new copy; your original file is never changed.

PRIVATE BY DESIGN
Inkfold runs entirely in your browser. It has no servers, no analytics and no tracking, and your documents are never uploaded. It's open source: https://github.com/MeetCoding/inkfold

Good to know
• PDFs you open in Chrome open in Inkfold. To use Chrome's viewer instead, right-click the Inkfold icon and untick "Open every PDF with Inkfold".
• For PDFs on your computer, turn on "Allow access to file URLs" in Inkfold's details page.
```

**Screenshots** (1280×800): `store/screenshot-1-annotate.png`, `screenshot-2-notes.png`, `screenshot-3-pages.png`, `screenshot-4-shortcuts.png`

**Small promo tile** (440×280): `store/promo-small-440x280.png`

**Marquee promo tile** (1400×560): `store/promo-marquee-1400x560.png`

**Store icon** (128×128): `extension/icons/128.png`

**Homepage URL:** https://github.com/MeetCoding/inkfold

**Support URL:** https://github.com/MeetCoding/inkfold/issues

## Privacy practices tab

**Single purpose:**

> Inkfold lets users view and annotate PDF documents in Chrome (highlights, shapes, notes and page changes) and save the result as a new PDF.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `webNavigation` | Detects top-frame navigations to local `file://…pdf` URLs and opens them in the extension's viewer page (a page can't re-read its own local file, so these can't be opened in place). No browsing data is stored or sent. |
| `activeTab` | When the user clicks the toolbar icon on a tab showing a PDF, the viewer opens that PDF. |
| `clipboardRead` | Reads clipboard text only when the user explicitly adds a note (button or N key), to turn their Markdown into a note page. The first time, a dialog shows exactly what will be used. |
| `offscreen` | The clipboard is read in an offscreen document (reason `CLIPBOARD`), because the viewer may be running inside a web PDF's tab, where reading it directly would prompt on behalf of that website. Used only when the user adds a note. |
| `contextMenus` | A checkbox on the toolbar icon's right-click menu to turn automatic PDF opening on or off. |
| `storage` | Remembers the automatic-opening setting. |
| Host permission `<all_urls>` and content script on `http(s)://*/*` | PDFs can be hosted on any site. The content script only checks `document.contentType`; on ordinary web pages it does nothing else. When the page is a PDF (and the user has automatic opening on, or clicks the toolbar icon), it replaces Chrome's built-in PDF viewer with Inkfold's viewer in the same tab and re-reads the PDF from its URL. Web pages are never read or modified. |

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
