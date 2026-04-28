const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

function normalizeExtractedText(text) {
	return text
		.replace(/\u2028/g, '\n')
		.replace(/\u2029/g, '\n\n')
		.replace(/\u0085/g, '\n');
}

/**
 * @param {string} raw
 * @param {string} template use {n} for page index (1-based)
 */
function applyPageSeparators(raw, template) {
	if (!raw.includes('\f')) {
		return raw;
	}
	const parts = raw.split('\f');
	return parts
		.map((chunk, idx) => {
			const sep = idx < parts.length - 1 ? template.replace(/\{n\}/g, String(idx + 1)) : '';
			return chunk + sep;
		})
		.join('');
}

/**
 * @param {string} text
 * @param {'auto' | 'lf' | 'crlf'} mode
 */
function applyLineEndings(text, mode) {
	if (mode === 'lf') {
		return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	}
	if (mode === 'crlf') {
		return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
	}
	return text;
}

/**
 * @param {string} text
 * @param {'utf8' | 'utf16le'} encoding
 */
function encodeText(text, encoding) {
	if (encoding === 'utf16le') {
		return Buffer.from(`\uFEFF${text}`, 'utf16le');
	}
	return Buffer.from(text, 'utf8');
}

function getPdfConfig() {
	return vscode.workspace.getConfiguration('pdfExtractor');
}

/**
 * @param {vscode.Uri | undefined} uri
 * @returns {Promise<vscode.Uri | null>}
 */
async function resolvePdfUri(uri) {
	if (uri?.fsPath && uri.fsPath.toLowerCase().endsWith('.pdf')) {
		return uri;
	}
	const active = vscode.window.activeTextEditor;
	const activePath = active?.document?.uri?.fsPath;
	if (activePath && activePath.toLowerCase().endsWith('.pdf')) {
		return active.document.uri;
	}
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { PDF: ['pdf', 'PDF'] },
		openLabel: 'Select PDF'
	});
	return picked?.[0] ?? null;
}

/**
 * @param {vscode.Uri} pdfUri
 */
async function extractPdfData(pdfUri) {
	const config = getPdfConfig();
	const buffer = await fs.promises.readFile(pdfUri.fsPath);
	const result = await pdf(buffer);
	let raw = result.text || '';
	if (config.get('pageSeparatorEnabled')) {
		const tpl = config.get('pageSeparatorTemplate') ?? '\n\n--- Page {n} ---\n\n';
		raw = applyPageSeparators(raw, tpl);
	}
	const text = normalizeExtractedText(raw);
	return {
		text,
		numpages: result.numpages ?? 0,
		sourcePath: pdfUri.fsPath
	};
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} title
 * @param {string} fullText
 */
function openRichPreviewWebview(context, title, fullText) {
	const panel = vscode.window.createWebviewPanel(
		'pdfExtractorRichPreview',
		title,
		vscode.ViewColumn.Beside,
		{ enableScripts: true, retainContextWhenData: true }
	);
	panel.webview.html = buildPreviewHtml(fullText);
	context.subscriptions.push(panel);
}

/**
 * @param {string} fullText
 */
function buildPreviewHtml(fullText) {
	const payload = JSON.stringify(fullText);
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background);
    margin: 0; padding: 8px; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; }
  #bar { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
  #q { flex: 1; min-width: 140px; padding: 6px 10px; }
  #meta { opacity: 0.85; font-size: 12px; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #out { flex: 1; overflow: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid var(--vscode-panel-border);
    padding: 10px; font-family: var(--vscode-editor-font-family); font-size: 13px; line-height: 1.45; }
  mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; padding: 0 1px; }
</style></head><body>
<div id="bar"><label for="q">Search</label><input id="q" type="search" placeholder="Filter & highlight…" /><span id="meta"></span></div>
<div id="out"></div>
<script>
(function(){
  const fullText = ${payload};
  const out = document.getElementById('out');
  const q = document.getElementById('q');
  const meta = document.getElementById('meta');
  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function render() {
    const query = (q.value || '');
    if (!query.trim()) {
      out.textContent = fullText;
      meta.textContent = fullText.length.toLocaleString() + ' characters';
      return;
    }
    const needle = query;
    const fl = fullText.toLowerCase();
    const nl = needle.toLowerCase();
    let html = '';
    let pos = 0;
    let matches = 0;
    while (pos <= fullText.length) {
      const i = fl.indexOf(nl, pos);
      if (i < 0) {
        html += escapeHtml(fullText.slice(pos));
        break;
      }
      html += escapeHtml(fullText.slice(pos, i));
      html += '<mark>' + escapeHtml(fullText.slice(i, i + needle.length)) + '</mark>';
      matches++;
      pos = i + needle.length;
    }
    out.innerHTML = html;
    meta.textContent = matches + ' match(es) · ' + fullText.length.toLocaleString() + ' characters';
  }
  q.addEventListener('input', render);
  render();
})();
</script></body></html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri | undefined} uri
 * @param {{ previewBeside?: boolean }} [options]
 */
async function runExtraction(context, uri, options = {}) {
	const pdfUri = await resolvePdfUri(uri);
	if (!pdfUri) {
		vscode.window.showErrorMessage('No PDF selected. Pick a PDF file or open a PDF in the editor.');
		return null;
	}

	let data;
	try {
		data = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'PDF Extractor Plus',
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: 'Reading and parsing PDF…' });
				return extractPdfData(pdfUri);
			}
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to extract PDF text: ${message}`);
		return null;
	}

	const config = getPdfConfig();
	if (!data.text.trim()) {
		if (config.get('offerOcrWhenEmpty')) {
			const pick = await vscode.window.showWarningMessage(
				'No embedded text found (common for scanned PDFs). Try OCR from images, or export pages as PNG/JPEG.',
				'OCR from images',
				'Learn more'
			);
			if (pick === 'OCR from images') {
				await ocrFromImages(context);
			} else if (pick === 'Learn more') {
				vscode.env.openExternal(vscode.Uri.parse('https://github.com/devopsdymyr/pdf-extractor#readme'));
			}
		} else {
			vscode.window.showWarningMessage('No readable text was found in this PDF.');
		}
		return null;
	}

	const doc = await vscode.workspace.openTextDocument({
		content: data.text,
		language: 'plaintext'
	});

	const viewColumn = options.previewBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
	await vscode.window.showTextDocument(doc, {
		viewColumn,
		preview: true,
		preserveFocus: false
	});

	const charCount = data.text.length;
	const summary = `${data.numpages} page(s), ${charCount.toLocaleString()} characters extracted.`;
	vscode.window.showInformationMessage(summary, 'Copy text', 'Save as .txt', 'Rich preview').then((choice) => {
		if (choice === 'Copy text') {
			vscode.env.clipboard.writeText(data.text).then(
				() => vscode.window.showInformationMessage('Extracted text copied to clipboard.'),
				() => vscode.window.showErrorMessage('Could not copy to clipboard.')
			);
		} else if (choice === 'Save as .txt') {
			saveExtractedAsTxt(data.sourcePath, data.text);
		} else if (choice === 'Rich preview') {
			openRichPreviewWebview(context, path.basename(data.sourcePath), data.text);
		}
	});

	return data;
}

/**
 * @param {string} sourcePdfPath
 * @param {string} text
 */
async function saveExtractedAsTxt(sourcePdfPath, text) {
	const config = getPdfConfig();
	const base = path.basename(sourcePdfPath, path.extname(sourcePdfPath));
	const outFolder = (config.get('defaultOutputFolder') || '').trim();
	let defaultUri;
	if (outFolder) {
		defaultUri = vscode.Uri.file(path.join(outFolder, `${base}.txt`));
	} else {
		defaultUri = vscode.Uri.file(path.join(path.dirname(sourcePdfPath), `${base}.txt`));
	}

	const saveUri = await vscode.window.showSaveDialog({
		defaultUri,
		filters: { Text: ['txt'] },
		saveLabel: 'Save extracted text'
	});
	if (!saveUri) {
		return;
	}
	try {
		const lineMode = config.get('lineEnding') || 'auto';
		const enc = config.get('encoding') || 'utf8';
		const body = encodeText(applyLineEndings(text, lineMode), enc);
		await vscode.workspace.fs.writeFile(saveUri, body);
		vscode.window.showInformationMessage(`Saved: ${saveUri.fsPath}`, 'Open').then((c) => {
			if (c === 'Open') {
				vscode.workspace.openTextDocument(saveUri).then((d) => vscode.window.showTextDocument(d));
			}
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`Save failed: ${msg}`);
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri | undefined} folderUri
 */
async function batchExtract(_context, folderUri) {
	const config = getPdfConfig();
	let folder = folderUri;
	if (!folder?.fsPath) {
		const picked = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: 'Folder containing PDFs'
		});
		folder = picked?.[0];
	}
	if (!folder) {
		return;
	}

	const recursive = config.get('batchRecursive') !== false;
	const glob = recursive ? '**/*.pdf' : '*.pdf';
	const maxFiles = Math.min(Math.max(Number(config.get('searchMaxFiles')) || 200, 1), 2000);
	const pattern = new vscode.RelativePattern(folder, glob);
	const pdfs = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxFiles);
	if (!pdfs.length) {
		vscode.window.showInformationMessage('No PDF files found in that folder.');
		return;
	}

	let outputFolderUri;
	const defaultOut = (config.get('defaultOutputFolder') || '').trim();
	if (defaultOut) {
		outputFolderUri = vscode.Uri.file(defaultOut);
	} else {
		const outPick = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: 'Output folder for .txt files'
		});
		outputFolderUri = outPick?.[0];
	}
	if (!outputFolderUri) {
		return;
	}

	let done = 0;
	let skipped = 0;
	let failed = 0;
	const lineMode = config.get('lineEnding') || 'auto';
	const enc = config.get('encoding') || 'utf8';

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'PDF Extractor Plus: batch extract',
			cancellable: true
		},
		async (progress, token) => {
			const total = pdfs.length;
			for (let i = 0; i < total; i++) {
				if (token.isCancellationRequested) {
					break;
				}
				const pdfUri = pdfs[i];
				progress.report({
					message: `${i + 1}/${total} ${path.basename(pdfUri.fsPath)}`
				});
				try {
					const data = await extractPdfData(pdfUri);
					if (!data.text.trim()) {
						skipped++;
						continue;
					}
					const outName = `${path.basename(pdfUri.fsPath, path.extname(pdfUri.fsPath))}.txt`;
					const outUri = vscode.Uri.joinPath(outputFolderUri, outName);
					const body = encodeText(applyLineEndings(data.text, lineMode), enc);
					await vscode.workspace.fs.writeFile(outUri, body);
					done++;
				} catch {
					failed++;
				}
			}
		}
	);

	vscode.window.showInformationMessage(
		`Batch finished: ${done} saved, ${skipped} empty/skipped, ${failed} failed.`
	);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function searchWorkspacePdfs(context) {
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showWarningMessage('Open a folder workspace to search PDFs.');
		return;
	}

	const query = await vscode.window.showInputBox({
		title: 'Search inside PDF text',
		prompt: 'Runs text extraction on each PDF (can be slow on large workspaces).'
	});
	if (!query) {
		return;
	}

	const config = getPdfConfig();
	const maxFiles = Math.min(Math.max(Number(config.get('searchMaxFiles')) || 200, 1), 2000);
	const pdfs = await vscode.workspace.findFiles('**/*.pdf', '**/node_modules/**', maxFiles);
	if (!pdfs.length) {
		vscode.window.showInformationMessage('No PDF files found in the workspace.');
		return;
	}

	const qLower = query.toLowerCase();
	/** @type {{ pdfUri: vscode.Uri, snippet: string }[]} */
	const hits = [];

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'PDF Extractor Plus: searching PDFs',
			cancellable: true
		},
		async (progress, token) => {
			const total = pdfs.length;
			for (let i = 0; i < total; i++) {
				if (token.isCancellationRequested) {
					break;
				}
				const pdfUri = pdfs[i];
				progress.report({
					message: `${i + 1}/${total}`
				});
				try {
					const data = await extractPdfData(pdfUri);
					const lower = data.text.toLowerCase();
					const idx = lower.indexOf(qLower);
					if (idx >= 0) {
						const snippet = data.text.slice(Math.max(0, idx - 50), idx + query.length + 80).replace(/\s+/g, ' ');
						hits.push({ pdfUri, snippet });
					}
				} catch {
					// skip broken pdf
				}
			}
		}
	);

	if (!hits.length) {
		vscode.window.showInformationMessage('No matches in extracted PDF text.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		hits.map((h, idx) => ({
			label: path.basename(h.pdfUri.fsPath),
			description: h.snippet,
			idx
		})),
		{
			matchOnDescription: true,
			placeHolder: `${hits.length} match(es) — pick a PDF to open rich preview`
		}
	);

	if (picked && typeof picked.idx === 'number') {
		const pdfUri = hits[picked.idx].pdfUri;
		const data = await extractPdfData(pdfUri);
		if (data.text.trim()) {
			openRichPreviewWebview(context, path.basename(pdfUri.fsPath), data.text);
		}
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function ocrFromImages(context) {
	const config = getPdfConfig();
	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: true,
		filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'] },
		openLabel: 'Select image(s) for OCR'
	});
	if (!uris?.length) {
		return;
	}

	const lang = (config.get('ocrLanguage') || 'eng').trim() || 'eng';
	let combined = '';

	try {
		const { createWorker } = require('tesseract.js');
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'PDF Extractor Plus: OCR',
				cancellable: false
			},
			async (progress) => {
				const worker = await createWorker(lang);
				try {
					for (let i = 0; i < uris.length; i++) {
						progress.report({ message: `Image ${i + 1}/${uris.length}` });
						const buf = Buffer.from(await vscode.workspace.fs.readFile(uris[i]));
						const {
							data: { text }
						} = await worker.recognize(buf);
						combined += (text || '').trim() + '\n\n';
					}
				} finally {
					await worker.terminate();
				}
			}
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`OCR failed: ${msg}`);
		return;
	}

	combined = normalizeExtractedText(combined).trim();
	if (!combined) {
		vscode.window.showWarningMessage('OCR produced no text.');
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		`OCR complete (${combined.length.toLocaleString()} characters).`,
		'Rich preview',
		'Copy',
		'Save as .txt'
	);
	if (choice === 'Rich preview') {
		openRichPreviewWebview(context, 'OCR result', combined);
	} else if (choice === 'Copy') {
		await vscode.env.clipboard.writeText(combined);
		vscode.window.showInformationMessage('OCR text copied to clipboard.');
	} else if (choice === 'Save as .txt') {
		const saveUri = await vscode.window.showSaveDialog({
			filters: { Text: ['txt'] },
			saveLabel: 'Save OCR text'
		});
		if (saveUri) {
			const lineMode = config.get('lineEnding') || 'auto';
			const enc = config.get('encoding') || 'utf8';
			await vscode.workspace.fs.writeFile(saveUri, encodeText(applyLineEndings(combined, lineMode), enc));
			vscode.window.showInformationMessage(`Saved: ${saveUri.fsPath}`);
		}
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri | undefined} uri
 */
async function previewWebviewCommand(context, uri) {
	const pdfUri = await resolvePdfUri(uri);
	if (!pdfUri) {
		return;
	}
	let data;
	try {
		data = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'PDF Extractor Plus',
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: 'Extracting for preview…' });
				return extractPdfData(pdfUri);
			}
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to extract PDF text: ${message}`);
		return;
	}
	if (!data.text.trim()) {
		vscode.window.showWarningMessage('No readable text — try OCR from images for scans.');
		return;
	}
	openRichPreviewWebview(context, path.basename(data.sourcePath), data.text);
}

function activate(context) {
	const extract = vscode.commands.registerCommand('pdfExtractor.extract', (uri) =>
		runExtraction(context, uri, { previewBeside: true })
	);

	const extractAndSave = vscode.commands.registerCommand('pdfExtractor.extractAndSave', async (uri) => {
		const pdfUri = await resolvePdfUri(uri);
		if (!pdfUri) {
			vscode.window.showErrorMessage('No PDF selected.');
			return;
		}
		let data;
		try {
			data = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'PDF Extractor Plus',
					cancellable: false
				},
				async (progress) => {
					progress.report({ message: 'Extracting text…' });
					return extractPdfData(pdfUri);
				}
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to extract PDF text: ${message}`);
			return;
		}
		if (!data.text.trim()) {
			vscode.window.showWarningMessage('No readable text was found in this PDF.');
			return;
		}
		await saveExtractedAsTxt(data.sourcePath, data.text);
	});

	const copyExtracted = vscode.commands.registerCommand('pdfExtractor.copyExtracted', async (uri) => {
		const pdfUri = await resolvePdfUri(uri);
		if (!pdfUri) {
			vscode.window.showErrorMessage('No PDF selected.');
			return;
		}
		let data;
		try {
			data = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'PDF Extractor Plus',
					cancellable: false
				},
				async (progress) => {
					progress.report({ message: 'Extracting text…' });
					return extractPdfData(pdfUri);
				}
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to extract PDF text: ${message}`);
			return;
		}
		if (!data.text.trim()) {
			vscode.window.showWarningMessage('No readable text was found in this PDF.');
			return;
		}
		try {
			await vscode.env.clipboard.writeText(data.text);
			vscode.window.showInformationMessage(
				`Copied ${data.text.length.toLocaleString()} characters (${data.numpages} page(s)).`
			);
		} catch {
			vscode.window.showErrorMessage('Could not copy to clipboard.');
		}
	});

	const previewWebview = vscode.commands.registerCommand('pdfExtractor.previewWebview', (uri) =>
		previewWebviewCommand(context, uri)
	);

	const batchExtractCmd = vscode.commands.registerCommand('pdfExtractor.batchExtract', (uri) =>
		batchExtract(context, uri)
	);

	const searchPdfs = vscode.commands.registerCommand('pdfExtractor.searchWorkspacePdfs', () =>
		searchWorkspacePdfs(context)
	);

	const ocrImages = vscode.commands.registerCommand('pdfExtractor.ocrFromImages', () => ocrFromImages(context));

	context.subscriptions.push(
		extract,
		extractAndSave,
		copyExtracted,
		previewWebview,
		batchExtractCmd,
		searchPdfs,
		ocrImages
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
