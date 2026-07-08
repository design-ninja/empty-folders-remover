# Changelog

## [1.6.1] - 2026-07-08

### Fixed
- The 1.6.0 package published to Open VSX was built before the changelog was finalized and shipped without the 1.6.0 release notes; this release restores them
- Lowered the minimum supported VS Code version back to 1.96: version 1.6.0 unnecessarily required 1.125, locking out users on older VS Code and Cursor builds (no 1.125-only APIs are used)

## [1.6.0] - 2026-07-08

### Safety
- Removed folders and junk files are now moved to the OS trash instead of being deleted permanently (new `emptyFoldersRemover.useTrash` setting, enabled by default)
- Nested workspace roots in multi-root workspaces are now protected from removal
- Junk file patterns without literal characters (e.g. `*`, `*.*`) are ignored with a warning to prevent accidental mass deletion
- Declared Workspace Trust support: the extension is disabled in untrusted workspaces

### Added
- "Remove Empty Folders" entry in the Explorer folder context menu (processes only the selected folder)
- Scan warnings: unreadable directories are now reported instead of being silently skipped
- The `showProgress` setting now actually works: when disabled, per-item details (folder name, percentage, ETA) are hidden

### Fixed
- License metadata corrected to MIT (matching the LICENSE file)
- `aggregateStats` now sums operation durations
- Command works correctly when the workspace contains zero folders

### Performance
- Scanning concurrency is now capped by `maxConcurrency` (previously unbounded, could exhaust file descriptors on huge trees)
- Removal now uses a worker pool instead of fixed batches

### Changed
- Command palette entry is now prefixed with the "Empty Folders Remover" category
- Minimum supported VS Code version raised to 1.125
- Updated all dev dependencies (TypeScript 6, Mocha 11.7.6); removed unused ones (`glob`, `sinon`, `ts-node`)

## [1.5.0] - 2026-07-08

### Added
- New `emptyFoldersRemover.junkFiles` setting (default: `.DS_Store`, `Thumbs.db`, `desktop.ini`): folders containing only OS junk files are now treated as empty and removed together with the junk files. Supports wildcards (*), case-insensitive. Set to `[]` to restore the previous strict behavior.

## [1.4.1] - 2026-05-06

### Fixed
- Prevent workspace root folders from being removed during empty-folder cleanup
- Ensure dry-run mode reports nested empty folder chains correctly
- Clamp invalid `maxConcurrency` settings to avoid hangs
- Treat wildcard exclude pattern metacharacters literally

### Safety
- Add regression coverage to verify folders with files, hidden files, or files created after scanning are preserved

## [1.4.0] - 2026-01-24

### Added
- Multi-root workspace support: now processes all folders in a workspace instead of only the first one
- Unit test suite with 19 tests covering core functionality

### Fixed
- Progress tracker percentage and ETA calculations now work correctly

### Changed
- Refactored core logic into separate module for better testability

## [1.3.0] - 2025-12-28

### Performance
- Use `readdir` with `withFileTypes` option to avoid extra `stat` calls
- Parallelize subdirectory scanning with `Promise.all`
- Cache RegExp patterns for exclude matching
- Use `Set` for O(1) simple pattern matching

### Fixed
- Remove unused `fsSync` import

### Added
- Bugs URL in package.json for issue reporting
- Lazy activation events

## [1.2.0] - 2025-10-18

### Added
- Cascade removal of empty folders: parent directories are removed when all children are empty
- Depth-grouped deletion to ensure correct order (children before parents)

## [1.1.3] - 2025-06-21

### Fixed
- Removed conflicting files index.js and index.ts from the root of the project
- Added .vscodeignore file for package extension optimization
- Fixed project structure for proper operation in Cursor

## [1.1.2] - 2025-06-21

- Maintenance release and dependency updates.

## [1.1.1] - 2025-06-21

- Replace synchronous fs with fs/promises for better performance
- Add ProgressTracker class with ETA and percentage display
- Implement DirectoryScanner with configurable exclude patterns
- Add comprehensive error handling and operation statistics
- Support dry-run mode and cancellation tokens
- Include detailed logging and user feedback features

Huge thanks to [@Sato-Isolated](https://github.com/Sato-Isolated) for this contribution! ✌️

## [1.0.5] - 2025-05-03

- Show meaningful message when no empty folders are found

## [1.0.4] - 2024-03-20

- Added progress indicator while removing folders
- Added cancellation support
- Improved error handling for non-existent directories
- Added detailed logging for removed folders

## [1.0.3] - 2024-03-19

- Fixed issue with directory existence checking
- Improved error messages
- Added proper plural forms for folder count

## [1.0.2] - 2024-03-18

- Added icon for marketplace
- Updated display name
- Improved keywords for better discoverability

## [1.0.1] - 2024-03-17

- Fixed package.json configuration
- Added proper repository links
- Updated author information

## [1.0.0] - 2024-03-16

- Initial release
- Basic functionality for finding and removing empty folders
- Command palette integration
- Error handling and notifications
