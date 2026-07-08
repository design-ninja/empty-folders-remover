"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const core_1 = require("./core");
// Progress tracking class
class ProgressTracker {
    progress;
    showDetails;
    startTime;
    processed = 0;
    total = 0;
    constructor(progress, showDetails) {
        this.progress = progress;
        this.showDetails = showDetails;
        this.startTime = Date.now();
    }
    setTotal(total) {
        this.total = total;
    }
    update(message) {
        this.processed++;
        const increment = this.total > 0 ? (1 / this.total) * 100 : 0;
        if (!this.showDetails) {
            // Keep the progress bar moving without per-item details
            this.progress.report({ increment });
            return;
        }
        const percentage = this.total > 0 ? Math.round((this.processed / this.total) * 100) : 0;
        const elapsed = Date.now() - this.startTime;
        const eta = this.processed > 0 ? Math.round((elapsed / this.processed) * (this.total - this.processed) / 1000) : 0;
        this.progress.report({
            message: `${message} (${percentage}%, ETA: ${eta}s)`,
            increment
        });
    }
}
// Get configuration from VS Code settings
function getConfiguration(protectedPaths) {
    const config = vscode.workspace.getConfiguration('emptyFoldersRemover');
    const junkPatterns = (0, core_1.partitionJunkPatterns)(config.get('junkFiles', ['.DS_Store', 'Thumbs.db', 'desktop.ini']));
    return {
        config: {
            excludePatterns: config.get('excludePatterns', [
                '.git', '.vscode', 'node_modules', '.npm', '.yarn',
                'dist', 'build', '.next', '.nuxt', 'coverage',
                '__pycache__', '.pytest_cache', '.mypy_cache'
            ]),
            junkFiles: junkPatterns.safe,
            maxConcurrency: config.get('maxConcurrency', 10),
            dryRun: config.get('dryRun', false),
            showProgress: config.get('showProgress', true),
            protectedPaths
        },
        useTrash: config.get('useTrash', true),
        ignoredJunkPatterns: junkPatterns.unsafe
    };
}
// File operations that route deletions through VS Code so removed items can
// go to the OS trash instead of being deleted permanently
function createVsCodeFileOperations(useTrash) {
    const remove = async (targetPath) => {
        await vscode.workspace.fs.delete(vscode.Uri.file(targetPath), { recursive: false, useTrash });
    };
    return {
        readDirectory: core_1.nodeFileOperations.readDirectory,
        deleteFile: remove,
        deleteEmptyDirectory: remove
    };
}
function activate(context) {
    // Register command to remove empty folders
    let disposable = vscode.commands.registerCommand("empty-folders-remover.removeEmptyFolders", async (resource) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
            vscode.window.showErrorMessage("No workspace folder is opened");
            return;
        }
        // Workspace roots must never be removed, even when one root is nested
        // inside another in a multi-root workspace
        const rootPaths = workspaceFolders.map(folder => folder.uri.fsPath);
        const { config, useTrash, ignoredJunkPatterns } = getConfiguration(rootPaths);
        if (ignoredJunkPatterns.length > 0) {
            vscode.window.showWarningMessage(`Ignoring unsafe junkFiles pattern(s): ${ignoredJunkPatterns.map(p => `"${p}"`).join(", ")}. ` +
                `A junk file pattern must contain at least one literal character.`);
        }
        // Invoked from the explorer context menu: process only that folder;
        // invoked from the command palette: process all workspace folders
        const targets = resource
            ? [{ name: path.basename(resource.fsPath), fsPath: resource.fsPath }]
            : workspaceFolders.map(folder => ({ name: folder.name, fsPath: folder.uri.fsPath }));
        // Show progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: config.dryRun ? "Scanning for empty folders (DRY RUN)..." : "Removing empty folders...",
            cancellable: true,
        }, async (progress, token) => {
            try {
                const progressTracker = new ProgressTracker(progress, config.showProgress);
                const fileOps = createVsCodeFileOperations(useTrash);
                const scanner = new core_1.DirectoryScanner(config);
                const startTime = Date.now();
                const scanErrors = [];
                // Phase 1: Scan all target folders first
                const allDirectoriesMap = new Map();
                for (const target of targets) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage("Operation cancelled by user.");
                        return;
                    }
                    progress.report({ message: `Scanning ${target.name}...` });
                    const directories = await scanner.scanDirectories(target.fsPath, token);
                    allDirectoriesMap.set(target.fsPath, directories);
                    scanErrors.push(...scanner.getScanErrors());
                }
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage("Operation cancelled by user.");
                    return;
                }
                // Calculate total empty directories across all folders
                let totalEmpty = 0;
                for (const directories of allDirectoriesMap.values()) {
                    totalEmpty += directories.filter(d => d.isEmpty && d.depth > 0).length;
                }
                progressTracker.setTotal(totalEmpty);
                // Phase 2: Remove empty folders from all target folders
                const statsList = [];
                for (const target of targets) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage("Operation cancelled by user.");
                        return;
                    }
                    const directories = allDirectoriesMap.get(target.fsPath) || [];
                    const remover = new core_1.EmptyFolderRemover(config, fileOps);
                    const stats = await remover.removeEmptyFolders(directories, (msg) => progressTracker.update(msg), token);
                    statsList.push(stats);
                }
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage("Operation cancelled by user.");
                    return;
                }
                const aggregatedStats = (0, core_1.aggregateStats)(statsList);
                aggregatedStats.totalErrors += scanErrors.length;
                aggregatedStats.errors.unshift(...scanErrors.map(e => `[scan] ${e}`));
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
function formatDuration(durationMs) {
    return durationMs < 1000 ? "<1s" : `${Math.round(durationMs / 1000)}s`;
}
async function showResults(stats, isDryRun) {
    const duration = formatDuration(stats.duration);
    if (stats.totalRemoved === 0 && stats.totalErrors === 0) {
        vscode.window.showInformationMessage(`No empty folders found. Scanned ${stats.totalScanned} directories in ${duration}.`);
    }
    else {
        const message = isDryRun
            ? `[DRY RUN] Found ${stats.totalRemoved} empty folder${stats.totalRemoved !== 1 ? 's' : ''} that would be removed.`
            : `Successfully removed ${stats.totalRemoved} empty folder${stats.totalRemoved !== 1 ? 's' : ''}.`;
        const details = `Scanned: ${stats.totalScanned}, Removed: ${stats.totalRemoved}, Errors: ${stats.totalErrors}, Time: ${duration}`;
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