import * as fs from "fs/promises";
import * as path from "path";

// Configuration interface
export interface EmptyFolderConfig {
  excludePatterns: string[];
  maxConcurrency: number;
  dryRun: boolean;
  showProgress: boolean;
}

// Directory information interface
export interface DirectoryInfo {
  path: string;
  depth: number;
  isEmpty: boolean;
}

// Operation statistics interface
export interface RemovalStats {
  totalScanned: number;
  totalRemoved: number;
  totalErrors: number;
  duration: number;
  errors: string[];
}

// Cancellation token interface (compatible with vscode.CancellationToken)
export interface CancellationToken {
  isCancellationRequested: boolean;
}

// Progress callback type
export type ProgressCallback = (message: string) => void;

// Directory scanner class
export class DirectoryScanner {
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

  async scanDirectories(rootPath: string, token: CancellationToken): Promise<DirectoryInfo[]> {
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

  shouldExclude(dirName: string): boolean {
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
export class EmptyFolderRemover {
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
    onProgress: ProgressCallback,
    token: CancellationToken
  ): Promise<RemovalStats> {
    const startTime = Date.now();
    const emptyDirectories = directories.filter(dir => dir.isEmpty);

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
        const promises = batch.map(dir => this.removeDirectory(dir, onProgress));
        await Promise.allSettled(promises);
      }
    }

    this.stats.duration = Date.now() - startTime;
    return this.stats;
  }

  private async removeDirectory(dir: DirectoryInfo, onProgress: ProgressCallback): Promise<void> {
    try {
      // Double-check if directory is still empty before removal
      const items = await fs.readdir(dir.path);

      if (items.length === 0) {
        if (!this.config.dryRun) {
          await fs.rmdir(dir.path);
        }

        this.stats.totalRemoved++;
        onProgress(`${this.config.dryRun ? '[DRY RUN] Would remove' : 'Removed'}: ${path.basename(dir.path)}`);
      } else {
        // Directory is no longer empty, skip but still update progress
        onProgress(`Skipped (no longer empty): ${path.basename(dir.path)}`);
      }
    } catch (error) {
      this.stats.totalErrors++;
      const errorMessage = `Failed to remove ${dir.path}: ${error instanceof Error ? error.message : String(error)}`;
      this.stats.errors.push(errorMessage);
      onProgress(`Error: ${path.basename(dir.path)}`);
    }
  }

  getStats(): RemovalStats {
    return this.stats;
  }
}

// Create empty stats object
export function createEmptyStats(): RemovalStats {
  return {
    totalScanned: 0,
    totalRemoved: 0,
    totalErrors: 0,
    duration: 0,
    errors: []
  };
}

// Aggregate stats from multiple operations
export function aggregateStats(statsList: RemovalStats[]): RemovalStats {
  const aggregated = createEmptyStats();
  for (const stats of statsList) {
    aggregated.totalScanned += stats.totalScanned;
    aggregated.totalRemoved += stats.totalRemoved;
    aggregated.totalErrors += stats.totalErrors;
    aggregated.errors.push(...stats.errors);
  }
  return aggregated;
}
