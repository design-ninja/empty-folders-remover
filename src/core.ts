import * as fs from "fs/promises";
import * as path from "path";

// Configuration interface
export interface EmptyFolderConfig {
  excludePatterns: string[];
  junkFiles: string[];
  maxConcurrency: number;
  dryRun: boolean;
  showProgress: boolean;
  // Absolute paths that must never be removed (e.g. workspace roots, which
  // may be nested inside another workspace root in multi-root setups)
  protectedPaths?: string[];
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

// Minimal directory entry (compatible with fs.Dirent but host-agnostic)
export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

// Pluggable file operations so hosts can route deletions elsewhere
// (e.g. VS Code moves items to the OS trash instead of unlinking)
export interface FileOperations {
  readDirectory(dirPath: string): Promise<DirectoryEntry[]>;
  deleteFile(filePath: string): Promise<void>;
  deleteEmptyDirectory(dirPath: string): Promise<void>;
}

export const nodeFileOperations: FileOperations = {
  async readDirectory(dirPath: string): Promise<DirectoryEntry[]> {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    return items.map(item => ({ name: item.name, isDirectory: item.isDirectory() }));
  },
  deleteFile(filePath: string): Promise<void> {
    return fs.unlink(filePath);
  },
  deleteEmptyDirectory(dirPath: string): Promise<void> {
    return fs.rmdir(dirPath);
  }
};

function wildcardPatternToRegex(pattern: string): RegExp {
  const escapedPattern = pattern
    .replace(/\*{2,}/g, "*")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escapedPattern}$`, "i");
}

function normalizeMaxConcurrency(maxConcurrency: number): number {
  if (!Number.isFinite(maxConcurrency)) {
    return 1;
  }

  return Math.max(1, Math.min(50, Math.floor(maxConcurrency)));
}

// A junk pattern without literal characters (e.g. "*", "*.*") would match
// every file in the workspace and turn all folders into deletion candidates
export function isUnsafeJunkPattern(pattern: string): boolean {
  const withoutWildcards = pattern.replace(/[*\s]/g, "");
  return !/[^.]/.test(withoutWildcards);
}

export function partitionJunkPatterns(patterns: string[]): { safe: string[]; unsafe: string[] } {
  const safe: string[] = [];
  const unsafe: string[] = [];
  for (const pattern of patterns) {
    (isUnsafeJunkPattern(pattern) ? unsafe : safe).push(pattern);
  }
  return { safe, unsafe };
}

// Paths are compared case-insensitively on platforms whose default file
// systems are case-insensitive
function normalizePathKey(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

// Case-insensitive name matcher with wildcard (*) support
class PatternMatcher {
  private simplePatterns: Set<string>;
  private regexPatterns: RegExp[];

  constructor(patterns: string[]) {
    this.simplePatterns = new Set<string>();
    this.regexPatterns = [];

    // Pre-compile patterns for faster matching
    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        this.regexPatterns.push(wildcardPatternToRegex(pattern));
      } else {
        this.simplePatterns.add(pattern.toLowerCase());
      }
    }
  }

  matches(name: string): boolean {
    // O(1) lookup for simple patterns
    if (this.simplePatterns.has(name.toLowerCase())) {
      return true;
    }

    // Check regex patterns
    return this.regexPatterns.some(regex => regex.test(name));
  }
}

// Counting semaphore used to cap concurrent file system calls
class Semaphore {
  private available: number;
  private waiters: (() => void)[] = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

// Runs tasks over items with at most `limit` in flight at once
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  token: CancellationToken,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length && !token.isCancellationRequested) {
      const item = items[nextIndex++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

// Directory scanner class
export class DirectoryScanner {
  private excludeMatcher: PatternMatcher;
  private junkMatcher: PatternMatcher;
  private maxConcurrency: number;
  private fileOps: FileOperations;
  private scanErrors: string[] = [];

  constructor(config: EmptyFolderConfig, fileOps: FileOperations = nodeFileOperations) {
    this.excludeMatcher = new PatternMatcher(config.excludePatterns);
    this.junkMatcher = new PatternMatcher(partitionJunkPatterns(config.junkFiles).safe);
    this.maxConcurrency = normalizeMaxConcurrency(config.maxConcurrency);
    this.fileOps = fileOps;
  }

  // Directories that could not be read during the most recent scan
  getScanErrors(): string[] {
    return this.scanErrors;
  }

  async scanDirectories(rootPath: string, token: CancellationToken): Promise<DirectoryInfo[]> {
    const directories: DirectoryInfo[] = [];
    const emptyDirs = new Set<string>();
    const semaphore = new Semaphore(this.maxConcurrency);
    this.scanErrors = [];

    const scanRecursive = async (dirPath: string, depth: number): Promise<void> => {
      if (token.isCancellationRequested) {
        return;
      }

      // Check if directory should be excluded
      const dirName = path.basename(dirPath);
      if (this.shouldExclude(dirName)) {
        return;
      }

      let items: DirectoryEntry[];
      await semaphore.acquire();
      try {
        if (token.isCancellationRequested) {
          return;
        }
        items = await this.fileOps.readDirectory(dirPath);
      } catch (error) {
        // Directory not accessible: skip it (it will never be marked empty),
        // but surface the problem to the caller
        this.scanErrors.push(
          `Failed to scan ${dirPath}: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      } finally {
        semaphore.release();
      }

      const subdirectories: string[] = [];
      let hasFiles = false;

      for (const item of items) {
        if (item.isDirectory) {
          subdirectories.push(path.join(dirPath, item.name));
        } else if (!this.junkMatcher.matches(item.name)) {
          hasFiles = true;
        }
      }

      // Process subdirectories in parallel; the semaphore caps how many
      // readDirectory calls are in flight at once
      await Promise.all(subdirectories.map(subdir => scanRecursive(subdir, depth + 1)));

      if (token.isCancellationRequested) {
        return;
      }

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
    };

    await scanRecursive(rootPath, 0);

    return directories;
  }

  shouldExclude(dirName: string): boolean {
    return this.excludeMatcher.matches(dirName);
  }
}

// Empty folder remover class
export class EmptyFolderRemover {
  private config: EmptyFolderConfig;
  private junkMatcher: PatternMatcher;
  private fileOps: FileOperations;
  private protectedPaths: Set<string>;
  private stats: RemovalStats;

  constructor(config: EmptyFolderConfig, fileOps: FileOperations = nodeFileOperations) {
    this.config = config;
    this.junkMatcher = new PatternMatcher(partitionJunkPatterns(config.junkFiles).safe);
    this.fileOps = fileOps;
    this.protectedPaths = new Set((config.protectedPaths ?? []).map(normalizePathKey));
    this.stats = createEmptyStats();
  }

  async removeEmptyFolders(
    directories: DirectoryInfo[],
    onProgress: ProgressCallback,
    token: CancellationToken
  ): Promise<RemovalStats> {
    this.stats = createEmptyStats();
    const startTime = Date.now();
    const emptyDirectories = directories.filter(
      dir => dir.isEmpty && dir.depth > 0 && !this.protectedPaths.has(normalizePathKey(dir.path))
    );

    this.stats.totalScanned = directories.length;

    // Process directories grouped by depth to ensure children are removed before parents
    const concurrency = normalizeMaxConcurrency(this.config.maxConcurrency);
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
      await runWithConcurrency(group, concurrency, token, dir => this.removeDirectory(dir, onProgress));
    }

    this.stats.duration = Date.now() - startTime;
    return this.stats;
  }

  private async removeDirectory(dir: DirectoryInfo, onProgress: ProgressCallback): Promise<void> {
    try {
      if (this.config.dryRun) {
        this.stats.totalRemoved++;
        onProgress(`[DRY RUN] Would remove: ${path.basename(dir.path)}`);
        return;
      }

      // Double-check if directory is still empty (junk files aside) before removal.
      // Junk files are deleted before the directory; if the directory removal
      // then fails (e.g. a file appeared in between), the junk files are already
      // gone — hosts that route deleteFile to the OS trash keep them recoverable.
      const items = await this.fileOps.readDirectory(dir.path);
      const junkItems = items.filter(item => !item.isDirectory && this.junkMatcher.matches(item.name));

      if (junkItems.length === items.length) {
        for (const junk of junkItems) {
          await this.fileOps.deleteFile(path.join(dir.path, junk.name));
        }
        await this.fileOps.deleteEmptyDirectory(dir.path);

        this.stats.totalRemoved++;
        onProgress(`Removed: ${path.basename(dir.path)}`);
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
    aggregated.duration += stats.duration;
    aggregated.errors.push(...stats.errors);
  }
  return aggregated;
}
