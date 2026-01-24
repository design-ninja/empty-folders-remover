"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmptyFolderRemover = exports.DirectoryScanner = void 0;
exports.createEmptyStats = createEmptyStats;
exports.aggregateStats = aggregateStats;
const fs = require("fs/promises");
const path = require("path");
// Directory scanner class
class DirectoryScanner {
    constructor(config) {
        this.simplePatterns = new Set();
        this.regexPatterns = [];
        // Pre-compile patterns for faster matching
        for (const pattern of config.excludePatterns) {
            if (pattern.includes('*')) {
                this.regexPatterns.push(new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i'));
            }
            else {
                this.simplePatterns.add(pattern.toLowerCase());
            }
        }
    }
    async scanDirectories(rootPath, token) {
        const directories = [];
        const emptyDirs = new Set();
        const scanRecursive = async (dirPath, depth) => {
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
                const subdirectories = [];
                let hasFiles = false;
                for (const item of items) {
                    if (token.isCancellationRequested) {
                        return;
                    }
                    if (item.isDirectory()) {
                        subdirectories.push(path.join(dirPath, item.name));
                    }
                    else {
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
            }
            catch {
                // Directory not accessible, skip it
                return;
            }
        };
        await scanRecursive(rootPath, 0);
        // Sort by depth (deepest first) for bottom-up processing
        return directories.sort((a, b) => b.depth - a.depth);
    }
    shouldExclude(dirName) {
        const lowerName = dirName.toLowerCase();
        // O(1) lookup for simple patterns
        if (this.simplePatterns.has(lowerName)) {
            return true;
        }
        // Check regex patterns
        return this.regexPatterns.some(regex => regex.test(dirName));
    }
}
exports.DirectoryScanner = DirectoryScanner;
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
    async removeEmptyFolders(directories, onProgress, token) {
        const startTime = Date.now();
        const emptyDirectories = directories.filter(dir => dir.isEmpty);
        this.stats.totalScanned = directories.length;
        // Process directories grouped by depth to ensure children are removed before parents
        const batchSize = this.config.maxConcurrency;
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
    async removeDirectory(dir, onProgress) {
        try {
            // Double-check if directory is still empty before removal
            const items = await fs.readdir(dir.path);
            if (items.length === 0) {
                if (!this.config.dryRun) {
                    await fs.rmdir(dir.path);
                }
                this.stats.totalRemoved++;
                onProgress(`${this.config.dryRun ? '[DRY RUN] Would remove' : 'Removed'}: ${path.basename(dir.path)}`);
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
        aggregated.errors.push(...stats.errors);
    }
    return aggregated;
}
//# sourceMappingURL=core.js.map