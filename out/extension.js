"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
function activate(context) {
    // Register command to remove empty folders
    let disposable = vscode.commands.registerCommand("empty-folders-remover.removeEmptyFolders", async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage("No workspace folder is opened");
            return;
        }
        // Show progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Removing empty folders...",
            cancellable: true,
        }, async (progress, token) => {
            const rootPath = workspaceFolders[0].uri.fsPath;
            let foldersRemoved = 0;
            const removeEmptyFolders = (folderPath) => {
                if (token.isCancellationRequested) {
                    return false;
                }
                try {
                    if (!fs.existsSync(folderPath)) {
                        return false;
                    }
                    let isDirectoryEmpty = true;
                    const items = fs.readdirSync(folderPath);
                    for (const item of items) {
                        const fullPath = path.join(folderPath, item);
                        if (!fs.existsSync(fullPath)) {
                            continue;
                        }
                        const stats = fs.statSync(fullPath);
                        if (stats.isDirectory()) {
                            const isEmpty = removeEmptyFolders(fullPath);
                            if (isEmpty) {
                                try {
                                    fs.rmdirSync(fullPath);
                                    foldersRemoved++;
                                    progress.report({
                                        message: `Removed: ${path.basename(fullPath)}`,
                                    });
                                }
                                catch (err) {
                                    console.error(`Failed to remove directory: ${fullPath}`, err);
                                }
                            }
                            else {
                                isDirectoryEmpty = false;
                            }
                        }
                        else {
                            isDirectoryEmpty = false;
                        }
                    }
                    return isDirectoryEmpty;
                }
                catch (error) {
                    console.error(`Error processing directory: ${folderPath}`, error);
                    return false;
                }
            };
            try {
                removeEmptyFolders(rootPath);
                vscode.window.showInformationMessage(`Successfully removed ${foldersRemoved} empty folder${foldersRemoved !== 1 ? "s" : ""}`);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Error removing empty folders: ${error}`);
            }
        });
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map