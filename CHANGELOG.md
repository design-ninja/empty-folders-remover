# Changelog

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
