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
        // Get current workspace directory
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage("No workspace folder is opened");
            return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath;
        let foldersRemoved = 0;
        // Recursive function to find and remove empty folders
        const removeEmptyFolders = (folderPath) => {
            let isDirectoryEmpty = true;
            const items = fs.readdirSync(folderPath);
            for (const item of items) {
                const fullPath = path.join(folderPath, item);
                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                    // Recursively check nested directories
                    const isEmpty = removeEmptyFolders(fullPath);
                    if (isEmpty) {
                        fs.rmdirSync(fullPath);
                        foldersRemoved++;
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
        };
        try {
            removeEmptyFolders(rootPath);
            vscode.window.showInformationMessage(`Empty folders removed: ${foldersRemoved}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Error removing empty folders: ${error}`);
        }
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map