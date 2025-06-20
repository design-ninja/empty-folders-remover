"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");
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
// Directory scanner class
class DirectoryScanner {
    constructor(config) {
        this.excludePatterns = config.excludePatterns;
    }
    async scanDirectories(rootPath, token) {
        const directories = [];
        const scanRecursive = async (dirPath, depth) => {
            if (token.isCancellationRequested) {
                return;
            }
            try {
                await fs.access(dirPath);
                const items = await fs.readdir(dirPath);
                // Check if directory should be excluded
                const dirName = path.basename(dirPath);
                if (this.shouldExclude(dirName)) {
                    return;
                }
                const subdirectories = [];
                let hasFiles = false;
                for (const item of items) {
                    if (token.isCancellationRequested) {
                        return;
                    }
                    const fullPath = path.join(dirPath, item);
                    try {
                        const stats = await fs.stat(fullPath);
                        if (stats.isDirectory()) {
                            subdirectories.push(fullPath);
                        }
                        else {
                            hasFiles = true;
                        }
                    }
                    catch (error) {
                        // Ignore inaccessible items
                        continue;
                    }
                }
                // Process subdirectories first
                for (const subdir of subdirectories) {
                    await scanRecursive(subdir, depth + 1);
                }
                // Add current directory to list
                directories.push({
                    path: dirPath,
                    depth,
                    isEmpty: !hasFiles && subdirectories.length === 0
                });
            }
            catch (error) {
                // Directory not accessible, skip it
                return;
            }
        };
        await scanRecursive(rootPath, 0);
        // Sort by depth (deepest first) for bottom-up processing
        return directories.sort((a, b) => b.depth - a.depth);
    }
    shouldExclude(dirName) {
        return this.excludePatterns.some(pattern => {
            if (pattern.includes('*')) {
                const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
                return regex.test(dirName);
            }
            return dirName.toLowerCase() === pattern.toLowerCase();
        });
    }
}
// Empty folder remover class
class EmptyFolderRemover {
    constructor(config) {
        this.config = config;
        this.stats = {
            totalScanned: 0,
            totalRemoved: 0,
            totalErrors: 0,
            duration: 0,
            errors: []
        };
    }
    async removeEmptyFolders(directories, progressTracker, token) {
        const startTime = Date.now();
        const emptyDirectories = directories.filter(dir => dir.isEmpty);
        progressTracker.setTotal(emptyDirectories.length);
        this.stats.totalScanned = directories.length;
        // Process directories in batches to avoid overwhelming the file system
        const batchSize = this.config.maxConcurrency;
        for (let i = 0; i < emptyDirectories.length; i += batchSize) {
            if (token.isCancellationRequested) {
                break;
            }
            const batch = emptyDirectories.slice(i, i + batchSize);
            const promises = batch.map(dir => this.removeDirectory(dir, progressTracker));
            await Promise.allSettled(promises);
        }
        this.stats.duration = Date.now() - startTime;
        return this.stats;
    }
    async removeDirectory(dir, progressTracker) {
        try {
            // Double-check if directory is still empty before removal
            const items = await fs.readdir(dir.path);
            if (items.length === 0) {
                if (!this.config.dryRun) {
                    await fs.rmdir(dir.path);
                }
                this.stats.totalRemoved++;
                progressTracker.update(`${this.config.dryRun ? '[DRY RUN] Would remove' : 'Removed'}: ${path.basename(dir.path)}`);
            }
        }
        catch (error) {
            this.stats.totalErrors++;
            const errorMessage = `Failed to remove ${dir.path}: ${error instanceof Error ? error.message : String(error)}`;
            this.stats.errors.push(errorMessage);
            progressTracker.update(`Error: ${path.basename(dir.path)}`);
        }
    }
    getStats() {
        return this.stats;
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
                const rootPath = workspaceFolders[0].uri.fsPath;
                const progressTracker = new ProgressTracker(progress);
                // Phase 1: Scan directories
                progress.report({ message: "Scanning directories..." });
                const scanner = new DirectoryScanner(config);
                const directories = await scanner.scanDirectories(rootPath, token);
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage("Operation cancelled by user.");
                    return;
                }
                // Phase 2: Remove empty folders
                const remover = new EmptyFolderRemover(config);
                const stats = await remover.removeEmptyFolders(directories, progressTracker, token);
                // Show results
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage("Operation cancelled by user.");
                    return;
                }
                await showResults(stats, config.dryRun);
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