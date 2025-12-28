import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

// Configuration interface
interface EmptyFolderConfig {
  excludePatterns: string[];
  maxConcurrency: number;
  dryRun: boolean;
  showProgress: boolean;
}

// Directory information interface
interface DirectoryInfo {
  path: string;
  depth: number;
  isEmpty: boolean;
}

// Operation statistics interface
interface RemovalStats {
  totalScanned: number;
  totalRemoved: number;
  totalErrors: number;
  duration: number;
  errors: string[];
}

// Progress tracking class
class ProgressTracker {
  private startTime: number;
  private processed: number = 0;
  private total: number = 0;

  constructor(private progress: vscode.Progress<{ message?: string; increment?: number }>) {
    this.startTime = Date.now();
  }

  setTotal(total: number): void {
    this.total = total;
  }

  update(message: string): void {
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
  private simplePatterns: Set<string>;
  private regexPatterns: RegExp[];

  constructor(config: EmptyFolderConfig) {
    this.simplePatterns = new Set<string>();
    this.regexPatterns = [];

    // Pre-compile patterns for faster matching
    for (const pattern of config.excludePatterns) {
      if (pattern.includes('*')) {
        this.regexPatterns.push(new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i'));
      } else {
        this.simplePatterns.add(pattern.toLowerCase());
      }
    }
  }

  async scanDirectories(rootPath: string, token: vscode.CancellationToken): Promise<DirectoryInfo[]> {
    const directories: DirectoryInfo[] = [];
    const emptyDirs = new Set<string>();

    const scanRecursive = async (dirPath: string, depth: number): Promise<void> => {
      if (token.isCancellationRequested) {
        return;
      }

      try {
        // Check if directory should be excluded
        const dirName = path.basename(dirPath);
        if (this.shouldExclude(dirName)) {
          return;
        }

        // Use withFileTypes to avoid extra stat calls
        const items = await fs.readdir(dirPath, { withFileTypes: true });

        const subdirectories: string[] = [];
        let hasFiles = false;

        for (const item of items) {
          if (token.isCancellationRequested) {
            return;
          }

          if (item.isDirectory()) {
            subdirectories.push(path.join(dirPath, item.name));
          } else {
            hasFiles = true;
          }
        }

        // Process subdirectories in parallel for better performance
        await Promise.all(subdirectories.map(subdir => scanRecursive(subdir, depth + 1)));

        // Determine emptiness considering subdirectories emptiness
        const allSubdirsEmpty = subdirectories.every(sd => emptyDirs.has(sd));
        const isEmpty = !hasFiles && allSubdirsEmpty;

        // Add current directory to list
        directories.push({
          path: dirPath,
          depth,
          isEmpty
        });

        if (isEmpty) {
          emptyDirs.add(dirPath);
        }

      } catch {
        // Directory not accessible, skip it
        return;
      }
    };

    await scanRecursive(rootPath, 0);

    // Sort by depth (deepest first) for bottom-up processing
    return directories.sort((a, b) => b.depth - a.depth);
  }

  private shouldExclude(dirName: string): boolean {
    const lowerName = dirName.toLowerCase();

    // O(1) lookup for simple patterns
    if (this.simplePatterns.has(lowerName)) {
      return true;
    }

    // Check regex patterns
    return this.regexPatterns.some(regex => regex.test(dirName));
  }
}

// Empty folder remover class
class EmptyFolderRemover {
  private config: EmptyFolderConfig;
  private stats: RemovalStats;

  constructor(config: EmptyFolderConfig) {
    this.config = config;
    this.stats = {
      totalScanned: 0,
      totalRemoved: 0,
      totalErrors: 0,
      duration: 0,
      errors: []
    };
  }

  async removeEmptyFolders(
    directories: DirectoryInfo[],
    progressTracker: ProgressTracker,
    token: vscode.CancellationToken
  ): Promise<RemovalStats> {
    const startTime = Date.now();
    const emptyDirectories = directories.filter(dir => dir.isEmpty);

    progressTracker.setTotal(emptyDirectories.length);
    this.stats.totalScanned = directories.length;

    // Process directories grouped by depth to ensure children are removed before parents
    const batchSize = this.config.maxConcurrency;
    const depthMap = new Map<number, DirectoryInfo[]>();
    for (const dir of emptyDirectories) {
      const list = depthMap.get(dir.depth) ?? [];
      list.push(dir);
      depthMap.set(dir.depth, list);
    }

    const depths = Array.from(depthMap.keys()).sort((a, b) => b - a);

    for (const depth of depths) {
      if (token.isCancellationRequested) {
        break;
      }
      const group = depthMap.get(depth) || [];
      for (let i = 0; i < group.length; i += batchSize) {
        if (token.isCancellationRequested) {
          break;
        }
        const batch = group.slice(i, i + batchSize);
        const promises = batch.map(dir => this.removeDirectory(dir, progressTracker));
        await Promise.allSettled(promises);
      }
    }

    this.stats.duration = Date.now() - startTime;
    return this.stats;
  }

  private async removeDirectory(dir: DirectoryInfo, progressTracker: ProgressTracker): Promise<void> {
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
    } catch (error) {
      this.stats.totalErrors++;
      const errorMessage = `Failed to remove ${dir.path}: ${error instanceof Error ? error.message : String(error)}`;
      this.stats.errors.push(errorMessage);
      progressTracker.update(`Error: ${path.basename(dir.path)}`);
    }
  }

  getStats(): RemovalStats {
    return this.stats;
  }
}

// Get configuration from VS Code settings
function getConfiguration(): EmptyFolderConfig {
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

export function activate(context: vscode.ExtensionContext) {
  // Register command to remove empty folders
  let disposable = vscode.commands.registerCommand(
    "empty-folders-remover.removeEmptyFolders",
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;

      if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder is opened");
        return;
      }

      const config = getConfiguration();

      // Show progress indicator
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: config.dryRun ? "Scanning for empty folders (DRY RUN)..." : "Removing empty folders...",
          cancellable: true,
        },
        async (progress, token) => {
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

          } catch (error) {
            vscode.window.showErrorMessage(
              `Error during operation: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      );
    }
  );

  context.subscriptions.push(disposable);
}

async function showResults(stats: RemovalStats, isDryRun: boolean): Promise<void> {
  const durationSeconds = Math.round(stats.duration / 1000);

  if (stats.totalRemoved === 0 && stats.totalErrors === 0) {
    vscode.window.showInformationMessage(
      `No empty folders found. Scanned ${stats.totalScanned} directories in ${durationSeconds}s.`
    );
  } else {
    const message = isDryRun
      ? `[DRY RUN] Found ${stats.totalRemoved} empty folder${stats.totalRemoved !== 1 ? 's' : ''} that would be removed.`
      : `Successfully removed ${stats.totalRemoved} empty folder${stats.totalRemoved !== 1 ? 's' : ''}.`;

    const details = `Scanned: ${stats.totalScanned}, Removed: ${stats.totalRemoved}, Errors: ${stats.totalErrors}, Time: ${durationSeconds}s`;

    if (stats.totalErrors > 0) {
      const action = await vscode.window.showWarningMessage(
        `${message} ${details}`,
        "Show Errors"
      );

      if (action === "Show Errors") {
        const errorText = stats.errors.join('\n');
        const doc = await vscode.workspace.openTextDocument({
          content: errorText,
          language: 'plaintext'
        });
        await vscode.window.showTextDocument(doc);
      }
    } else {
      vscode.window.showInformationMessage(`${message} ${details}`);
    }
  }
}

export function deactivate() { }
