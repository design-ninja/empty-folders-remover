import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  DirectoryScanner,
  EmptyFolderRemover,
  EmptyFolderConfig,
  CancellationToken,
  createEmptyStats,
  aggregateStats,
  partitionJunkPatterns,
  isUnsafeJunkPattern,
  DirectoryInfo
} from "../core";

// Helper to create a test directory structure
async function createTestStructure(basePath: string, structure: Record<string, string | null>): Promise<void> {
  for (const [relativePath, content] of Object.entries(structure)) {
    const fullPath = path.join(basePath, relativePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    if (content !== null) {
      await fs.writeFile(fullPath, content);
    }
  }
}

// Helper to create a non-cancelling token
function createToken(cancelled = false): CancellationToken {
  return { isCancellationRequested: cancelled };
}

// Default test config
function createTestConfig(overrides: Partial<EmptyFolderConfig> = {}): EmptyFolderConfig {
  return {
    excludePatterns: [".git", "node_modules"],
    junkFiles: [".DS_Store", "Thumbs.db", "desktop.ini"],
    maxConcurrency: 10,
    dryRun: false,
    showProgress: true,
    ...overrides
  };
}

describe("DirectoryScanner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "efr-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("shouldExclude", () => {
    it("should exclude exact pattern matches (case-insensitive)", () => {
      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: [".git", "node_modules"]
      }));

      assert.strictEqual(scanner.shouldExclude(".git"), true);
      assert.strictEqual(scanner.shouldExclude(".GIT"), true);
      assert.strictEqual(scanner.shouldExclude("node_modules"), true);
      assert.strictEqual(scanner.shouldExclude("NODE_MODULES"), true);
      assert.strictEqual(scanner.shouldExclude("src"), false);
    });

    it("should exclude wildcard pattern matches", () => {
      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: ["*.cache", "test*"]
      }));

      assert.strictEqual(scanner.shouldExclude(".cache"), true);
      assert.strictEqual(scanner.shouldExclude("my.cache"), true);
      assert.strictEqual(scanner.shouldExclude("test"), true);
      assert.strictEqual(scanner.shouldExclude("testing"), true);
      assert.strictEqual(scanner.shouldExclude("src"), false);
    });

    it("should handle empty exclude patterns", () => {
      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: []
      }));

      assert.strictEqual(scanner.shouldExclude(".git"), false);
      assert.strictEqual(scanner.shouldExclude("node_modules"), false);
    });

    it("should treat wildcard pattern metacharacters literally", () => {
      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: ["*[", "foo.+*"]
      }));

      assert.strictEqual(scanner.shouldExclude("abc["), true);
      assert.strictEqual(scanner.shouldExclude("abcx"), false);
      assert.strictEqual(scanner.shouldExclude("foo.+bar"), true);
      assert.strictEqual(scanner.shouldExclude("foox+bar"), false);
    });
  });

  describe("scanDirectories", () => {
    it("should find empty directories", async () => {
      await createTestStructure(tempDir, {
        "empty-folder/.gitkeep": null, // Create dir only
        "non-empty/file.txt": "content"
      });
      // Remove the placeholder approach - create empty dir directly
      await fs.mkdir(path.join(tempDir, "empty-folder"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const emptyDir = directories.find(d => d.path === path.join(tempDir, "empty-folder"));
      const nonEmptyDir = directories.find(d => d.path === path.join(tempDir, "non-empty"));

      assert.ok(emptyDir, "Should find empty-folder");
      assert.strictEqual(emptyDir.isEmpty, true);
      assert.ok(nonEmptyDir, "Should find non-empty");
      assert.strictEqual(nonEmptyDir.isEmpty, false);
    });

    it("should detect nested empty directories (cascade)", async () => {
      // Create: parent/child/grandchild (all empty)
      await fs.mkdir(path.join(tempDir, "parent", "child", "grandchild"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const parent = directories.find(d => d.path === path.join(tempDir, "parent"));
      const child = directories.find(d => d.path === path.join(tempDir, "parent", "child"));
      const grandchild = directories.find(d => d.path === path.join(tempDir, "parent", "child", "grandchild"));

      assert.ok(grandchild?.isEmpty, "grandchild should be empty");
      assert.ok(child?.isEmpty, "child should be empty (only contains empty grandchild)");
      assert.ok(parent?.isEmpty, "parent should be empty (only contains empty child)");
    });

    it("should mark parent as non-empty if child has files", async () => {
      await createTestStructure(tempDir, {
        "parent/child/file.txt": "content"
      });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const parent = directories.find(d => d.path === path.join(tempDir, "parent"));
      const child = directories.find(d => d.path === path.join(tempDir, "parent", "child"));

      assert.strictEqual(child?.isEmpty, false);
      assert.strictEqual(parent?.isEmpty, false);
    });

    it("should treat hidden files as content", async () => {
      await createTestStructure(tempDir, {
        "parent/child/.gitkeep": ""
      });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const parent = directories.find(d => d.path === path.join(tempDir, "parent"));
      const child = directories.find(d => d.path === path.join(tempDir, "parent", "child"));

      assert.strictEqual(child?.isEmpty, false);
      assert.strictEqual(parent?.isEmpty, false);
    });

    it("should treat folders containing only junk files as empty", async () => {
      await createTestStructure(tempDir, {
        "assets/video/.DS_Store": "junk",
        "non-empty/.DS_Store": "junk",
        "non-empty/file.txt": "content"
      });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const assets = directories.find(d => d.path === path.join(tempDir, "assets"));
      const video = directories.find(d => d.path === path.join(tempDir, "assets", "video"));
      const nonEmpty = directories.find(d => d.path === path.join(tempDir, "non-empty"));

      assert.strictEqual(video?.isEmpty, true, "video contains only .DS_Store");
      assert.strictEqual(assets?.isEmpty, true, "assets contains only empty video");
      assert.strictEqual(nonEmpty?.isEmpty, false, "non-empty has a real file");
    });

    it("should match junk files case-insensitively and with wildcards", async () => {
      await createTestStructure(tempDir, {
        "a/THUMBS.DB": "junk",
        "b/scratch.tmp": "junk"
      });

      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: [],
        junkFiles: ["Thumbs.db", "*.tmp"]
      }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const a = directories.find(d => d.path === path.join(tempDir, "a"));
      const b = directories.find(d => d.path === path.join(tempDir, "b"));

      assert.strictEqual(a?.isEmpty, true);
      assert.strictEqual(b?.isEmpty, true);
    });

    it("should treat junk files as content when junkFiles is empty", async () => {
      await createTestStructure(tempDir, {
        "folder/.DS_Store": "junk"
      });

      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: [],
        junkFiles: []
      }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const folder = directories.find(d => d.path === path.join(tempDir, "folder"));
      assert.strictEqual(folder?.isEmpty, false);
    });

    it("should skip excluded directories", async () => {
      await fs.mkdir(path.join(tempDir, "node_modules", "package"), { recursive: true });
      await fs.mkdir(path.join(tempDir, ".git", "objects"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: [".git", "node_modules"]
      }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const paths = directories.map(d => d.path);

      assert.ok(!paths.some(p => p.includes("node_modules")), "Should not scan node_modules");
      assert.ok(!paths.some(p => p.includes(".git")), "Should not scan .git");
      assert.ok(paths.some(p => p.includes("src")), "Should scan src");
    });

    it("should ignore unsafe junk patterns (treat matching files as content)", async () => {
      await createTestStructure(tempDir, {
        "folder/important.txt": "content"
      });

      const scanner = new DirectoryScanner(createTestConfig({
        excludePatterns: [],
        junkFiles: ["*", "*.*", ".DS_Store"]
      }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const folder = directories.find(d => d.path === path.join(tempDir, "folder"));
      assert.strictEqual(folder?.isEmpty, false, "Unsafe patterns must not mark real files as junk");
    });

    it("should collect scan errors for unreadable directories", async function () {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        this.skip(); // chmod-based access denial is unreliable on Windows / as root
      }

      const lockedDir = path.join(tempDir, "locked");
      await fs.mkdir(lockedDir);
      await fs.chmod(lockedDir, 0o000);

      try {
        const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
        const directories = await scanner.scanDirectories(tempDir, createToken());

        assert.strictEqual(scanner.getScanErrors().length, 1);
        assert.ok(scanner.getScanErrors()[0].includes(lockedDir));

        // The unreadable directory must not be reported at all (never marked empty)
        assert.ok(!directories.some(d => d.path === lockedDir));
      } finally {
        await fs.chmod(lockedDir, 0o755);
      }
    });

    it("should reset scan errors between scans", async function () {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        this.skip();
      }

      const lockedDir = path.join(tempDir, "locked");
      await fs.mkdir(lockedDir);
      await fs.chmod(lockedDir, 0o000);

      try {
        const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
        await scanner.scanDirectories(tempDir, createToken());
        assert.strictEqual(scanner.getScanErrors().length, 1);

        await fs.chmod(lockedDir, 0o755);
        await scanner.scanDirectories(tempDir, createToken());
        assert.strictEqual(scanner.getScanErrors().length, 0);
      } finally {
        await fs.chmod(lockedDir, 0o755).catch(() => {});
      }
    });

    it("should respect cancellation token", async () => {
      await fs.mkdir(path.join(tempDir, "folder1"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "folder2"), { recursive: true });

      const cancelledToken = createToken(true);
      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, cancelledToken);

      assert.strictEqual(directories.length, 0, "Should return empty when cancelled");
    });
  });
});

describe("EmptyFolderRemover", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "efr-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("removeEmptyFolders", () => {
    it("should remove empty directories", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const directories: DirectoryInfo[] = [
        { path: emptyDir, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const progressMessages: string[] = [];
      const stats = await remover.removeEmptyFolders(
        directories,
        (msg) => progressMessages.push(msg),
        createToken()
      );

      assert.strictEqual(stats.totalRemoved, 1);
      assert.strictEqual(stats.totalErrors, 0);

      // Verify directory was actually removed
      await assert.rejects(fs.access(emptyDir), "Directory should be removed");
    });

    it("should not remove directories in dry run mode", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const directories: DirectoryInfo[] = [
        { path: emptyDir, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig({ dryRun: true }));
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 1);

      // Verify directory still exists
      await fs.access(emptyDir); // Should not throw
    });

    it("should count nested empty directories in dry run mode", async () => {
      await fs.mkdir(path.join(tempDir, "a", "b", "c", "d", "e"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());
      const remover = new EmptyFolderRemover(createTestConfig({ dryRun: true }));
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 5);
      await fs.access(path.join(tempDir, "a", "b", "c", "d", "e"));
    });

    it("should skip directories that are no longer empty", async () => {
      const dirPath = path.join(tempDir, "was-empty");
      await fs.mkdir(dirPath);

      // Mark as empty in our list, but add a file before removal
      await fs.writeFile(path.join(dirPath, "new-file.txt"), "content");

      const directories: DirectoryInfo[] = [
        { path: dirPath, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 0, "Should not remove non-empty directory");
      await fs.access(dirPath); // Directory should still exist
    });

    it("should preserve a scanned empty chain if a file appears before removal", async () => {
      const deepest = path.join(tempDir, "a", "b", "c", "d");
      await fs.mkdir(deepest, { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());
      await fs.writeFile(path.join(deepest, "important.txt"), "content");

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 0);
      assert.strictEqual(stats.totalErrors, 0);
      await fs.access(path.join(deepest, "important.txt"));
      await fs.access(path.join(tempDir, "a"));
    });

    it("should preserve non-empty branches while removing empty branches", async () => {
      await createTestStructure(tempDir, {
        "non-empty/deep/important.txt": "content"
      });
      await fs.mkdir(path.join(tempDir, "empty", "deep"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());
      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 2);
      await fs.access(path.join(tempDir, "non-empty", "deep", "important.txt"));
      await assert.rejects(fs.access(path.join(tempDir, "empty")), "Empty branch should be removed");
    });

    it("should remove nested empty directories (children before parents)", async () => {
      const parent = path.join(tempDir, "parent");
      const child = path.join(parent, "child");
      await fs.mkdir(child, { recursive: true });

      const directories: DirectoryInfo[] = [
        { path: child, depth: 2, isEmpty: true },
        { path: parent, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 2);
      await assert.rejects(fs.access(parent), "Parent should be removed");
    });

    it("should preserve the workspace root when an empty chain is removed", async () => {
      await fs.mkdir(path.join(tempDir, "a", "b", "c", "d"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());
      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 4);
      await fs.access(tempDir);
      await assert.rejects(fs.access(path.join(tempDir, "a")), "Nested chain should be removed");
    });

    it("should remove nested folders containing only junk files", async () => {
      const video = path.join(tempDir, "assets", "video");
      await fs.mkdir(video, { recursive: true });
      await fs.writeFile(path.join(video, ".DS_Store"), "junk");

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());
      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 2);
      assert.strictEqual(stats.totalErrors, 0);
      await assert.rejects(fs.access(path.join(tempDir, "assets")), "assets should be removed");
    });

    it("should not remove a folder where a real file appeared next to junk", async () => {
      const dirPath = path.join(tempDir, "was-empty");
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, ".DS_Store"), "junk");
      await fs.writeFile(path.join(dirPath, "important.txt"), "content");

      const directories: DirectoryInfo[] = [
        { path: dirPath, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 0);
      await fs.access(path.join(dirPath, ".DS_Store"));
      await fs.access(path.join(dirPath, "important.txt"));
    });

    it("should not delete junk files in dry run mode", async () => {
      const dirPath = path.join(tempDir, "junk-only");
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, ".DS_Store"), "junk");

      const directories: DirectoryInfo[] = [
        { path: dirPath, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig({ dryRun: true }));
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 1);
      await fs.access(path.join(dirPath, ".DS_Store"));
    });

    it("should clamp invalid max concurrency values", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const directories: DirectoryInfo[] = [
        { path: emptyDir, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig({ maxConcurrency: 0 }));
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 1);
      assert.strictEqual(stats.totalErrors, 0);
      await assert.rejects(fs.access(emptyDir), "Directory should be removed");
    });

    it("should handle errors gracefully", async () => {
      const nonExistent = path.join(tempDir, "does-not-exist");

      const directories: DirectoryInfo[] = [
        { path: nonExistent, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalErrors, 1);
      assert.strictEqual(stats.errors.length, 1);
    });

    it("should respect cancellation token", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const directories: DirectoryInfo[] = [
        { path: emptyDir, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken(true));

      assert.strictEqual(stats.totalRemoved, 0);
      await fs.access(emptyDir); // Directory should still exist
    });

    it("should track scanned count correctly", async () => {
      const directories: DirectoryInfo[] = [
        { path: path.join(tempDir, "a"), depth: 1, isEmpty: false },
        { path: path.join(tempDir, "b"), depth: 1, isEmpty: false },
        { path: path.join(tempDir, "c"), depth: 1, isEmpty: false }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalScanned, 3);
    });

    it("should never remove protected paths (nested workspace roots)", async () => {
      const nestedRoot = path.join(tempDir, "packages", "lib");
      await fs.mkdir(nestedRoot, { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      const remover = new EmptyFolderRemover(createTestConfig({
        protectedPaths: [nestedRoot]
      }));
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      await fs.access(nestedRoot); // Protected nested root must survive
      // Its parent chain must survive too: "packages" still contains "lib"
      await fs.access(path.join(tempDir, "packages"));
      assert.strictEqual(stats.totalRemoved, 0);
    });

    it("should reset stats between removeEmptyFolders calls", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.mkdir(emptyDir);

      const directories: DirectoryInfo[] = [
        { path: emptyDir, depth: 1, isEmpty: true }
      ];

      const remover = new EmptyFolderRemover(createTestConfig());
      await remover.removeEmptyFolders(directories, () => {}, createToken());
      const secondStats = await remover.removeEmptyFolders([], () => {}, createToken());

      assert.strictEqual(secondStats.totalRemoved, 0, "Stats must not accumulate across calls");
      assert.strictEqual(secondStats.totalScanned, 0);
    });

    it("should route deletions through injected file operations", async () => {
      const emptyDir = path.join(tempDir, "junk-only");
      await fs.mkdir(emptyDir);
      await fs.writeFile(path.join(emptyDir, ".DS_Store"), "junk");

      const deletedFiles: string[] = [];
      const deletedDirs: string[] = [];

      const remover = new EmptyFolderRemover(createTestConfig(), {
        readDirectory: async (dirPath) => {
          const items = await fs.readdir(dirPath, { withFileTypes: true });
          return items.map(i => ({ name: i.name, isDirectory: i.isDirectory() }));
        },
        deleteFile: async (filePath) => {
          deletedFiles.push(filePath);
        },
        deleteEmptyDirectory: async (dirPath) => {
          deletedDirs.push(dirPath);
        }
      });

      const directories: DirectoryInfo[] = [
        { path: emptyDir, depth: 1, isEmpty: true }
      ];
      const stats = await remover.removeEmptyFolders(directories, () => {}, createToken());

      assert.strictEqual(stats.totalRemoved, 1);
      assert.deepStrictEqual(deletedFiles, [path.join(emptyDir, ".DS_Store")]);
      assert.deepStrictEqual(deletedDirs, [emptyDir]);
      // Real file system untouched by the fake operations
      await fs.access(path.join(emptyDir, ".DS_Store"));
    });
  });
});

describe("Junk pattern safety", () => {
  it("should flag patterns without literal characters as unsafe", () => {
    assert.strictEqual(isUnsafeJunkPattern("*"), true);
    assert.strictEqual(isUnsafeJunkPattern("*.*"), true);
    assert.strictEqual(isUnsafeJunkPattern("**"), true);
    assert.strictEqual(isUnsafeJunkPattern("."), true);
    assert.strictEqual(isUnsafeJunkPattern(" * "), true);
    assert.strictEqual(isUnsafeJunkPattern(""), true);
  });

  it("should keep patterns with literal characters as safe", () => {
    assert.strictEqual(isUnsafeJunkPattern(".DS_Store"), false);
    assert.strictEqual(isUnsafeJunkPattern("*.tmp"), false);
    assert.strictEqual(isUnsafeJunkPattern("Thumbs.db"), false);
    assert.strictEqual(isUnsafeJunkPattern("desktop.ini"), false);
  });

  it("should partition patterns into safe and unsafe", () => {
    const result = partitionJunkPatterns([".DS_Store", "*", "*.tmp", "*.*"]);
    assert.deepStrictEqual(result.safe, [".DS_Store", "*.tmp"]);
    assert.deepStrictEqual(result.unsafe, ["*", "*.*"]);
  });
});

describe("Helper functions", () => {
  describe("createEmptyStats", () => {
    it("should create stats with zero values", () => {
      const stats = createEmptyStats();

      assert.strictEqual(stats.totalScanned, 0);
      assert.strictEqual(stats.totalRemoved, 0);
      assert.strictEqual(stats.totalErrors, 0);
      assert.strictEqual(stats.duration, 0);
      assert.deepStrictEqual(stats.errors, []);
    });
  });

  describe("aggregateStats", () => {
    it("should aggregate multiple stats objects", () => {
      const stats1 = {
        totalScanned: 10,
        totalRemoved: 5,
        totalErrors: 1,
        duration: 100,
        errors: ["error1"]
      };
      const stats2 = {
        totalScanned: 20,
        totalRemoved: 8,
        totalErrors: 2,
        duration: 200,
        errors: ["error2", "error3"]
      };

      const aggregated = aggregateStats([stats1, stats2]);

      assert.strictEqual(aggregated.totalScanned, 30);
      assert.strictEqual(aggregated.totalRemoved, 13);
      assert.strictEqual(aggregated.totalErrors, 3);
      assert.strictEqual(aggregated.duration, 300);
      assert.deepStrictEqual(aggregated.errors, ["error1", "error2", "error3"]);
    });

    it("should handle empty array", () => {
      const aggregated = aggregateStats([]);

      assert.strictEqual(aggregated.totalScanned, 0);
      assert.strictEqual(aggregated.totalRemoved, 0);
    });
  });
});
