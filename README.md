# SnippetCreator - VS Code Extension

## Words From The Author

**Terry Yang**

I created this extension to address my own needs for efficient code snippet creation and text manipulation. As both the developer and a daily user of this tool, I can personally guarantee its **safety** and **reliability**. Every feature has been thoroughly tested in my own workflow, ensuring that *Terry's Snippet Creator* delivers a seamless and secure editing experience.

If you have questions, feedback, or feature requests, feel free to reach out through the [GitHub repository](https://github.com/0x7FFFFFFFFFFFFFFF/snippetcreator).

*"Build tools you'd trust to use yourself."*

## Overview

*Terry's Snippet Creator* started as a simple tool to create code snippets in separate files, but has evolved into a powerful text manipulation toolkit. While the name remains *Terry's Snippet Creator*, it now offers a diverse set of features to enhance your editing workflow in Visual Studio Code.

## Features

### Snippet Creation
Create well-formatted code snippets in separate files with ease:
- Quick creation of tabstops and multi-choice tabstops
- Automatic escaping of special characters
- Properly formatted JSON output for direct use in VS Code

![Basic snippet feature](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/basic_snippet.gif)
![Multi choice tabstop](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/multi_option_tabstop.gif)

### Regex Selection
Quickly select multiple occurrences of text that match a regular expression pattern:
- Select all matches across your document in a single operation
- Edit multiple instances simultaneously

![Regex selection](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/regex_selection.gif)

### Number Sequence Generation
Replace multiple selections with auto-incremented number sequences:
- Support for custom starting values and increments
- Zero-padded number formatting (01, 02, 03...)

![Number sequence](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/number_sequence.gif)

### Mathematical Operations on Numbers
Perform calculations on numeric portions of text:
- Apply simple operations (+, -, *, /) to numbers in selections
- Support for complex expressions with the selected number as a variable
- Decimal precision control for formatted output
- Works with both pure numbers and numbers embedded in text

![Math operation](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/math_operation.gif)

### Text Alignment
Align text based on specified characters or patterns:
- Align code by equals signs, colons, or any custom delimiter
- Support for regex-based alignment points
- Maintain proper indentation while aligning

![Regex align](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/regex_align.gif)

### Highlighting
Highlight different portions of text with vivid colors to improve readability:
- Multiple distinct highlight colors
- Persistent highlighting across editing sessions

![Highlighting](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/highlighting.gif)

### Batch Text Operations
Store and replay multiple text replacement operations:
- Save sequences of find/replace operations for future use
- Export and import operation lists to share with team members
- Execute complex text transformations with a single command

![Selection to cursors](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/selection_to_cursors.gif)
![Toggle between single line selection and cursor](https://raw.githubusercontent.com//0x7FFFFFFFFFFFFFFF/snippetcreator/main/images/toggle_single_line_selection_cursor.gif)

### Bracket / Quote Select (`Ctrl+Q`)

Cycle through bracket and quote types surrounding the cursor, or remove them entirely — all without leaving the keyboard.

Place your cursor inside any bracketed or quoted expression, then press `Ctrl+Q` repeatedly:

| Press | Effect |
|-------|--------|
| x1 | Selects the text enclosed by the nearest brackets/quotes |
| x2 | Replaces the brackets with `"..."` (double quotes) |
| x3 | Replaces with `(...)` (parentheses) |
| x4 | Replaces with `[...]` (square brackets) |
| x5 | Replaces with `{...}` (curly braces) |
| x6 | Replaces with `<...>` (angle brackets) |
| x7 | Removes the brackets entirely, keeping text selected |
| x8 | Applies `"..."` around the remembered positions |
| ... | Continues cycling through bracket types |
| x14 | Restores original brackets and cursor position |

**Example** — starting with cursor at `|` inside `'cd ef'`:

```
"ab 'cd| ef' gh"   (initial state)
"ab '<cd ef>' gh"  (x1  — selected)
"ab "<cd ef>" gh"  (x2  — double quotes)
"ab (<cd ef>) gh"  (x3  — parentheses)
"ab [<cd ef>] gh"  (x4  — square brackets)
"ab {<cd ef>} gh"  (x5  — curly braces)
"ab <<cd ef>> gh"  (x6  — angle brackets)
"ab <cd ef> gh"    (x7  — brackets removed)
"ab "<cd ef>" gh"  (x8  — double quotes re-added)
...
"ab 'cd| ef' gh"   (x14 — restored)
```

Multiple cursors are supported: each cursor independently finds and cycles through the nearest brackets around it.

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Access features through the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac)
3. Use keyboard shortcuts for frequently used operations

## Keyboard Shortcuts

| Feature | Windows/Linux |
|---------|--------------|
| Select by Regex | `Ctrl+Alt+S` |
| Text Alignment | `Ctrl+Alt+R` |
| Number Sequence | `Ctrl+Shift+N` |
| Math Operations | `Ctrl+Shift+M` |
| Add Highlight | `Ctrl+Alt+7` |
| Add a tabstop | `Ctrl+Shift+X` |
| Add a multi-choice tabstop | `Ctrl+Shift+Alt+X` |
| Save Current Snippet | `Ctrl+Shift+Z` |
| Line Operations | `Alt+L` |
| Bracket / Quote Select | `Ctrl+Q` |

Use the command palette for other features. In the command palette, type "SnippetCreator" to see all available commands.

## Known Issues
When clearing highlights, you may need switch to a different editor tab and back to see the changes. I have not yet found a way to force the editor to refresh the highlights.

## License

WTFPL (What The Fuck Public License) - Use at your own risk. No warranties or guarantees are provided. By using this extension, you agree to the terms of the WTFPL.
