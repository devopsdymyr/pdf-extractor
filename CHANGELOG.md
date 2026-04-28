# Change Log

All notable changes to the "pdfextractor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.3]

- Command Palette and file picker when no PDF is right-clicked.
- Extract with preview beside the editor; progress while parsing.
- After extract: copy, save as `.txt`, or **Rich preview** (webview search + highlight).
- **Settings**: line endings, encoding (UTF-8 / UTF-16 LE), page separator template, default output folder, batch recursive, search max files, OCR language, offer OCR when empty.
- **Batch extract folder** to `.txt` (Explorer on folder; respects settings + max files).
- **Search text in workspace PDFs** with quick-pick results → rich preview.
- **OCR from images** via Tesseract.js (multi-image); hint when PDF has no embedded text.
- Explorer context menus for PDF actions and folder batch.

## [0.0.2]

- Normalize unusual PDF line separators before previewing extracted text.
- Improve extraction robustness with better error handling.
- Update Marketplace metadata and icon packaging.