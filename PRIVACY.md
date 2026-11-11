# Inkfold privacy policy

_Last updated: 11 November 2026_

Inkfold is a Chrome extension for annotating PDFs. It is built so that your documents stay on your computer.

## The short version

Inkfold does not collect, store on any server, sell, or share any personal data. It has no accounts, no analytics, no advertising and no tracking. Everything it does happens inside your browser.

## What Inkfold handles, and where it goes

| What | How it's used | Where it goes |
|---|---|---|
| **PDF files you open** | Shown in Inkfold so you can read and annotate them. For PDFs on the web, Inkfold downloads the file again from the site it came from, using your browser's normal sign-in for that site. | Stays in your browser. Never sent anywhere else. |
| **Your annotations, notes and page changes** | Kept in memory while the PDF is open, and written into a new PDF file when you save or split. | Only into files you save, in folders you choose. |
| **Clipboard text** | Read only when you add a note (the **+ Note** button or the <kbd>N</kbd> key), and turned into a note page. | Stays in your browser. It is not stored or sent anywhere. |
| **Settings** | Whether PDFs open in Inkfold automatically, your last colours and zoom, and which tips you have already seen. | Stored locally in Chrome's extension storage on your device. |

Inkfold makes no network requests other than loading the PDF you chose to open. All the libraries it uses (pdf.js, pdf-lib, MathJax) are bundled inside the extension. No code is loaded from the internet.

## Permissions

Inkfold asks for permissions only to do the job described above:

- **Access to all websites**: to load a PDF from whichever site it's on, and to open PDF pages in Inkfold instead of Chrome's built-in viewer. Inkfold never reads or changes ordinary web pages.
- **declarativeNetRequestWithHostAccess** and **webNavigation**: to detect when you open a PDF (on the web or from your computer) and show it in Inkfold.
- **activeTab**: to open the PDF in your current tab when you click the toolbar icon.
- **clipboardRead**: to read the text you copied, only when you add a note.
- **contextMenus** and **storage**: for the option to turn automatic opening on or off, and to remember that setting.

## Data sharing and sale

Inkfold does not transfer user data to anyone, does not sell it, and does not use it for any purpose other than the features above. It does not use data for advertising, credit decisions or lending.

## Children

Inkfold does not knowingly collect any information from anyone, including children.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Questions or concerns: please open an issue at <https://github.com/MeetCoding/inkfold/issues>.
