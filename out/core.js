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
exports.EmptyFolderRemover = exports.DirectoryScanner = exports.nodeFileOperations = void 0;
exports.isUnsafeJunkPattern = isUnsafeJunkPattern;
exports.partitionJunkPatterns = partitionJunkPatterns;
exports.createEmptyStats = createEmptyStats;
exports.aggregateStats = aggregateStats;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
exports.nodeFileOperations = {
    async readDirectory(dirPath) {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        return items.map(item => ({ name: item.name, isDirectory: item.isDirectory() }));
    },
    deleteFile(filePath) {
        return fs.unlink(filePath);
    },
    deleteEmptyDirectory(dirPath) {
        return fs.rmdir(dirPath);
    }
};
function wildcardPatternToRegex(pattern) {
    const escapedPattern = pattern
        .replace(/\*{2,}/g, "*")
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
    return new RegExp(`^${escapedPattern}$`, "i");
}
function normalizeMaxConcurrency(maxConcurrency) {
    if (!Number.isFinite(maxConcurrency)) {
        return 1;
    }
    return Math.max(1, Math.min(50, Math.floor(maxConcurrency)));
}
// A junk pattern without literal characters (e.g. "*", "*.*") would match
// every file in the workspace and turn all folders into deletion candidates
function isUnsafeJunkPattern(pattern) {
    const withoutWildcards = pattern.replace(/[*\s]/g, "");
    return !/[^.]/.test(withoutWildcards);
}
function partitionJunkPatterns(patterns) {
    const safe = [];
    const unsafe = [];
    for (const pattern of patterns) {
        (isUnsafeJunkPattern(pattern) ? unsafe : safe).push(pattern);
    }
    return { safe, unsafe };
}
// Paths are compared case-insensitively on platforms whose default file
// systems are case-insensitive
function normalizePathKey(targetPath) {
    const resolved = path.resolve(targetPath);
    return process.platform === "win32" || process.platform === "darwin"
        ? resolved.toLowerCase()
        : resolved;
}
// Case-insensitive name matcher with wildcard (*) support
class PatternMatcher {
    simplePatterns;
    regexPatterns;
    constructor(patterns) {
        this.simplePatterns = new Set();
        this.regexPatterns = [];
        // Pre-compile patterns for faster matching
        for (const pattern of patterns) {
            if (pattern.includes('*')) {
                this.regexPatterns.push(wildcardPatternToRegex(pattern));
            }
            else {
                this.simplePatterns.add(pattern.toLowerCase());
            }
        }
    }
    matches(name) {
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
    available;
    waiters = [];
    constructor(count) {
        this.available = count;
    }
    async acquire() {
        if (this.available > 0) {
            this.available--;
            return;
        }
        await new Promise(resolve => this.waiters.push(resolve));
    }
    release() {
        const next = this.waiters.shift();
        if (next) {
            next();
        }
        else {
            this.available++;
        }
    }
}
// Runs tasks over items with at most `limit` in flight at once
async function runWithConcurrency(items, limit, token, task) {
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
class DirectoryScanner {
    excludeMatcher;
    junkMatcher;
    maxConcurrency;
    fileOps;
    scanErrors = [];
    constructor(config, fileOps = exports.nodeFileOperations) {
        this.excludeMatcher = new PatternMatcher(config.excludePatterns);
        this.junkMatcher = new PatternMatcher(partitionJunkPatterns(config.junkFiles).safe);
        this.maxConcurrency = normalizeMaxConcurrency(config.maxConcurrency);
        this.fileOps = fileOps;
    }
    // Directories that could not be read during the most recent scan
    getScanErrors() {
        return this.scanErrors;
    }
    async scanDirectories(rootPath, token) {
        const directories = [];
        const emptyDirs = new Set();
        const semaphore = new Semaphore(this.maxConcurrency);
        this.scanErrors = [];
        const scanRecursive = async (dirPath, depth) => {
            if (token.isCancellationRequested) {
                return;
            }
            // Check if directory should be excluded
            const dirName = path.basename(dirPath);
            if (this.shouldExclude(dirName)) {
                return;
            }
            let items;
            await semaphore.acquire();
            try {
                if (token.isCancellationRequested) {
                    return;
                }
                items = await this.fileOps.readDirectory(dirPath);
            }
            catch (error) {
                // Directory not accessible: skip it (it will never be marked empty),
                // but surface the problem to the caller
                this.scanErrors.push(`Failed to scan ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            finally {
                semaphore.release();
            }
            const subdirectories = [];
            let hasFiles = false;
            for (const item of items) {
                if (item.isDirectory) {
                    subdirectories.push(path.join(dirPath, item.name));
                }
                else if (!this.junkMatcher.matches(item.name)) {
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
    shouldExclude(dirName) {
        return this.excludeMatcher.matches(dirName);
    }
}
exports.DirectoryScanner = DirectoryScanner;
// Empty folder remover class
class EmptyFolderRemover {
    config;
    junkMatcher;
    fileOps;
    protectedPaths;
    stats;
    constructor(config, fileOps = exports.nodeFileOperations) {
        this.config = config;
        this.junkMatcher = new PatternMatcher(partitionJunkPatterns(config.junkFiles).safe);
        this.fileOps = fileOps;
        this.protectedPaths = new Set((config.protectedPaths ?? []).map(normalizePathKey));
        this.stats = createEmptyStats();
    }
    async removeEmptyFolders(directories, onProgress, token) {
        this.stats = createEmptyStats();
        const startTime = Date.now();
        const emptyDirectories = directories.filter(dir => dir.isEmpty && dir.depth > 0 && !this.protectedPaths.has(normalizePathKey(dir.path)));
        this.stats.totalScanned = directories.length;
        // Process directories grouped by depth to ensure children are removed before parents
        const concurrency = normalizeMaxConcurrency(this.config.maxConcurrency);
        const depthMap = new Map();
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
    async removeDirectory(dir, onProgress) {
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
            }
            else {
                // Directory is no longer empty, skip but still update progress
                onProgress(`Skipped (no longer empty): ${path.basename(dir.path)}`);
            }
        }
        catch (error) {
            this.stats.totalErrors++;
            const errorMessage = `Failed to remove ${dir.path}: ${error instanceof Error ? error.message : String(error)}`;
            this.stats.errors.push(errorMessage);
            onProgress(`Error: ${path.basename(dir.path)}`);
        }
    }
    getStats() {
        return this.stats;
    }
}
exports.EmptyFolderRemover = EmptyFolderRemover;
// Create empty stats object
function createEmptyStats() {
    return {
        totalScanned: 0,
        totalRemoved: 0,
        totalErrors: 0,
        duration: 0,
        errors: []
    };
}
// Aggregate stats from multiple operations
function aggregateStats(statsList) {
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
//# sourceMappingURL=core.js.map