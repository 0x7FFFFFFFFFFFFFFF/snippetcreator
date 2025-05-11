// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
const parser = require('./parser');

const fs = require('fs');
const path = require('path');
const os = require('os');

enum PartType {
    Regex,
    Text,
}

interface Part {
    type: PartType;
    value: string;
}

interface Line {
    number: number;
    parts: Part[];
}

function trimStart(value: string): string {
    return value.replace(/^\s+([^\s].*)/, '$1');
}

function trimStartButOne(value: string): string {
    return value.replace(/^\s+([^\s].*)/, ' $1');
}

function trimEnd(value: string): string {
    return value.replace(/(.*[^\s])\s+$/, '$1');
}

function trimEndButOne(value: string): string {
    return value.replace(/(.*[^\s])\s+$/, '$1 ');
}

function trimButOne(value: string): string {
    let result: string = value;
    result = trimStartButOne(result);
    result = trimEndButOne(result);
    return result;
}

function extendToLength(value: string, length: number, tabSize: number): string {
    return value + ' '.repeat(Math.max(0, length - tabAwareLength(value, tabSize)));
}

function tabAwareLength(value: string, tabSize: number): number {
    var length = 0;
    for (let idx = 0; idx < value.length; ++idx) {
        length += value.charAt(idx) === "\t" ? tabSize : 1;
    }
    return length;
}

function checkedRegex(input: string): RegExp | undefined {
    try {
        return new RegExp(input, 'g');
    } catch (e) {
        return undefined;
    }
}

// Helper function to process replacement text and handle escape sequences
function processReplacement(replacePattern: string): string {
    // This regex handles escaped characters without double-processing
    return replacePattern.replace(/\\(\\)|\\([tnrfv]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (match, escapedBackslash, escapeChar) => {
        // If it's an escaped backslash (\\), return a single backslash
        if (escapedBackslash) {
            return '\\';
        }

        // Handle other escape sequences
        if (escapeChar) {
            switch (escapeChar[0]) {
                case 't': return '\t';  // tab
                case 'n': return '\n';  // newline
                case 'r': return '\r';  // carriage return
                case 'f': return '\f';  // form feed
                case 'v': return '\v';  // vertical tab
                case 'x': // hex escape
                    return String.fromCharCode(parseInt(escapeChar.substring(1), 16));
                case 'u': // unicode escape
                    return String.fromCharCode(parseInt(escapeChar.substring(1), 16));
            }
        }

        // If no special handling was applied, return the original match
        return match;
    });
}

// Properly escape backslashes for display
function escapeForDisplay(str: string): string {
    return str.replace(/\\/g, '\\\\');
}

// Helper function to escape a backslash in replacement strings
function escapeBackslash(str: string): string {
    return str.replace(/\\/g, '\\\\');
}

// Helper function to escape HTML
function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

class Block {
    lines: Line[] = [];

    constructor(text: string, input: string, startLine: number, eol: vscode.EndOfLine) {
        let splitString: string;
        if (eol === vscode.EndOfLine.CRLF) {
            splitString = '\r\n';
        } else {
            splitString = '\n';
        }
        let textLines = text.split(splitString);
        let regex = checkedRegex(input);

        /* basic protection from bad regexes */
        if (regex !== undefined) {
            for (let i = 0; i < textLines.length; i++) {
                let lineText = textLines[i];
                let lineObject = { number: startLine + i, parts: [] as Part[] };

                /* get all matches at once */
                let textStartPosition = 0;
                let result;
                while (result = regex.exec(lineText)) {
                    let matchedSep = result[0];
                    if (matchedSep === "") {
                        /* if the regex return 0 length matches, e.g. the '|' operator, stop pushing line objects */
                        break;
                    }
                    let regexStartPosition = regex.lastIndex - matchedSep.length;
                    lineObject.parts.push({ type: PartType.Text, value: lineText.substring(textStartPosition, regexStartPosition) });
                    lineObject.parts.push({ type: PartType.Regex, value: matchedSep });
                    textStartPosition = regex.lastIndex;
                }
                lineObject.parts.push({ type: PartType.Text, value: lineText.substring(textStartPosition, lineText.length) });
                this.lines.push(lineObject);
            }
        }
    }

    trim(): Block {
        for (let line of this.lines) {
            for (let i = 0; i < line.parts.length; i++) {
                let part = line.parts[i];
                if (i === 0) {
                    part.value = trimEndButOne(part.value);
                } else if (i < line.parts.length - 1) {
                    part.value = trimButOne(part.value);
                } else {
                    let intermediate = trimStartButOne(part.value);
                    part.value = trimEnd(intermediate);
                }
            }
        }
        return this;
    }

    align(): Block {
        /* get editor tab size */
        let tabSize: number | undefined = vscode.workspace.getConfiguration('editor', null).get('tabSize');

        /* check that we actually got a valid tab size and that it isn't set to a value < 1. */
        if (tabSize === undefined || tabSize < 1) {
            /* give helpful error message on console */
            console.log('Error [Align by Regex]: Invalid tab size setting "editor.tabSize" for alignment.');

            /* assume tab size == 1 if tab size is missing */
            tabSize = 1;
        }

        /* get maximum number of parts */
        let maxNrParts: number = 1;
        for (let idx = 0; idx < this.lines.length; ++idx) {
            let len = this.lines[idx].parts.length;
            if (len > maxNrParts) {
                maxNrParts = len;
            }
        }

        /* create array with the right size and initialize array with 0 */
        let maxLength: number[] = Array(maxNrParts).fill(0);
        for (let line of this.lines) {
            // no match, only one part => ignore line in max length calculation
            if (line.parts.length > 1) {
                for (let i = 0; i < line.parts.length; i++) {
                    maxLength[i] = Math.max(maxLength[i], tabAwareLength(line.parts[i].value, tabSize));
                }
            }
        }
        for (let line of this.lines) {
            for (let i = 0; i < line.parts.length - 1; i++) {
                line.parts[i].value = extendToLength(line.parts[i].value, maxLength[i], tabSize);
            }
        }
        return this;
    }
}

/** Function that count occurrences of a substring in a string;
 * @param {String} string               The string
 * @param {String} subString            The sub string to search for
 * @param {Boolean} [allowOverlapping]  Optional. (Default:false)
 *
 * @author Vitim.us https://gist.github.com/victornpb/7736865
 * @see Unit Test https://jsfiddle.net/Victornpb/5axuh96u/
 * @see http://stackoverflow.com/questions/4009756/how-to-count-string-occurrence-in-string/7924240#7924240
 */
function occurrences(string: any, subString: any, allowOverlapping: boolean) {

    string += "";
    subString += "";
    if (subString.length <= 0) {
        return (string.length + 1);
    }

    var n = 0, pos = 0, step = allowOverlapping ? 1 : subString.length;

    while (true) {
        pos = string.indexOf(subString, pos);
        if (pos >= 0) {
            ++n;
            pos += step;
        }
        else {
            break;
        }
    }
    return n;
}

function settings() {
    switch (os.type()) {
        case ("Darwin"): {
            return { "newline": "\n", "user_directory": process.env.HOME + "/Library/Application Support/Code/User/" };
        }
        case ("Linux"): {
            return { "newline": "\n", "user_directory": process.env.HOME + "/.config/Code/User/" };
        }
        case ("Windows_NT"): {
            return { "newline": "\r\n", "user_directory": process.env.APPDATA + "\\Code\\User\\" };
        }
        default: {
            return { "newline": "\n", "user_directory": process.env.HOME + "/.config/Code/User/" };
        }
    }
}


interface ReplaceOperation {
    name: string;
    operations: {
        find: string;
        replace: string;
    }[];
}

let replaceOperations: ReplaceOperation[] = [];

// Load operations from storage
function loadReplaceOperations(context: vscode.ExtensionContext) {
    const savedOperations = context.globalState.get<ReplaceOperation[]>('snippetcreator.replaceOperations');
    if (savedOperations) {
        replaceOperations = savedOperations;
    }
}

// Save operations to storage
function saveReplaceOperations(context: vscode.ExtensionContext) {
    context.globalState.update('snippetcreator.replaceOperations', replaceOperations);
}


//###########################################################################################################
// Highlighting
//###########################################################################################################
// Add this to your extension.ts file

// Predefined vivid colors that work well in both light and dark themes
const highlightColors = [
    { light: '#FF4500AA', dark: '#FF6347AA' }, // Tomato/OrangeRed
    { light: '#32CD32AA', dark: '#7CFC00AA' }, // LimeGreen
    { light: '#1E90FFAA', dark: '#00BFFFAA' }, // DodgerBlue
    { light: '#FF69B4AA', dark: '#FF1493AA' }, // HotPink
    { light: '#FFD700AA', dark: '#FFAA00AA' }, // Gold/Orange
    { light: '#9370DBAA', dark: '#9932CCAA' }, // MediumPurple
    { light: '#00CED1AA', dark: '#40E0D0AA' }  // Turquoise
];

interface Highlightable {
    expression: string;
    decorator: vscode.TextEditorDecorationType;
}

class HighlightManager {
    private highlights: Highlightable[] = [];
    private decoratorTypes: vscode.TextEditorDecorationType[] = [];
    private currentColorIndex = 0;

    constructor() {
        // Create decorator types for each color
        this.createDecorators();
    }

    private createDecorators() {
        highlightColors.forEach(color => {
            const decorationType = vscode.window.createTextEditorDecorationType({
                borderWidth: '2px',
                borderStyle: 'solid',
                borderRadius: '3px',
                overviewRulerLane: vscode.OverviewRulerLane.Right,
                light: {
                    overviewRulerColor: color.light,
                    backgroundColor: color.light,
                    borderColor: color.light
                },
                dark: {
                    overviewRulerColor: color.dark,
                    backgroundColor: color.dark,
                    borderColor: color.dark
                }
            });
            this.decoratorTypes.push(decorationType);
        });
    }

    // Highlight the selected text
    public highlightSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        let text = editor.document.getText(editor.selection);
        if (!text) {
            const range = editor.document.getWordRangeAtPosition(editor.selection.active);
            if (range) {
                text = editor.document.getText(range);
            }
        }

        if (!text) {
            vscode.window.showInformationMessage('No word selected!');
            return;
        }

        // Escape special regex characters
        const escapedText = text.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");

        // Check if already highlighted
        const existingIndex = this.highlights.findIndex(h => h.expression === escapedText);
        if (existingIndex >= 0) {
            // Toggle off if already highlighted
            this.removeHighlight(existingIndex);
            return;
        }

        // Add new highlight
        const decorator = this.decoratorTypes[this.currentColorIndex];
        this.highlights.push({
            expression: escapedText,
            decorator: decorator
        });

        // Update color index for next highlight
        this.currentColorIndex = (this.currentColorIndex + 1) % this.decoratorTypes.length;

        this.updateDecorations();
    }

    // Remove a specific highlight
    private removeHighlight(index: number) {
        const highlight = this.highlights[index];
        this.highlights.splice(index, 1);
        this.updateDecorations();
    }

    // Remove a highlight by expression
    public removeHighlightByExpression(expression: string) {
        const index = this.highlights.findIndex(h => h.expression === expression);
        if (index >= 0) {
            this.removeHighlight(index);
        }
    }

    // Clear all highlights
    public clearAllHighlights() {
        this.highlights = [];
        this.updateDecorations();
    }

    // Show quick pick to remove a specific highlight
    public showRemoveHighlightPicker() {
        if (this.highlights.length === 0) {
            vscode.window.showInformationMessage('No active highlights to remove');
            return;
        }

        const items = this.highlights.map(h => h.expression);
        items.push('* Remove All *');

        vscode.window.showQuickPick(items, { placeHolder: 'Select highlight to remove' })
            .then(selected => {
                if (!selected) return;

                if (selected === '* Remove All *') {
                    this.clearAllHighlights();
                } else {
                    this.removeHighlightByExpression(selected);
                }
            });
    }

    // Update highlights in all visible editors
    public updateDecorations() {
        vscode.window.visibleTextEditors.forEach(editor => {
            const text = editor.document.getText();

            // Clear all decorations first
            this.highlights.forEach(highlight => {
                editor.setDecorations(highlight.decorator, []);
            });

            // Apply each highlight
            this.highlights.forEach(highlight => {
                const ranges: vscode.Range[] = [];
                const regex = new RegExp(highlight.expression, 'g');
                let match;

                while (match = regex.exec(text)) {
                    const startPos = editor.document.positionAt(match.index);
                    const endPos = editor.document.positionAt(match.index + match[0].length);
                    ranges.push(new vscode.Range(startPos, endPos));
                }

                editor.setDecorations(highlight.decorator, ranges);
            });
        });
    }

    // Dispose of all decorators
    public dispose() {
        this.decoratorTypes.forEach(decorator => {
            decorator.dispose();
        });
        this.decoratorTypes = [];
        this.highlights = [];
    }
}

// Main highlight initialization function to add to your activate function
export function initializeHighlighting(context: vscode.ExtensionContext) {
    const highlightManager = new HighlightManager();

    // Register highlight commands
    context.subscriptions.push(
        vscode.commands.registerCommand('snippetcreator.highlightSelection', () => {
            highlightManager.highlightSelection();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('snippetcreator.removeHighlight', () => {
            highlightManager.showRemoveHighlightPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('snippetcreator.clearAllHighlights', () => {
            highlightManager.clearAllHighlights();
        })
    );

    // Update decorations when editor changes or text changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            highlightManager.updateDecorations();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(() => {
            highlightManager.updateDecorations();
        })
    );

    // Update decorations when visibility changes
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(() => {
            highlightManager.updateDecorations();
        })
    );

    // Initial update for any open editors
    if (vscode.window.activeTextEditor) {
        highlightManager.updateDecorations();
    }
}
//###########################################################################################################
// End of Highlighting
//###########################################################################################################


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, snippetcreator is now active!');

    // Initialize highlighting functionality
    initializeHighlighting(context);

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.replaceWithTabStopSyntax', () => {
        let editor = vscode.window.activeTextEditor;

        if (!editor) {
            return;
        }

        // Get the counter to be used in current tab stop
        let counter = context.globalState.get("counter", 10);
        counter = counter + 10;
        context.globalState.update("counter", counter);

        // Get selected text
        let selection = editor.selection;
        let text = editor.document.getText(selection);

        // Replace selected text with tab stop syntax
        editor.edit(builder => {
            builder.replace(selection, '${' + counter + ':' + text + '}');
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.replaceWithTabStopChoiceSyntax', () => {
        let editor = vscode.window.activeTextEditor;

        if (!editor) {
            return;
        }

        let st = settings();
        let newline = st.newline;

        // Get the counter to be used in current tab stop
        let counter = context.globalState.get("counter", 10);
        counter = counter + 10;
        context.globalState.update("counter", counter);

        // Get selected text
        let selection = editor.selection;
        let text: any = editor.document.getText(selection);

        //${120|╔════════╗,║ header ║,╚════════╝,ite\,\,m 1,item\, 3|}

        if (/^\$\{\d+\|.+\|\}$/.test(text)) {
            // We are reversing a choice tabstop
            // Remove prefix and suffix
            text = text.replace(/^\$\{\d+\||\|\}$/g, "")

            const regex = /(?=.)([^,\\]*(?:\\.[^,\\]*)*)(?:,|$)/gm;
            let m, splited_text: any = [], splited_text2: any = [];

            while ((m = regex.exec(text)) !== null) {
                splited_text.push(m[1]);
            }

            for (let i = 0; i < splited_text.length; i++) {
                const e = splited_text[i];
                if (/^╔═*╗$/.test(e)) {
                    continue;
                }

                if (/^╚═*╝$/.test(e)) {
                    splited_text2.push("^^^");
                    continue;
                }

                const e2 = e.replace(/^║\s*|\s*║$/g, "");
                const e3 = e2.replace(/\\,/g, ",");
                splited_text2.push(e3);
            }

            editor.edit(builder => {
                builder.replace(selection, splited_text2.join(newline));
            });
        }
        else {
            // We are creating a choice tabstop
            // Support multi-line choices
            if (!selection.isSingleLine) {
                var i, j, len, r;

                text = (function () {
                    var j, len, ref, results;
                    ref = text.split(/\r?\n/);
                    results = [];
                    for (j = 0, len = ref.length; j < len; j++) {
                        r = ref[j];
                        results.push(r.replace(/,/g, "\\,"));
                    }
                    return results;
                })();

                for (i = j = 0, len = text.length; j < len; i = ++j) {
                    r = text[i];
                    if (/^\^{3,}$/.test(r)) {
                        text[i - 1] = "╔═" + "═".repeat(text[i - 1].length - occurrences(text[i - 1], ",", false)) + "═╗" + "," + "║ " + text[i - 1] + " ║" + "," + "╚═" + "═".repeat(text[i - 1].length - occurrences(text[i - 1], ",", false)) + "═╝";
                    }
                }

                text = text.filter(function (s: any) {
                    return !/^\^{3,}$/.test(s);
                });
                text = text.join(",");
            }

            // Replace selected text with choice tab stop syntax
            editor.edit(builder => {
                builder.replace(selection, '${' + counter + '|' + text + '|}');
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.resetTabStopCounter', () => {
        context.globalState.update("counter", 0);
        vscode.window.showInformationMessage("Tab stop counter reset to 10");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.escapeSpecialSnippetCharacters', () => {
        // With \ (backslash), you can escape $, } and \
        // Within choice elements, the backslash also escapes comma and pipe characters. ${1|one,two,three| }

        let editor = vscode.window.activeTextEditor!;

        if (!editor) {
            return;
        }

        // Get selected text
        let selection = editor.selection;
        let text = editor.document.getText(selection);
        let has_selection = true;
        let full_range: vscode.Range;
        let old_position_when_no_selection: vscode.Position;

        // If there is a selection, get the selected text
        // If there is no selection, get all document text
        if (text == null || text == "") {
            has_selection = false;
            text = editor.document.getText();
            old_position_when_no_selection = editor.selection.active;
            let invalid_range = new vscode.Range(0, 0, editor.document.lineCount /*intentionally missing the '-1' */, 0);
            full_range = editor.document.validateRange(invalid_range);
        }
        text = text.replace(/([\$\\\}])/g, "\\$1");

        // Replace selected text or full document text with tab stop syntax
        editor.edit(builder => {
            if (has_selection) {
                builder.replace(selection, text);
            } else {
                builder.replace(full_range, text);
            }
        }).then(success => {
            if (success && !has_selection) {
                // Deselect text and keep the cursor position
                vscode.window.activeTextEditor!.selection = new vscode.Selection(old_position_when_no_selection, old_position_when_no_selection);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.saveAsSnippet', () => {
        let editor = vscode.window.activeTextEditor;

        if (!editor) {
            return;
        }

        let text = editor.document.getText();
        let parse_result = parser.parse(text);

        // const text_range = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(text.length - 1));
        let snippet_name: any = parse_result[0];
        let snippet_scope: any = parse_result[1];
        let snippet_prefix: any = parse_result[2];
        let snippet_body: any = parse_result[3];

        let st = settings();
        let newline = st.newline;
        let user_directory = st.user_directory;

        let snippet_folder: any;
        let portable_data_path = process.env['VSCODE_PORTABLE'];
        if (portable_data_path && fs.existsSync(portable_data_path)) {
            // If in portable mode
            snippet_folder = path.join(portable_data_path, "user-data/User/snippets");
        }
        else {
            snippet_folder = path.join(user_directory, "snippets");
        }

        let snippet_object: { [k: string]: any } = {};
        snippet_object[snippet_name] = {};
        snippet_object[snippet_name]["scope"] = (snippet_scope || "");
        snippet_object[snippet_name]["prefix"] = snippet_prefix.split(/\s*,\s*/g); // Break into parts
        snippet_object[snippet_name]["body"] = [snippet_body];
        snippet_object[snippet_name]["description"] = snippet_name;

        let snippet_json_string = JSON.stringify(snippet_object, null, 4);

        text = snippet_json_string + newline + newline + "// " + text.replace(/\n/g, "\n// ");

        let snippet_file_name = "[" + snippet_prefix + " - " + snippet_name + "].code-snippets";
        if (snippet_scope && snippet_scope.trim().length > 0) {
            // We have potentially multiple scope for the snippet
            snippet_scope.split(/\s*,\s*/g).forEach(function (x: any) {
                writeToFile(snippet_folder, x + "." + snippet_file_name, text);
            });
        }
        else {
            // We don't have scope
            // snippet_file_name = snippet_scope + "." + snippet_file_name;
            writeToFile(snippet_folder, snippet_file_name, text);
        }
    }));


    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.alignByRegex', async () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        let input = await vscode.window.showInputBox({
            prompt: 'Enter regular expression(s)',
            placeHolder: 'e.g. :{]= (first align by : then by =)'
        });

        if (input !== undefined && input.length > 0) {
            let selection: vscode.Selection = editor.selection;
            if (!selection.isEmpty) {
                let textDocument = editor.document;

                // Don't select last line, if no character of line is selected.
                let endLine = selection.end.line;
                let endPosition = selection.end;
                if (endPosition.character === 0) {
                    endLine--;
                }

                let range = new vscode.Range(
                    new vscode.Position(selection.start.line, 0),
                    new vscode.Position(endLine, textDocument.lineAt(endLine).range.end.character)
                );

                // Split the input by {] or [} to get multiple regex patterns
                const regexes = input.split(/\{\]|\[\}/g);

                if (regexes.length > 1) {
                    // Multiple regex patterns detected

                    // Start with the original text
                    let currentText = textDocument.getText(range);
                    let startLine = selection.start.line;
                    let eol = textDocument.eol;

                    // Process each regex one by one
                    for (const regex of regexes) {
                        if (regex.trim() === '') continue;

                        // Create a block from the current text and align it
                        let block = new Block(currentText, regex, startLine, eol).trim().align();

                        // Generate the aligned text for the next iteration
                        let lines: string[] = [];
                        for (let line of block.lines) {
                            let replacement = '';
                            for (let part of line.parts) {
                                replacement += part.value;
                            }
                            lines.push(replacement);
                        }

                        // Update the current text for the next regex alignment
                        currentText = lines.join(eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
                    }

                    // Apply the final result
                    await editor.edit(e => {
                        e.replace(range, currentText);
                    });

                    vscode.window.showInformationMessage(`Applied ${regexes.length} alignment operations.`);
                } else {
                    // Single regex - use the original method
                    let text = textDocument.getText(range);
                    let block = new Block(text, input, selection.start.line, textDocument.eol).trim().align();

                    await editor.edit(e => {
                        for (let line of block.lines) {
                            let deleteRange = new vscode.Range(
                                new vscode.Position(line.number, 0),
                                new vscode.Position(line.number, textDocument.lineAt(line.number).range.end.character)
                            );

                            let replacement = '';
                            for (let part of line.parts) {
                                replacement += part.value;
                            }

                            e.replace(deleteRange, replacement);
                        }
                    });
                }
            } else {
                vscode.window.showInformationMessage("Please select multiple lines to align.");
            }
        }
    }));


    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.runReplaceOperation', async () => {
        // Load operations first
        loadReplaceOperations(context);

        if (replaceOperations.length === 0) {
            vscode.window.showInformationMessage("No replacement operations defined. Please create one first.");
            return;
        }

        // Show a quick pick of all operations
        const operationNames = replaceOperations.map(op => op.name);
        const selectedName = await vscode.window.showQuickPick(operationNames, {
            placeHolder: 'Select a replace operation to run'
        });

        if (!selectedName) return;

        // Find the selected operation
        const operation = replaceOperations.find(op => op.name === selectedName);
        if (!operation) return;

        // Get the active editor
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("No active editor");
            return;
        }

        // Determine range: selection if exists, otherwise full document
        let range: vscode.Range;
        const selection = editor.selection;

        if (!selection.isEmpty) {
            // Use selection
            range = selection;
        } else {
            // Use full document
            const document = editor.document;
            const fullText = document.getText();
            range = new vscode.Range(
                document.positionAt(0),
                document.positionAt(fullText.length)
            );
        }

        // Get text to process
        const document = editor.document;
        const textToProcess = document.getText(range);

        // Apply each operation in sequence
        let currentText = textToProcess;
        for (const op of operation.operations) {
            try {
                // Use regex replace
                const regex = new RegExp(op.find, 'gm');
                currentText = currentText.replace(regex, processReplacement(op.replace));
            } catch (error) {
                vscode.window.showErrorMessage(`Error in replacement operation: ${error}`);
                return;
            }
        }

        // Apply the final result
        await editor.edit(editBuilder => {
            editBuilder.replace(range, currentText);
        });

        vscode.window.showInformationMessage(`Applied "${selectedName}" with ${operation.operations.length} replacement steps`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.createReplaceOperation', async () => {
        // Load operations first
        loadReplaceOperations(context);

        // Ask for all parameters in one go
        const input = await vscode.window.showInputBox({
            prompt: 'Enter operation name{]find pattern{]replace pattern (use {] or [} as separators)',
            placeHolder: 'e.g., Fix PDF Bookmark{](\\s+)(\\d+)${]\\t$1{]^(\\d+)\\.(\\d+)\\.(\\d+){]\\t\\t$1.$2.$3'
        });

        if (!input) return;

        // Parse the input using {] or [} as separators
        const parts = input.split(/\{\]|\[\}/g);

        if (parts.length < 3 || parts.length % 2 !== 1) {
            vscode.window.showErrorMessage("Invalid format. Please use: name{]find1{]replace1{]find2{]replace2...");
            return;
        }

        const operationName = parts[0].trim();

        // Check if name already exists
        if (replaceOperations.some(op => op.name === operationName)) {
            const overwrite = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: `An operation named "${operationName}" already exists. Overwrite?`
            });

            if (overwrite !== 'Yes') return;

            // Remove the existing operation
            replaceOperations = replaceOperations.filter(op => op.name !== operationName);
        }

        // Create a new operation
        const newOperation: ReplaceOperation = {
            name: operationName,
            operations: []
        };

        // Add all find/replace pairs
        for (let i = 1; i < parts.length; i += 2) {
            if (i + 1 < parts.length) {
                newOperation.operations.push({
                    find: parts[i].trim(),
                    replace: parts[i + 1].trim()
                });
            }
        }

        // Save the operation
        replaceOperations.push(newOperation);
        saveReplaceOperations(context);

        vscode.window.showInformationMessage(
            `Created replacement operation "${operationName}" with ${newOperation.operations.length} steps`
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.editReplaceOperation', async () => {
        // Load operations first
        loadReplaceOperations(context);

        if (replaceOperations.length === 0) {
            vscode.window.showInformationMessage("No replacement operations defined. Please create one first.");
            return;
        }

        // Show a quick pick of all operations
        const operationNames = replaceOperations.map(op => op.name);
        const selectedName = await vscode.window.showQuickPick(operationNames, {
            placeHolder: 'Select a replace operation to edit'
        });

        if (!selectedName) return;

        // Find the selected operation
        const operationIndex = replaceOperations.findIndex(op => op.name === selectedName);
        if (operationIndex === -1) return;

        const operation = replaceOperations[operationIndex];

        // Create an input string from the current operation
        let inputString = operation.name;

        for (const op of operation.operations) {
            // Do NOT escape backslashes for editing - show the original pattern
            inputString += `{]${op.find}{]${op.replace}`;
        }

        // Show the input string for editing
        const editedInput = await vscode.window.showInputBox({
            prompt: 'Edit operation (use {] or [} as separators)',
            value: inputString
        });

        if (!editedInput) return;

        // Parse the edited input
        const parts = editedInput.split(/\{\]|\[\}/g);

        if (parts.length < 3 || parts.length % 2 !== 1) {
            vscode.window.showErrorMessage("Invalid format. Please use: name{]find1{]replace1{]find2{]replace2...");
            return;
        }

        const newOperationName = parts[0].trim();

        // Check if we're renaming to an existing name
        if (newOperationName !== operation.name &&
            replaceOperations.some(op => op.name === newOperationName)) {
            const overwrite = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: `An operation named "${newOperationName}" already exists. Overwrite?`
            });

            if (overwrite !== 'Yes') return;

            // Remove the existing operation with that name
            replaceOperations = replaceOperations.filter(op => op.name !== newOperationName);
        }

        // Update the operation
        operation.name = newOperationName;
        operation.operations = [];

        // Add all find/replace pairs
        for (let i = 1; i < parts.length; i += 2) {
            if (i + 1 < parts.length) {
                operation.operations.push({
                    find: parts[i].trim(),
                    replace: parts[i + 1].trim()
                });
            }
        }

        // Save the updated operations
        saveReplaceOperations(context);

        vscode.window.showInformationMessage(
            `Updated replacement operation "${newOperationName}" with ${operation.operations.length} steps`
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.listReplaceOperations', async () => {
        // Load operations first
        loadReplaceOperations(context);

        if (replaceOperations.length === 0) {
            vscode.window.showInformationMessage("No replacement operations defined.");
            return;
        }

        // Create a quick pick with details about each operation
        const details = replaceOperations.map(op => {
            return {
                label: op.name,
                detail: `${op.operations.length} replacement ${op.operations.length === 1 ? 'step' : 'steps'}`
            };
        });

        const selected = await vscode.window.showQuickPick(details, {
            placeHolder: 'Select an operation to view details',
        });

        if (!selected) return;

        // Show details for the selected operation
        const operation = replaceOperations.find(op => op.name === selected.label);
        if (!operation) return;

        const detailsPanel = vscode.window.createWebviewPanel(
            'replacementDetails',
            `Details: ${operation.name}`,
            vscode.ViewColumn.One,
            {}
        );

        let html = `
            <html>
                <head>
                    <style>
                        body {
                            font-family: var(--vscode-font-family);
                            padding: 20px;
                        }
                        h1 {
                            font-size: 18px;
                            margin-bottom: 20px;
                        }
                        table {
                            border-collapse: collapse;
                            width: 100%;
                        }
                        th, td {
                            text-align: left;
                            padding: 8px;
                            border: 1px solid var(--vscode-panel-border);
                        }
                        th {
                            background-color: var(--vscode-editor-selectionBackground);
                        }
                        pre {
                            background-color: var(--vscode-editor-background);
                            padding: 5px;
                            border-radius: 3px;
                            overflow-x: auto;
                        }
                    </style>
                </head>
                <body>
                    <h1>Replacement Operation: ${operation.name}</h1>
                    <p>Number of steps: ${operation.operations.length}</p>
                    <table>
                        <tr>
                            <th>#</th>
                            <th>Find Pattern (Regex)</th>
                            <th>Replace Pattern</th>
                        </tr>
        `;

        operation.operations.forEach((step, i) => {
            html += `
                <tr>
                    <td>${i+1}</td>
                    <td><pre>${escapeHtml(step.find)}</pre></td>
                    <td><pre>${escapeHtml(escapeForDisplay(step.replace))}</pre></td>
                </tr>
            `;
        });

        html += `
                    </table>
                </body>
            </html>
        `;

        detailsPanel.webview.html = html;
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.quickReplaceOperation', async () => {
        // Get the active editor
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("No active editor");
            return;
        }

        // Ask for all parameters in one go
        const input = await vscode.window.showInputBox({
            prompt: 'Enter find pattern{]replace pattern (use {] or [} as separators)',
            placeHolder: 'e.g., (\\s+)(\\d+)${]\\t$1'
        });

        if (!input) return;

        // Parse the input using {] or [} as separators
        const parts = input.split(/\{\]|\[\}/g);

        if (parts.length < 2) {
            vscode.window.showErrorMessage("Invalid format. Please use: find{]replace");
            return;
        }

        // Determine range: selection if exists, otherwise full document
        let range: vscode.Range;
        const selection = editor.selection;

        if (!selection.isEmpty) {
            // Use selection
            range = selection;
        } else {
            // Use full document
            const document = editor.document;
            const fullText = document.getText();
            range = new vscode.Range(
                document.positionAt(0),
                document.positionAt(fullText.length)
            );
        }

        // Get text to process
        const document = editor.document;
        const textToProcess = document.getText(range);

        // Apply each find/replace pair in sequence
        let currentText = textToProcess;

        for (let i = 0; i < parts.length - 1; i += 2) {
            try {
                const find = parts[i].trim();
                const replace = parts[i + 1].trim();

                // Use regex replace
                const regex = new RegExp(find, 'gm');
                currentText = currentText.replace(regex, processReplacement(replace));
            } catch (error) {
                vscode.window.showErrorMessage(`Error in replacement: ${error}`);
                return;
            }
        }

        // Apply the final result
        await editor.edit(editBuilder => {
            editBuilder.replace(range, currentText);
        });

        const stepsCount = Math.floor(parts.length / 2);
        vscode.window.showInformationMessage(`Applied ${stepsCount} replacement ${stepsCount === 1 ? 'step' : 'steps'}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.deleteReplaceOperation', async () => {
        // Load operations first
        loadReplaceOperations(context);

        if (replaceOperations.length === 0) {
            vscode.window.showInformationMessage("No replacement operations defined.");
            return;
        }

        // Show a quick pick of all operations
        const operationNames = replaceOperations.map(op => op.name);
        const selectedName = await vscode.window.showQuickPick(operationNames, {
            placeHolder: 'Select a replace operation to delete'
        });

        if (!selectedName) return;

        // Confirm deletion
        const confirmDelete = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: `Delete operation "${selectedName}"?`
        });

        if (confirmDelete !== 'Yes') return;

        // Delete the operation
        replaceOperations = replaceOperations.filter(op => op.name !== selectedName);
        saveReplaceOperations(context);

        vscode.window.showInformationMessage(`Deleted operation "${selectedName}"`);
    }));

    // Export operations to a file
    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.exportReplaceOperations', async () => {
        loadReplaceOperations(context);

        if (replaceOperations.length === 0) {
            vscode.window.showInformationMessage("No replacement operations to export.");
            return;
        }

        // Ask user where to save the file
        const uri = await vscode.window.showSaveDialog({
            filters: {
                'JSON': ['json']
            },
            title: 'Export Replace Operations',
            defaultUri: vscode.Uri.file('replaceOperations.json')
        });

        if (!uri) return;

        try {
            // Convert to JSON and write to file
            const jsonData = JSON.stringify(replaceOperations, null, 2);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(jsonData, 'utf8'));
            vscode.window.showInformationMessage(`Successfully exported ${replaceOperations.length} operations.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export operations: ${error}`);
        }
    }));

    // Import operations from a file
    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.importReplaceOperations', async () => {
        // Ask user to select the file
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
                'JSON': ['json']
            },
            title: 'Import Replace Operations'
        });

        if (!uris || uris.length === 0) return;

        try {
            // Read file content
            const fileContent = await vscode.workspace.fs.readFile(uris[0]);
            const importedOperations = JSON.parse(fileContent.toString());

            // Validate the imported data
            if (!Array.isArray(importedOperations)) {
                throw new Error('Invalid format: expected an array of operations');
            }

            // Load current operations first
            loadReplaceOperations(context);

            // Ask how to handle the import
            const choice = await vscode.window.showQuickPick(
                ['Merge (keep existing operations)', 'Replace (overwrite all existing operations)'],
                { placeHolder: 'How do you want to import the operations?' }
            );

            if (!choice) return;

            if (choice.startsWith('Merge')) {
                // For merge, we need to avoid duplicates (by name)
                const existingNames = new Set(replaceOperations.map(op => op.name));
                const newOperations = importedOperations.filter(op => !existingNames.has(op.name));
                replaceOperations = [...replaceOperations, ...newOperations];
            } else {
                // For replace, just use the imported operations
                replaceOperations = importedOperations;
            }

            // Save the updated operations
            saveReplaceOperations(context);
            vscode.window.showInformationMessage(`Successfully imported operations. Total: ${replaceOperations.length}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to import operations: ${error}`);
        }
    }));


    // Register the regex selection command
    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.selectByRegex', async () => {
        // Get the active text editor
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }

        // Ask the user for the regex pattern
        const regexPattern = await vscode.window.showInputBox({
            placeHolder: 'Enter regex pattern',
            prompt: 'Enter a regular expression to select all matching text'
        });

        // Exit if user canceled or entered empty string
        if (!regexPattern) {
            return;
        }

        try {
            // Create the regex from the user input
            const regex = new RegExp(regexPattern, 'g');

            // Get the document text
            const document = editor.document;
            const text = document.getText();

            // Find all matches
            const selections: vscode.Selection[] = [];
            let match;

            while ((match = regex.exec(text)) !== null) {
                // Get the position of the match
                const startPos = document.positionAt(match.index);
                const endPos = document.positionAt(match.index + match[0].length);

                // Create a selection for this match
                selections.push(new vscode.Selection(startPos, endPos));
            }

            // Apply all the selections
            if (selections.length > 0) {
                editor.selections = selections;
                // Reveal the first selection
                editor.revealRange(new vscode.Range(selections[0].start, selections[0].end));
            } else {
                vscode.window.showInformationMessage('No matches found for the regex pattern');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));
}

function writeToFile(folder: any, filename: any, content: any) {
    // Remove invalid file name characters
    filename = filename.replace(/[/\\?%*:|"<>]/g, "").replace(/\s{2,}/g, " ");
    var writeStream = fs.createWriteStream(path.join(folder, filename));
    writeStream.write(content);
    writeStream.end();
    vscode.window.showInformationMessage(filename + " created!");
}

// this method is called when your extension is deactivated
export function deactivate() { }
