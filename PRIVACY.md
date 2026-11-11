# Inkfold privacy policy

_Last updated: 11 November 2026 (version 1.10.0)_

Inkfold is a Chrome extension for annotating PDFs. It is built so that your documents stay on your computer.

## The short version

Inkfold does not collect, store on any server, sell, or share any personal data. It has no accounts, no analytics, no advertising and no tracking. Everything it does happens inside your browser.

## What Inkfold handles, and where it goes

| What | How it's used | Where it goes |
|---|---|---|
| **PDF files you open** | Shown in Inkfold so you can read and annotate them. For PDFs on the web, Inkfold reads the file again (usually from your browser's cache) from the site it came from. | Stays in your browser. Inkfold never sends it anywhere else. If you choose to share a tab with a browser assistant (such as Gemini in Chrome), that is between you and that assistant. |
| **Your annotations, notes and page changes** | Kept in memory while the PDF is open, and written into a new PDF file when you save or split. | Only into files you save, in folders you choose. |
| **Clipboard text** | Read only when you open **Add a note** (the **+ Note** button or the <kbd>N</kbd> key), so the dialog can offer it; it becomes a note page only if you choose it. | Stays in your browser. It is not stored or sent anywhere. |
| **Settings** | Whether PDFs open in Inkfold automatically, your last colours and zoom, and which tips you have already seen. | Stored locally in Chrome's extension storage on your device. |

Inkfold makes no network requests other than loading the PDF you chose to open. All the libraries it uses (pdf.js, pdf-lib, MathJax) are bundled inside the extension. No code is loaded from the internet.

## Permissions

Inkfold asks for permissions only to do the job described above:

- **Access to all websites**: a small script checks whether a page is a PDF. Only if it is does Inkfold replace Chrome's built-in PDF viewer in that tab. It also lets Inkfold load the PDF from whichever site it's on. Inkfold never reads or changes ordinary web pages.
- **activeTab**: to open the PDF in your current tab when you click the toolbar icon.
- **clipboardRead** and **offscreen**: to read the text you copied, only when you open **Add a note**, and to read a PDF file from your computer when you open it in Chrome. Both happen in a hidden page of the extension's own, on your device.
- **contextMenus** and **storage**: for the option to turn automatic opening on or off, and to remember that setting.

## Data sharing and sale

Inkfold does not transfer user data to anyone, does not sell it, and does not use it for any purpose other than the features above. It does not use data for advertising, credit decisions or lending.

## Children

Inkfold does not knowingly collect any information from anyone, including children.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Questions or concerns: please open an issue at <https://github.com/MeetCoding/inkfold/issues>.
