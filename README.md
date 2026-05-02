# PDF Extractor Plus

![PDF Extractor Plus](images/logo1.ico)

Extract, search, batch-export, and preview PDF text inside VS Code. Optional **OCR from images** (Tesseract) for scans when you export pages as PNG/JPEG.

## Features

| Area | What you get |
|------|----------------|
| **Extract** | Right-click a PDF or use the Command Palette; pick a file if nothing is selected. Opens a **preview** editor **beside** the current column. |
| **Rich preview** | Webview with **live search** and highlight (case-insensitive). Also available from the success notification and Explorer. |
| **Save / copy** | Save as `.txt` (with settings below), or copy full text to the clipboard. |
| **Batch folder** | Right-click a **folder** in the Explorer → **Batch Extract Folder to .txt** — writes one `.txt` per PDF (recursive optional). |
| **Workspace search** | Command **Search Text in Workspace PDFs** — extracts each PDF (up to a limit) and lists files containing your query; pick one to open **rich preview**. |
| **Settings** | `lineEnding`, `encoding` (UTF-8 / UTF-16 LE + BOM), optional **page separators** when the PDF uses form-feed breaks (`\f`), **default output folder**, **batch recursive**, **search max files**, **OCR language**, and **offer OCR when extract is empty**. |
| **OCR (images)** | Command **OCR Text from Image(s)** — Tesseract on PNG/JPEG/WebP/TIFF/BMP (multi-file). First run may download language data; keep network allowed if prompted. |
| **OCR scanned PDF** | Command **OCR Scanned PDF** — renders each page in a **webview** with **PDF.js** (browser canvas), then **Tesseract** on the extension host. No Node `canvas` build; good default path for image-only PDFs. Tune `pdfExtractor.ocrPdfMaxPages` and `pdfExtractor.ocrPdfRenderScale`. |
| **Scanned PDFs** | When extract finds **no embedded text**, the extension can offer **OCR scanned PDF**, **OCR from images**, or docs — no external page export required for the webview path. |

## Explorer

**On a `.pdf` file**

- Extract Text (Preview)  
- Rich Preview (Search)  
- Extract Text to .txt File  
- Copy PDF Text to Clipboard  
- OCR Scanned PDF (render + Tesseract)  

**On a folder**

- Batch Extract Folder to .txt  

## Commands

| Command ID | Title |
|------------|--------|
| `pdfExtractor.extract` | PDF Extractor Plus: Extract Text (Preview) |
| `pdfExtractor.previewWebview` | PDF Extractor Plus: Rich Preview (Search) |
| `pdfExtractor.extractAndSave` | PDF Extractor Plus: Extract Text to .txt File |
| `pdfExtractor.copyExtracted` | PDF Extractor Plus: Copy PDF Text to Clipboard |
| `pdfExtractor.batchExtract` | PDF Extractor Plus: Batch Extract Folder to .txt |
| `pdfExtractor.searchWorkspacePdfs` | PDF Extractor Plus: Search Text in Workspace PDFs |
| `pdfExtractor.ocrFromImages` | PDF Extractor Plus: OCR Text from Image(s) |
| `pdfExtractor.ocrScannedPdf` | PDF Extractor Plus: OCR Scanned PDF (render + Tesseract) |

## Settings (`pdfExtractor.*`)

- **`lineEnding`**: `auto` \| `lf` \| `crlf`  
- **`encoding`**: `utf8` \| `utf16le`  
- **`pageSeparatorEnabled`** / **`pageSeparatorTemplate`**: insert `{n}` between pages when `\f` breaks exist  
- **`defaultOutputFolder`**: absolute path for save dialog default and batch output  
- **`batchRecursive`**: include subfolders in batch  
- **`searchMaxFiles`**: cap for batch + workspace search (1–2000)  
- **`offerOcrWhenEmpty`**: show OCR hint when extract finds no text  
- **`ocrLanguage`**: Tesseract language code (e.g. `eng`)
- **`ocrPdfMaxPages`**: cap pages processed for **OCR scanned PDF** (1–500, default 150)
- **`ocrPdfRenderScale`**: PDF.js render scale before max-dimension fit (0.5–3, default 1.4)

## Requirements

- VS Code `^1.115.0`  
- **Workspace search** and **recursive batch** need a **folder** opened in VS Code.  
- **OCR**: uses bundled Tesseract.js; first use of a language may require **network** for traineddata.

## Developing this extension

Clone the repo, open the `pdfextractor` folder in VS Code, run `npm install`, then **Run → Start Debugging** (F5) to launch an Extension Development Host. Commands live in `extension.js`; **OCR scanned PDF** uses a webview (bundled `pdfjs-dist` from `node_modules`) plus `tesseract.js` in the Node extension host. Package with `npm run vsce:package` (requires `@vscode/vsce`).

## Known limitations

- **OCR scanned PDF** is CPU/memory intensive on long documents; reduce **`ocrPdfMaxPages`** / **`ocrPdfRenderScale`** if needed. Encrypted or malformed PDFs may fail in PDF.js.  
- Workspace search and batch are **CPU-heavy** on huge trees; tune **`searchMaxFiles`**.  
- Layout-heavy PDFs may still have imperfect text order.

## Release notes

See [CHANGELOG.md](CHANGELOG.md).
