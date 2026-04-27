const vscode = require('vscode');
const fs = require('fs');
const pdf = require('pdf-parse');

function activate(context) {
	const extractCommand = vscode.commands.registerCommand(
		'pdfExtractor.extract',
		async (uri) => {
			if (!uri || !uri.fsPath.endsWith('.pdf')) {
				vscode.window.showErrorMessage('Please right-click a PDF file');
				return;
			}

			const buffer = fs.readFileSync(uri.fsPath);
			const result = await pdf(buffer);

			const doc = await vscode.workspace.openTextDocument({
				content: result.text,
				language: 'text'
			});

			vscode.window.showTextDocument(doc);
		}
	);

	context.subscriptions.push(extractCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
