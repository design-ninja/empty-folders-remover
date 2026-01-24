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

    it("should sort directories by depth (deepest first)", async () => {
      await fs.mkdir(path.join(tempDir, "a", "b", "c"), { recursive: true });

      const scanner = new DirectoryScanner(createTestConfig({ excludePatterns: [] }));
      const directories = await scanner.scanDirectories(tempDir, createToken());

      // Verify deepest comes first
      for (let i = 1; i < directories.length; i++) {
        assert.ok(
          directories[i - 1].depth >= directories[i].depth,
          `Directory at index ${i - 1} should have depth >= directory at index ${i}`
        );
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
      assert.deepStrictEqual(aggregated.errors, ["error1", "error2", "error3"]);
    });

    it("should handle empty array", () => {
      const aggregated = aggregateStats([]);

      assert.strictEqual(aggregated.totalScanned, 0);
      assert.strictEqual(aggregated.totalRemoved, 0);
    });
  });
});
