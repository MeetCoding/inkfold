# Inkfold architecture

How the extension is put together, how it's tested, and the open design decisions. The user-facing overview is in
the [README](../README.md).

## Modules

```
background.js      Service worker: toolbar button, the "Open every PDF" menu, relays to the hidden page
content.js         Takes a PDF tab over: hides Chrome's viewer, starts the PDF worker early, mounts viewer.html
reader.js          Hidden frame that reads a local PDF's own file for its tab
offscreen.js       Hidden page: clipboard reads (Magic paste) and the OCR worker
ocr/worker.js      OCR worker: ONNX Runtime + the PaddleOCR models
ocr/paddle.js      OCR pipeline (detect, orient, read, split into words); plain JS, no DOM

viewer.js          The viewer: loading, pages on screen, tools, panels, find, OCR scheduling, saving
annotations.js     The annotation file format: write and read each kind (KINDS registry)          [Node-tested]
save.js            The PDF that Save, Split and Merge write (page order, rotation, crop, OCR text)  [Node-tested]
history.js         Undo and redo, kept as differences                                              [Node-tested]
find.js            Find: the box, matching, lighting matches up (pure parts tested)                 [Node-tested]
pages.js           Page ranges as typed ("2-4, 7, 10-end")                                         [Node-tested]
geometry.js        Merging selected text's word boxes into lines, for highlights                   [Node-tested]
paste.js           Is this Markdown?                                                               [Node-tested]
textbox.js         Text boxes: one layout, drawn as SVG on screen and as PDF operators when saved
notes.js           Markdown -> note pages
math.js            LaTeX -> vector paths (MathJax)
compress.js        Smaller copies: re-encodes big images, compresses streams
```

The seven modules marked *Node-tested* have no browser dependencies. They start with `// @ts-check` and are
type-checked by `npm run check`.

### State in the viewer

`viewer.js` keeps the document as two lists, and every change goes through `commit(snapshot())`:

- `entries`: one per page, in order: `{ id, doc, i, rot, crop? }`. `doc` is `'main'` (the opened file) or the
  key of an added page's own small PDF (a note or an image page).
- `shapes`: the annotations. Each is tied to an entry `id`, so it follows its page when pages move or are deleted.
  The format is described at the top of `annotations.js`.

Pictures are kept apart, in `imgs` (key -> data URL), so they're never copied into undo steps.

### Saving

`save.js` edits the original file rather than building a new one, so bookmarks, metadata and forms survive. In order:

1. Copy in the pages of added notes.
2. Put each page's inherited settings on the page itself, then apply its rotation and crop.
3. Replace Inkfold's own annotations (author "Inkfold") with the current set, through `annotations.writer`.
4. Write recognised text as invisible text.
5. Rebuild a flat page tree, then delete every object nothing reaches any more.

The last step is what makes deleted pages really gone from the saved file.

## Tests

| Command | What | Needs |
|---|---|---|
| `npm test` | Unit tests (`test/unit`): annotation round trips for every kind, save.js page operations, undo/redo, ranges, line merging, Markdown detection | Node 22 |
| `npm run test:e2e` | Browser tests (`test/e2e`), with the unpacked extension in headless Chrome (see below) | Chrome for Testing in `CHROME_PATH` |
| `npm run check` | Type checking of the `// @ts-check` modules | — |
| `npm run size` | What the package is made of, raw and zipped | — |
| `node scripts/ocr-check/compare.mjs …` | OCR speed and character error rate for one or more model folders | Python + Pillow, to make the test pages |

The browser tests do the following:

- **Annotate and save:** open a web PDF, draw each kind of annotation, undo and redo, rotate a page, save, check
  the file under Node, then reopen it and check every annotation is editable again.
- **Takeover:** a web PDF is taken over in its own tab, and left to Chrome when automatic opening is off.
- **OCR:** a scanned page is recognised and its text saved.

`showSaveFilePicker` is removed in the tests, so Save falls back to a download, which the tests read.

Branded Chrome no longer loads unpacked extensions from the command line, so the browser tests need Chrome for
Testing: `npx @puppeteer/browsers install chrome@stable`. CI (`.github/workflows/test.yml`) installs it.

## Measurements behind recent changes

- **Package size:** the zip was about 18.2 MB, and the OCR models were 12.1 MB of it. MathJax is only 0.7 MB
  zipped, so trimming it isn't worth the risk. The models now store their weights as float16 with a cast back to
  float32 (`scripts/models-fp16.py`), so they compute in float32 as before. On the six test pages from
  `scripts/ocr-check` (three fonts, four sizes, rotated and blurred pages), the text read is identical character
  for character, at the same speed. The zip is now about 11.7 MB.
- **Compression on the main thread:** a 5.9 MB PDF with a 2.3-megapixel photo, and a 401-page, 6.2 MB file, each
  took about 2 s to check. Neither caused a main-thread task longer than 184 ms, because `compress.js` yields
  between images. A worker would work: a blob module worker in a web tab can import the extension's
  web-accessible modules. It isn't needed until a real file shows long stalls.
- **OCR scheduling:** OCR already does the useful things. It reads the scanned page nearest the one in view first,
  one page at a time, with a Stop button, and the worker is released after a minute of idleness.
- **Model integrity:** checking the OCR models' hashes was considered and dropped. Chrome already verifies the
  contents of Web Store installs.

## Open decisions

### Permissions: `<all_urls>` and the always-on content script

Today `content.js` runs at `document_start` on every http(s) and file page and returns at once unless the page is a
PDF. That needs the `<all_urls>` host permission, which also covers loading the PDF itself from any site. The
Web Store reviews broad host permissions more closely, and users see "Read and change all your data on all
websites".

| Option | What changes | Cost |
|---|---|---|
| A. Keep as is | Nothing | The broad permission warning; review time |
| B. Register the content script only while "Open every PDF" is on (`chrome.scripting.registerContentScripts`), and use `activeTab` + `scripting.executeScript` for the toolbar button | No script runs on pages while automatic opening is off | Adds the `scripting` permission; the install warning stays, because automatic opening still needs `<all_urls>` |
| C. B, with `<all_urls>` moved to `optional_host_permissions`, asked for when the user turns automatic opening on (or on the welcome page) | Install shows no broad warning; toolbar-click annotation works with `activeTab` alone | Automatic opening becomes opt-in, which is a different first-run experience from today's "PDFs now open here" |
| D. Redirect PDF navigations to `viewer.html` (declarativeNetRequest) | No content script | The tab's address becomes the extension's, which breaks Gemini in Chrome reading the PDF, a headline feature. Not recommended. |

**C** is the only option that changes what users and reviewers see. It is a product decision, so it's left open.
**B** is a small, safe step either way, and its test (automatic opening off leaves PDFs to Chrome) is already in
`test/e2e/takeover.test.mjs`.

### Splitting viewer.js further

`viewer.js` is still about 3,200 lines of shared module-level state. These are the next seams, in order of how
cleanly they come apart:

1. ~~**Find**~~: done (`find.js`).
2. **OCR scheduling** (`autoOcr`, `pageImage`, `ocrItems`): `ocrItems` is pure and can move and be tested now.
3. **Merge and move-pages UI:** self-contained panels.
4. **Tools** (`down`/`move`/`up`, per tool): need a small shared state object (`tool`, `sel`, `drag`) first.
5. **Painting per kind:** move `paint`, `paintText` and `paintImage` into `annotations.js` alongside each kind's
   file format, once the drawing helpers they need (`view`, `grips`, `el`) are a module of their own.

Each step should keep the browser tests green. Each should also add unit tests where the moved code is pure.
