const vscode = require('vscode');
const fs = require('fs');
const pdf = require('pdf-parse');

function activate(context) {
	const extractCommand = vscode.commands.registerCommand(
		'pdfExtractor.extract',
		async (uri) => {
			if (!uri || !uri.fsPath || !uri.fsPath.toLowerCase().endsWith('.pdf')) {
				vscode.window.showErrorMessage('Please right-click a PDF file');
				return;
			}

			try {
				const buffer = await fs.promises.readFile(uri.fsPath);
				const result = await pdf(buffer);

				const extractedText = (result.text || '').trim();
				if (!extractedText) {
					vscode.window.showWarningMessage('No readable text was found in this PDF.');
					return;
				}

				const doc = await vscode.workspace.openTextDocument({
					content: extractedText,
					language: 'text'
				});

				await vscode.window.showTextDocument(doc);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Failed to extract PDF text: ${message}`);
			}
		}
	);

	context.subscriptions.push(extractCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
