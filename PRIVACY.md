# Inkfold privacy policy

_Last updated: 11 November 2026 (version 2.16.0)_

Inkfold is a Chrome extension for annotating PDFs. It is built so that your documents stay on your computer.

## The short version

Inkfold does not collect, store on any server, sell, or share any personal data. It has no accounts, no analytics, no advertising and no tracking. Everything it does happens inside your browser.

## What Inkfold handles, and where it goes

| What | How it's used | Where it goes |
|---|---|---|
| **PDF files you open** | Shown in Inkfold so you can read and annotate them. For PDFs on the web, Inkfold reads the file again (usually from your browser's cache) from the site it came from. | Stays in your browser. Inkfold never sends it anywhere else. If you choose to share a tab with a browser assistant (such as Gemini in Chrome), that is between you and that assistant. |
| **Your annotations, notes and page changes** | Kept in memory while the PDF is open, and written into a PDF file when you save (over the original, if you confirm that) or split. | Only into files you save, in folders you choose. |
| **Clipboard text and pictures** | Read only when you use **Magic paste** (the clipboard button or <kbd>Ctrl</kbd>+<kbd>V</kbd>), so Inkfold can show what you copied and offer what to do with it; it's used only if you choose an option. | Stays in your browser. It is not stored or sent anywhere, except into copies you save if you add it. |
| **Pictures and PDFs you add** | Pictures are read only when you pick one with **Add an image**, and placed on a page or on a new page. PDFs you add to **Merge PDFs** are read only to count their pages and to merge them into the file you save. | Stays in your browser, and goes only into copies you save. |
| **Images of scanned pages** | When a PDF has pages without text, Inkfold renders those pages as images and recognises their text, in a hidden page of the extension, with the text-recognition engine bundled in the extension. | Stays in your browser. The recognised text is kept in memory, and written only into copies you save. |
| **Settings and reading places** | Whether PDFs open in Inkfold automatically, your last colours and zoom, which tips you have already seen, and, for each of your last 300 PDFs, the page and zoom you were at (kept under an anonymous fingerprint of the file, not its name or contents). | Stored locally in Chrome's extension storage on your device. |
| **Which files Save may write to** | For a PDF opened straight from your computer and then saved over, Chrome's handle to that file (which lets Chrome ask, next time, only for permission to save changes to it), kept under the file's address. | Stored locally in your browser (IndexedDB), on your device only; the 300 most recently saved files. Chrome still asks your permission before Inkfold writes to the file. |

Inkfold makes no network requests other than loading the PDF you chose to open. All the libraries it uses (pdf.js, pdf-lib, MathJax, and, for text recognition, ONNX Runtime with PaddleOCR's models) are bundled inside the extension. No code or data is loaded from the internet. Checking whether a PDF can be compressed, and compressing it, also happens entirely in your browser; Inkfold remembers only an anonymous fingerprint of PDFs it has already checked, so it asks just once.

## Permissions

Inkfold asks for permissions only to do the job described above:

- **Access to all websites**: a small script checks whether a page is a PDF. Only if it is does Inkfold replace Chrome's built-in PDF viewer in that tab. It also lets Inkfold load the PDF from whichever site it's on. Inkfold never reads or changes ordinary web pages.
- **activeTab**: to open the PDF in your current tab when you click the toolbar icon.
- **clipboardRead** and **offscreen**: to read the text or picture you copied, only when you use **Magic paste**, and to recognise text on scanned pages. Both happen in a hidden page of the extension's own, on your device. (A PDF you open from your computer is read by a small page of the extension inside that PDF's own tab, which can only read that one file.)
- **contextMenus** and **storage**: for the option to turn automatic opening on or off, to remember your settings, and to remember where you were in each PDF.

## Data sharing and sale

Inkfold does not transfer user data to anyone, does not sell it, and does not use it for any purpose other than the features above. It does not use data for advertising, credit decisions or lending.

## Children

Inkfold does not knowingly collect any information from anyone, including children.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Questions or concerns: please open an issue at <https://github.com/MeetCoding/inkfold/issues>.
