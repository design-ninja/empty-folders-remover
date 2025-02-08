# Empty Folders Remover

A simple and efficient Visual Studio Code extension that helps maintain cleanliness in your projects by finding and removing empty folders.

## Features

- 🔍 Recursive search for empty folders in your project
- 🗑️ Automatic removal of found empty directories
- 📊 Display of removed folders count
- ⚡ Quick execution via command palette
- 🛡️ Safe operation with error notifications

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Empty Folders Remover"
4. Click Install

## Usage

1. Open your project folder in VS Code
2. Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
3. Type "Remove Empty Folders"
4. Press Enter

After execution, the extension will show the number of empty folders removed.

## Requirements

- Visual Studio Code version 1.60.0 or higher

## Safety Notes

- The extension only removes completely empty folders
- It's recommended to backup your project before using
- Folders containing hidden files (like .gitkeep) are not considered empty and won't be removed

## How it works

The extension performs a recursive scan of your project directory, identifying folders that don't contain any files or subfolders. When such folders are found, they are safely removed from the project structure.

## Contributing

Contributions are welcome! Feel free to submit issues and pull requests on our GitHub repository.

## License

This extension is released under the [MIT License](LICENSE).

## Support

If you encounter any issues or have suggestions for improvements, please open an issue on our GitHub repository.

## Release Notes

### 1.0.0

Initial release of Empty Folders Remover:

- Basic functionality for finding and removing empty folders
- Command palette integration
- Error handling and notifications

---

**Enjoy cleaner projects!** 🚀
