"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const core_1 = require("./core");
// Progress tracking class
class ProgressTracker {
    constructor(progress) {
        this.progress = progress;
        this.processed = 0;
        this.total = 0;
        this.startTime = Date.now();
    }
    setTotal(total) {
        this.total = total;
    }
    update(message) {
        this.processed++;
        const percentage = this.total > 0 ? Math.round((this.processed / this.total) * 100) : 0;
        const elapsed = Date.now() - this.startTime;
        const eta = this.processed > 0 ? Math.round((elapsed / this.processed) * (this.total - this.processed) / 1000) : 0;
        this.progress.report({
            message: `${message} (${percentage}%, ETA: ${eta}s)`,
            increment: this.total > 0 ? (1 / this.total) * 100 : 0
        });
    }
}
// Get configuration from VS Code settings
function getConfiguration() {
    const config = vscode.workspace.getConfiguration('emptyFoldersRemover');
    return {
        excludePatterns: config.get('excludePatterns', [
            '.git', '.vscode', 'node_modules', '.npm', '.yarn',
            'dist', 'build', '.next', '.nuxt', 'coverage',
            '__pycache__', '.pytest_cache', '.mypy_cache'
        ]),
        maxConcurrency: config.get('maxConcurrency', 10),
        dryRun: config.get('dryRun', false),
        showProgress: config.get('showProgress', true)
    };
}
function activate(context) {
    // Register command to remove empty folders
    let disposable = vscode.commands.registerCommand("empty-folders-remover.removeEmptyFolders", async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage("No workspace folder is opened");
            return;
        }
        const config = getConfiguration();
        // Show progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: config.dryRun ? "Scanning for empty folders (DRY RUN)..." : "Removing empty folders...",
            cancellable: true,
        }, async (progress, token) => {
            try {
                const progressTracker = new ProgressTracker(progress);
                const scanner = new core_1.DirectoryScanner(config);
                // Aggregate stats across all workspace folders
                const aggregatedStats = (0, core_1.createEmptyStats)();
                const startTime = Date.now();
                // Phase 1: Scan all workspace folders first
                const allDirectoriesMap = new Map();
                for (const folder of workspaceFolders) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage("Operation cancelled by user.");
                        return;
                    }
                    progress.report({ message: `Scanning ${folder.name}...` });
                    const directories = await scanner.scanDirectories(folder.uri.fsPath, token);
                    allDirectoriesMap.set(folder.uri.fsPath, directories);
                }
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage("Operation cancelled by user.");
                    return;
                }
                // Calculate total empty directories across all folders
                let totalEmpty = 0;
                for (const directories of allDirectoriesMap.values()) {
                    totalEmpty += directories.filter(d => d.isEmpty).length;
                }
                progressTracker.setTotal(totalEmpty);
                // Phase 2: Remove empty folders from all workspace folders
                for (const folder of workspaceFolders) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage("Operation cancelled by user.");
                        return;
                    }
                    const directories = allDirectoriesMap.get(folder.uri.fsPath) || [];
                    const remover = new core_1.EmptyFolderRemover(config);
                    const stats = await remover.removeEmptyFolders(directories, (msg) => progressTracker.update(msg), token);
                    // Aggregate stats
                    aggregatedStats.totalScanned += stats.totalScanned;
                    aggregatedStats.totalRemoved += stats.totalRemoved;
                    aggregatedStats.totalErrors += stats.totalErrors;
                    aggregatedStats.errors.push(...stats.errors);
                }
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage("Operation cancelled by user.");
                    return;
                }
                aggregatedStats.duration = Date.now() - startTime;
                await showResults(aggregatedStats, config.dryRun);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Error during operation: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    });
    context.subscriptions.push(disposable);
}
async function showResults(stats, isDryRun) {
    const durationSeconds = Math.round(stats.duration / 1000);
    if (stats.totalRemoved === 0 && stats.totalErrors === 0) {
        vscode.window.showInformationMessage(`No empty folders found. Scanned ${stats.totalScanned} directories in ${durationSeconds}s.`);
    }
    else {
        const message = isDryRun
            ? `[DRY RUN] Found ${stats.totalRemoved} empty folder${stats.totalRemoved !== 1 ? 's' : ''} that would be removed.`
            : `Successfully removed ${stats.totalRemoved} empty folder${stats.totalRemoved !== 1 ? 's' : ''}.`;
        const details = `Scanned: ${stats.totalScanned}, Removed: ${stats.totalRemoved}, Errors: ${stats.totalErrors}, Time: ${durationSeconds}s`;
        if (stats.totalErrors > 0) {
            const action = await vscode.window.showWarningMessage(`${message} ${details}`, "Show Errors");
            if (action === "Show Errors") {
                const errorText = stats.errors.join('\n');
                const doc = await vscode.workspace.openTextDocument({
                    content: errorText,
                    language: 'plaintext'
                });
                await vscode.window.showTextDocument(doc);
            }
        }
        else {
            vscode.window.showInformationMessage(`${message} ${details}`);
        }
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map