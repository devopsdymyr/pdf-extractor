const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdf = require('pdf-parse');

function getNonce() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

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
/**
 * @param {vscode.Webview} webview
 * @param {{ pdfFileUri: vscode.Uri; pdfLibUri: vscode.Uri; workerUri: vscode.Uri; scale: number; maxPages: number }} opts
 */
function buildPdfOcrWebviewHtml(webview, opts) {
	const nonce = getNonce();
	const csp = webview.cspSource;
	const cfg = {
		pdfLib: opts.pdfLibUri.toString(),
		worker: opts.workerUri.toString(),
		pdfUrl: opts.pdfFileUri.toString(),
		scale: opts.scale,
		maxPages: opts.maxPages
	};
	const cfgJson = JSON.stringify(cfg);
	return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}' ${csp}; img-src ${csp} blob: data:; font-src ${csp}; connect-src ${csp}; worker-src ${csp} blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PDF OCR (render)</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
    margin: 0; padding: 12px; font-size: 13px; line-height: 1.5; }
  #status { opacity: 0.9; }
</style>
</head><body>
<p id="status">Loading PDF.js and rendering pages for OCR…</p>
<script type="module" nonce="${nonce}">
const vscode = acquireVsCodeApi();
const cfg = ${cfgJson};
const statusEl = document.getElementById('status');
function setStatus(t) { statusEl.textContent = t; }
try {
  const pdfjsLib = await import(cfg.pdfLib);
  pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.worker;
  const loadingTask = pdfjsLib.getDocument({ url: cfg.pdfUrl, withCredentials: false });
  const doc = await loadingTask.promise;
  const total = Math.min(doc.numPages || 0, cfg.maxPages);
  if (total < 1) {
    vscode.postMessage({ type: 'error', message: 'No pages to render in this PDF.' });
  } else {
    setStatus('Rendering page 1 / ' + total + '…');
    for (let p = 1; p <= total; p++) {
      setStatus('Rendering page ' + p + ' / ' + total + '…');
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const maxW = 2400;
      const maxH = 3200;
      const fit = Math.min(1, maxW / base.width, maxH / base.height);
      const viewport = page.getViewport({ scale: cfg.scale * fit });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        throw new Error('Canvas 2D context not available.');
      }
      const renderTask = page.render({ canvasContext: ctx, viewport });
      await renderTask.promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      const prefix = 'data:image/jpeg;base64,';
      const base64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl.split(',')[1] || '';
      vscode.postMessage({ type: 'pageJpeg', page: p, total, base64 });
    }
    vscode.postMessage({ type: 'done', pages: total });
    setStatus('Sent ' + total + ' page image(s) to the extension for OCR. You can close this tab when finished.');
  }
} catch (e) {
  const msg = (e && e.message) ? e.message : String(e);
  vscode.postMessage({ type: 'error', message: msg });
  setStatus('Error: ' + msg);
}
</script>
</body></html>`;
}

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
				'No embedded text found (common for scanned PDFs). Use OCR scanned PDF (renders in-editor), OCR from image files, or export pages externally.',
				'OCR scanned PDF',
				'OCR from images',
				'Learn more'
			);
			if (pick === 'OCR scanned PDF') {
				await ocrScannedPdf(context, pdfUri);
			} else if (pick === 'OCR from images') {
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
 * @param {string} combined
 * @param {string} previewTitle
 */
async function presentOcrOutcome(context, combined, previewTitle) {
	const config = getPdfConfig();
	const normalized = normalizeExtractedText(combined).trim();
	if (!normalized) {
		vscode.window.showWarningMessage('OCR produced no text.');
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		`OCR complete (${normalized.length.toLocaleString()} characters).`,
		'Rich preview',
		'Copy',
		'Save as .txt'
	);
	if (choice === 'Rich preview') {
		openRichPreviewWebview(context, previewTitle, normalized);
	} else if (choice === 'Copy') {
		await vscode.env.clipboard.writeText(normalized);
		vscode.window.showInformationMessage('OCR text copied to clipboard.');
	} else if (choice === 'Save as .txt') {
		const saveUri = await vscode.window.showSaveDialog({
			filters: { Text: ['txt'] },
			saveLabel: 'Save OCR text'
		});
		if (saveUri) {
			const lineMode = config.get('lineEnding') || 'auto';
			const enc = config.get('encoding') || 'utf8';
			await vscode.workspace.fs.writeFile(saveUri, encodeText(applyLineEndings(normalized, lineMode), enc));
			vscode.window.showInformationMessage(`Saved: ${saveUri.fsPath}`);
		}
	}
}

/**
 * Renders each PDF page in a webview (PDF.js + browser canvas), then runs Tesseract on the host — no Node canvas build.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri | undefined} uri
 */
async function ocrScannedPdf(context, uri) {
	const pdfUri = uri?.fsPath && uri.fsPath.toLowerCase().endsWith('.pdf') ? uri : await resolvePdfUri(uri);
	if (!pdfUri) {
		vscode.window.showErrorMessage('No PDF selected. Pick a PDF or use Explorer on a .pdf file.');
		return;
	}

	const config = getPdfConfig();
	const lang = (config.get('ocrLanguage') || 'eng').trim() || 'eng';
	const scale = Math.min(
		3,
		Math.max(0.5, Number(config.get('ocrPdfRenderScale')) || 1.4)
	);
	const maxPages = Math.min(
		500,
		Math.max(1, Math.floor(Number(config.get('ocrPdfMaxPages')) || 150))
	);

	const sessionId = crypto.randomUUID();
	const sessionFolder = vscode.Uri.joinPath(context.globalStorageUri, 'pdf-ocr-work', sessionId);
	const destPdf = vscode.Uri.joinPath(sessionFolder, 'input.pdf');
	const pdfjsDir = vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'pdfjs-dist', 'build');
	const pdfLibDisk = vscode.Uri.joinPath(pdfjsDir, 'pdf.mjs');
	const workerDisk = vscode.Uri.joinPath(pdfjsDir, 'pdf.worker.mjs');

	/** @type {vscode.Uri | null} */
	let sessionToDelete = sessionFolder;

	async function deleteSessionFolder() {
		if (!sessionToDelete) {
			return;
		}
		const target = sessionToDelete;
		sessionToDelete = null;
		try {
			await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
		} catch {
			// ignore
		}
	}

	try {
		await vscode.workspace.fs.createDirectory(sessionFolder);
		await vscode.workspace.fs.copy(pdfUri, destPdf, { overwrite: true });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`Could not prepare PDF for OCR: ${msg}`);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'pdfExtractorPdfOcr',
		`OCR render: ${path.basename(pdfUri.fsPath)}`,
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenData: false,
			localResourceRoots: [context.extensionUri, pdfjsDir, sessionFolder]
		}
	);

	panel.onDidDispose(() => {
		void deleteSessionFolder();
	});

	const wv = panel.webview;
	const pdfFileUri = wv.asWebviewUri(destPdf);
	const pdfLibUri = wv.asWebviewUri(pdfLibDisk);
	const workerUri = wv.asWebviewUri(workerDisk);

	const { createWorker } = require('tesseract.js');
	let combined = '';

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'PDF Extractor Plus: OCR scanned PDF',
				cancellable: true
			},
			async (progress, token) => {
				const worker = await createWorker(lang);
				try {
					await new Promise((resolve, reject) => {
						const sub = wv.onDidReceiveMessage(
							/** @param {{ type: string; message?: string; page?: number; total?: number; base64?: string }} msg */
							async (msg) => {
								if (!msg || typeof msg !== 'object') {
									return;
								}
								if (msg.type === 'error') {
									const errText = msg.message || 'Unknown render error';
									sub.dispose();
									reject(new Error(errText));
									return;
								}
								if (msg.type === 'pageJpeg' && msg.base64) {
									if (token.isCancellationRequested) {
										sub.dispose();
										reject(new Error('Cancelled'));
										return;
									}
									const t = msg.total || 1;
									const p = msg.page || 1;
									progress.report({ message: `OCR page ${p}/${t}` });
									try {
										const buf = Buffer.from(msg.base64, 'base64');
										const {
											data: { text }
										} = await worker.recognize(buf);
										combined += (text || '').trim() + '\n\n';
									} catch (err) {
										sub.dispose();
										reject(err instanceof Error ? err : new Error(String(err)));
									}
									return;
								}
								if (msg.type === 'done') {
									sub.dispose();
									resolve(undefined);
								}
							}
						);
						token.onCancellationRequested(() => {
							sub.dispose();
							try {
								panel.dispose();
							} catch {
								// ignore
							}
							reject(new Error('Cancelled'));
						});
						wv.html = buildPdfOcrWebviewHtml(wv, {
							pdfFileUri,
							pdfLibUri,
							workerUri,
							scale,
							maxPages
						});
					});
				} finally {
					await worker.terminate();
				}
			}
		);
		await deleteSessionFolder();
		await presentOcrOutcome(context, combined, `OCR: ${path.basename(pdfUri.fsPath)}`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg === 'Cancelled') {
			vscode.window.showInformationMessage('OCR scanned PDF cancelled.');
		} else {
			vscode.window.showErrorMessage(`OCR scanned PDF failed: ${msg}`);
		}
		await deleteSessionFolder();
		try {
			panel.dispose();
		} catch {
			// ignore
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

	await presentOcrOutcome(context, combined, 'OCR result');
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
		const pick = await vscode.window.showWarningMessage(
			'No readable text in this PDF (typical for scans). Run OCR scanned PDF or OCR from images.',
			'OCR scanned PDF',
			'OCR from images'
		);
		if (pick === 'OCR scanned PDF') {
			await ocrScannedPdf(context, pdfUri);
		} else if (pick === 'OCR from images') {
			await ocrFromImages(context);
		}
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
			const pick = await vscode.window.showWarningMessage(
				'No embedded text in this PDF (often a scan). Try OCR scanned PDF or OCR from images.',
				'OCR scanned PDF',
				'OCR from images'
			);
			if (pick === 'OCR scanned PDF') {
				await ocrScannedPdf(context, pdfUri);
			} else if (pick === 'OCR from images') {
				await ocrFromImages(context);
			}
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
			const pick = await vscode.window.showWarningMessage(
				'No embedded text in this PDF (often a scan). Try OCR scanned PDF or OCR from images.',
				'OCR scanned PDF',
				'OCR from images'
			);
			if (pick === 'OCR scanned PDF') {
				await ocrScannedPdf(context, pdfUri);
			} else if (pick === 'OCR from images') {
				await ocrFromImages(context);
			}
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

	const ocrScannedPdfCmd = vscode.commands.registerCommand('pdfExtractor.ocrScannedPdf', (uri) =>
		ocrScannedPdf(context, uri)
	);

	context.subscriptions.push(
		extract,
		extractAndSave,
		copyExtracted,
		previewWebview,
		batchExtractCmd,
		searchPdfs,
		ocrImages,
		ocrScannedPdfCmd
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
