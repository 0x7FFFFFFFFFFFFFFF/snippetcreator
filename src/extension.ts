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

// Helper function to process numbers in text based on the provided operation
function processNumberOperation(text: string, operation: string): string {
    // Simple operations like +5, -10, *2, /3
    const simpleOpRegex = /^([+\-*/])(\d*\.?\d+)$/;
    const simpleMatch = operation.match(simpleOpRegex);

    // Check for decimal precision specifier at the end (//n)
    const hasPrecisionSpecifier = operation.match(/\/\/(\d+)$/);
    const precision = hasPrecisionSpecifier ? parseInt(hasPrecisionSpecifier[1], 10) : null;

    // Remove precision specifier for processing
    let operationWithoutPrecision = operation;
    if (hasPrecisionSpecifier) {
        operationWithoutPrecision = operation.replace(/\/\/\d+$/, '');
    }

    // Find all numbers in the text
    const numberRegex = /-?\d+(\.\d+)?/g;

    // If the entire text is a number, process it
    if (text.trim().match(/^-?\d+(\.\d+)?$/)) {
        const num = parseFloat(text);
        let result: number;

        if (simpleMatch) {
            // Handle simple operations
            const operator = simpleMatch[1];
            const operand = parseFloat(simpleMatch[2]);

            switch (operator) {
                case '+': result = num + operand; break;
                case '-': result = num - operand; break;
                case '*': result = num * operand; break;
                case '/': result = num / operand; break;
                default: throw new Error('Unknown operator');
            }
        } else {
            // Handle complex expressions
            // Replace $ with the actual number
            const expr = operationWithoutPrecision.replace(/\$/g, num.toString());

            try {
                // Use Function constructor to evaluate the expression safely
                result = Function(`'use strict'; return (${expr})`)();

                if (typeof result !== 'number' || !isFinite(result)) {
                    throw new Error('Expression did not evaluate to a valid number');
                }
            } catch (error: unknown) {
                // Fix: Properly handle the unknown type error
                const errorMessage = error instanceof Error ? error.message : String(error);
                throw new Error(`Invalid expression: ${errorMessage}`);
            }
        }

        // Format the result based on precision
        if (precision !== null) {
            return result.toFixed(precision);
        }

        // Return the result as a string
        return result.toString();
    } else {
        // The text contains other characters besides numbers
        return text.replace(numberRegex, (match) => {
            const num = parseFloat(match);
            let result: number;

            if (simpleMatch) {
                // Handle simple operations
                const operator = simpleMatch[1];
                const operand = parseFloat(simpleMatch[2]);

                switch (operator) {
                    case '+': result = num + operand; break;
                    case '-': result = num - operand; break;
                    case '*': result = num * operand; break;
                    case '/': result = num / operand; break;
                    default: throw new Error('Unknown operator');
                }
            } else {
                // Handle complex expressions
                // Replace $ with the actual number
                const expr = operationWithoutPrecision.replace(/\$/g, num.toString());

                try {
                    // Use Function constructor to evaluate the expression safely
                    result = Function(`'use strict'; return (${expr})`)();

                    if (typeof result !== 'number' || !isFinite(result)) {
                        throw new Error('Expression did not evaluate to a valid number');
                    }
                } catch (error: unknown) {
                    // Fix: Properly handle the unknown type error
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`Invalid expression: ${errorMessage}`);
                }
            }

            // Format the result based on precision
            if (precision !== null) {
                return result.toFixed(precision);
            }

            // Return the result as a string
            return result.toString();
        });
    }
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



    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.listReplaceOperations', async () => {
        loadReplaceOperations(context);

        // Enable scripts so the webview can post messages back
        const panel = vscode.window.createWebviewPanel(
            'replacementOperations',
            'Replace Operations Management',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const opsJson = JSON.stringify(replaceOperations);

        panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Replace Operations Management</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px;
  }
  h2 { font-size: 1.1em; font-weight: 600; margin-bottom: 10px; }
  h3 { font-size: 0.95em; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground); }
  .new-op-block {
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 4px;
    margin-bottom: 14px;
    overflow: hidden;
  }
  code {
    padding: 0 0.3rem;
  }
  .new-op-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--vscode-editor-selectionHighlightBackground, var(--vscode-editor-selectionBackground));
    border-bottom: 1px solid var(--vscode-focusBorder);
  }
  .new-op-header label { font-size: 0.85em; font-weight: 600; white-space: nowrap; color: var(--vscode-disabledForeground); }
  .new-op-name {
    flex: 1;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    color: var(--vscode-input-foreground);
    font-size: 1em;
    padding: 3px 6px;
    border-radius: 3px;
  }
  .new-op-name:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .op-block {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin-bottom: 10px;
    overflow: hidden;
  }
  .op-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: var(--vscode-editor-selectionBackground);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .op-name {
    flex: 1;
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    font-weight: 600;
    font-size: 1em;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .op-name:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-input-background);
  }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left;
    padding: 3px 6px;
    font-size: 0.8em;
    font-weight: 600;
    color: var(--vscode-disabledForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  tbody td { padding: 3px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  tbody tr:last-child td { border-bottom: none; }
  .cell-num { width: 30px; text-align: center; color: var(--vscode-disabledForeground); font-size: 0.85em; }
  .cell-inp { width: calc(50% - 40px); }
  .cell-act { width: 50px; text-align: right; }
  input.val {
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    padding: 2px 4px;
    border-radius: 3px;
  }
  input.val:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-input-background);
  }
  button {
    cursor: pointer;
    border: none;
    border-radius: 3px;
    padding: 2px 7px;
    font-size: 0.82em;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { filter: brightness(1.15); }
  button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 3px 10px;
  }
  .op-footer {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-panel-border);
  }
  .new-op-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-focusBorder);
  }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .save-bar {
    position: sticky;
    bottom: 0;
    background: var(--vscode-editor-background);
    padding: 8px 0 2px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .status { font-size: 0.85em; color: var(--vscode-disabledForeground); }
  .err { font-size: 0.85em; color: var(--vscode-errorForeground); margin-left: 8px; }
  .section-label {
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--vscode-disabledForeground);
    margin: 14px 0 6px;
  }
</style>
</head>
<body>
<h2>Replace Operations Management</h2>

<!-- New Operation Form -->
<div class="new-op-block">
  <div class="new-op-header">
    <label for="newOpName">New Operation:</label>
    <input id="newOpName" class="new-op-name" placeholder="Operation name" />
  </div>
  <table id="newOpTable">
    <thead><tr>
      <th class="cell-num">#</th>
      <th class="cell-inp">Find (regex)</th>
      <th class="cell-inp">Replace</th>
      <th class="cell-act"></th>
    </tr></thead>
    <tbody id="newOpRows"></tbody>
  </table>
  <div class="new-op-footer">
    <button onclick="addNewRow()">+ Add step</button>
    <div style="display:flex;align-items:center;gap:6px">
      <span class="err" id="newErr"></span>
      <button class="primary" onclick="addOperation()">Add Operation</button>
    </div>
  </div>
</div>

<div class="section-label">Existing Operations</div>
<div id="ops"></div>
<div class="save-bar">
  <button class="primary" onclick="save()">Save All</button>
  <button onclick="exportOps()">Export JSON…</button>
  <button onclick="importOps()">Import JSON…</button>
  <span class="status" id="status"></span>
</div>
<script>
  const vscode = acquireVsCodeApi();
  let ops = ${opsJson};

  // ── New-operation form state ──────────────────────────────────────────
  let newSteps = [{ find: '', replace: '' }];

  function renderNewRows() {
    const tbody = document.getElementById('newOpRows');
    tbody.innerHTML = newSteps.map((s, i) => \`
      <tr>
        <td class="cell-num">\${i+1}</td>
        <td class="cell-inp"><input class="val" id="nf\${i}" value="\${escHtml(s.find)}"
          oninput="newSteps[\${i}].find=this.value" placeholder="find…"></td>
        <td class="cell-inp"><input class="val" id="nr\${i}" value="\${escHtml(s.replace)}"
          oninput="newSteps[\${i}].replace=this.value" placeholder="replace…"></td>
        <td class="cell-act"><button class="danger" onclick="deleteNewRow(\${i})" title="Remove row">x</button></td>
      </tr>\`).join('');
  }

  function addNewRow() {
    newSteps.push({ find: '', replace: '' });
    renderNewRows();
    document.getElementById('nf' + (newSteps.length-1)).focus();
  }

  function deleteNewRow(i) {
    if (newSteps.length === 1) { newSteps[0] = { find: '', replace: '' }; }
    else { newSteps.splice(i, 1); }
    renderNewRows();
  }

  function addOperation() {
    const nameEl = document.getElementById('newOpName');
    const errEl = document.getElementById('newErr');
    const name = nameEl.value.trim();
    if (!name) { errEl.textContent = 'Name is required.'; nameEl.focus(); return; }
    if (ops.some(o => o.name === name)) { errEl.textContent = 'Name already exists.'; nameEl.focus(); return; }
    const validSteps = newSteps.filter(s => s.find.trim() !== '');
    if (validSteps.length === 0) {
      errEl.textContent = 'At least one Find pattern is required.';
      document.getElementById('nf0').focus();
      return;
    }
    errEl.textContent = '';
    ops.push({ name, operations: validSteps.map(s => ({ find: s.find, replace: s.replace })) });
    // reset form
    nameEl.value = '';
    newSteps = [{ find: '', replace: '' }];
    renderNewRows();
    render();
    // auto-save
    vscode.postMessage({ command: 'save', ops });
    setStatus('Operation added and saved.');
  }

  // ── Existing operations ───────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function render() {
    const container = document.getElementById('ops');
    if (ops.length === 0) {
      container.innerHTML = '<p style="color:var(--vscode-disabledForeground);margin:8px 0">No operations defined yet.</p>';
      return;
    }
    container.innerHTML = ops.map((op, oi) => \`
      <div class="op-block">
        <div class="op-header">
          <input class="op-name" data-op="\${oi}" data-field="name" value="\${escHtml(op.name)}" oninput="update(this)" title="Operation name">
          <button class="danger" onclick="deleteOp(\${oi})" title="Delete operation">Delete</button>
        </div>
        <table>
          <thead><tr>
            <th class="cell-num">#</th>
            <th class="cell-inp">Find (regex)</th>
            <th class="cell-inp">Replace</th>
            <th class="cell-act"></th>
          </tr></thead>
          <tbody>\${op.operations.map((step, si) => \`
            <tr>
              <td class="cell-num">\${si+1}</td>
              <td class="cell-inp"><input class="val" data-op="\${oi}" data-step="\${si}" data-field="find" value="\${escHtml(step.find)}" oninput="update(this)"></td>
              <td class="cell-inp"><input class="val" data-op="\${oi}" data-step="\${si}" data-field="replace" value="\${escHtml(step.replace)}" oninput="update(this)"></td>
              <td class="cell-act"><button class="danger" onclick="deleteRow(\${oi},\${si})" title="Delete row">x</button></td>
            </tr>\`).join('')}
          </tbody>
        </table>
        <div class="op-footer">
          <button onclick="addRow(\${oi})">+ Add step</button>
        </div>
      </div>\`).join('');
  }

  function update(el) {
    const oi = +el.dataset.op;
    const field = el.dataset.field;
    if (field === 'name') {
      ops[oi].name = el.value;
    } else {
      const si = +el.dataset.step;
      ops[oi].operations[si][field] = el.value;
    }
  }

  function deleteRow(oi, si) {
    ops[oi].operations.splice(si, 1);
    render();
  }

  function deleteOp(oi) {
    ops.splice(oi, 1);
    render();
  }

  function addRow(oi) {
    ops[oi].operations.push({ find: '', replace: '' });
    render();
    // focus the new find input
    const tbody = document.querySelectorAll('.op-block')[oi].querySelector('tbody');
    const lastRow = tbody.lastElementChild;
    if (lastRow) lastRow.querySelector('input').focus();
  }

  function setStatus(msg) {
    const el = document.getElementById('status');
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; }, 2500);
  }

  function save() {
    // collect current input values (render may not have synced all)
    document.querySelectorAll('input[data-field]').forEach(el => update(el));
    vscode.postMessage({ command: 'save', ops });
    setStatus('Saved.');
  }

  function exportOps() {
    document.querySelectorAll('input[data-field]').forEach(el => update(el));
    vscode.postMessage({ command: 'export', ops });
  }

  function importOps() {
    vscode.postMessage({ command: 'import' });
  }

  // listen for replies from the extension host
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'imported') {
      ops = msg.ops;
      render();
      setStatus(\`Imported. Total: \${ops.length} operations.\`);
    } else if (msg.command === 'importError') {
      setStatus('Import failed: ' + msg.error);
    } else if (msg.command === 'exportDone') {
      setStatus('Exported successfully.');
    } else if (msg.command === 'exportError') {
      setStatus('Export failed: ' + msg.error);
    }
  });

  // init
  renderNewRows();
  render();
</script>

<!-- Regex Help -->
<div style="margin-top:20px;border-top:1px solid var(--vscode-panel-border);padding-top:12px;">
  <div class="section-label" style="margin-top:0">Regex Reference</div>
  <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:0.85em;">
    <thead>
      <tr>
        <th style="text-align:left;padding:3px 8px;color:var(--vscode-disabledForeground);border-bottom:1px solid var(--vscode-panel-border);width:50%">Find field (regex)</th>
        <th style="text-align:left;padding:3px 8px;color:var(--vscode-disabledForeground);border-bottom:1px solid var(--vscode-panel-border);width:50%">Replace field</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top;color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family,monospace)">
          <code>(\\w+)</code> — capture group<br>
          <code>\\1</code>, <code>\\2</code> — backreference to group 1, 2<br>
          <code>(?:…)</code> — non-capturing group<br>
          <code>(?i)</code> — case-insensitive flag<br>
          <code>^</code>, <code>$</code> — line start / end (multiline on)<br>
          <code>\\d</code> <code>\\w</code> <code>\\s</code> — digit, word, space
        </td>
        <td style="padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top;color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family,monospace)">
          <code>$1</code>, <code>$2</code> — capture group 1, 2<br>
          <code>$&</code> — the entire matched text<br>
          <code>$\`</code> — text before match<br>
          <code>$'</code> — text after match<br>
          <code>\\n</code>, <code>\\t</code> — newline, tab<br>
          <code>\\</code> — literal backslash
        </td>
      </tr>
    </tbody>
  </table>
</div>

</body>
</html>`;

        panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'save') {
                replaceOperations = msg.ops;
                saveReplaceOperations(context);
            } else if (msg.command === 'export') {
                // Export: show save dialog then write the file
                const ops: ReplaceOperation[] = msg.ops;
                if (ops.length === 0) {
                    panel.webview.postMessage({ command: 'exportError', error: 'No operations to export.' });
                    return;
                }
                const uri = await vscode.window.showSaveDialog({
                    filters: { 'JSON': ['json'] },
                    title: 'Export Replace Operations',
                    defaultUri: vscode.Uri.file('replaceOperations.json')
                });
                if (!uri) return;
                try {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(ops, null, 2), 'utf8'));
                    panel.webview.postMessage({ command: 'exportDone' });
                } catch (error) {
                    panel.webview.postMessage({ command: 'exportError', error: String(error) });
                }
            } else if (msg.command === 'import') {
                // Import: show open dialog, read file, ask merge/replace, send result back
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'JSON': ['json'] },
                    title: 'Import Replace Operations'
                });
                if (!uris || uris.length === 0) return;
                try {
                    const fileContent = await vscode.workspace.fs.readFile(uris[0]);
                    const importedOps: ReplaceOperation[] = JSON.parse(fileContent.toString());
                    if (!Array.isArray(importedOps)) throw new Error('Invalid format: expected an array');

                    loadReplaceOperations(context);
                    const choice = await vscode.window.showQuickPick(
                        ['Merge (keep existing)', 'Replace (overwrite all)'],
                        { placeHolder: 'How do you want to import?' }
                    );
                    if (!choice) return;

                    if (choice.startsWith('Merge')) {
                        const existingNames = new Set(replaceOperations.map(op => op.name));
                        const newOps = importedOps.filter(op => !existingNames.has(op.name));
                        replaceOperations = [...replaceOperations, ...newOps];
                    } else {
                        replaceOperations = importedOps;
                    }
                    saveReplaceOperations(context);
                    panel.webview.postMessage({ command: 'imported', ops: replaceOperations });
                } catch (error) {
                    panel.webview.postMessage({ command: 'importError', error: String(error) });
                }
            }
        }, undefined, context.subscriptions);
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
        let regexPattern = await vscode.window.showInputBox({
            placeHolder: 'Enter regex pattern',
            prompt: 'Enter a regular expression to select all matching text'
        });

        // Exit if user canceled or entered empty string
        if (!regexPattern) {
            return;
        }

        try {
            // Extract flags if the pattern starts with (?flags)
            let flags = 'g'; // Always include 'g' flag for global matching
            const flagsMatch = regexPattern.match(/^\(\?([dgimsuvy]+)\)(.*)/);

            if (flagsMatch) {
                // Get unique flags (removing duplicates)
                const uniqueFlags = [...new Set(flagsMatch[1])].join('');
                // Make sure 'g' is included
                flags = uniqueFlags.includes('g') ? uniqueFlags : uniqueFlags + 'g';
                // Update the pattern without the flags part
                regexPattern = flagsMatch[2];
            }

            // Create the regex from the user input with extracted flags
            const regex = new RegExp(regexPattern, flags);

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

    // Register the number sequence replacement command
    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.replaceWithNumberSequence', async () => {
        // Get the active text editor
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }

        // Check if there are multiple selections
        if (editor.selections.length <= 1) {
            vscode.window.showInformationMessage('This command requires multiple selections.');
            return;
        }

        // Ask for start number and step
        const sequenceInput = await vscode.window.showInputBox({
            placeHolder: '1',
            prompt: 'Enter start number and step (e.g., "1", "01", "001", or "5 2" for start=5,step=2)'
        });

        // Exit if user canceled
        if (sequenceInput === undefined) {
            return;
        }

        try {
            // Parse input
            const parts = sequenceInput.trim() === '' ? ['1'] : sequenceInput.split(/\s+/);
            const startValueStr = parts[0] || '1';
            const step = parts.length > 1 ? parseInt(parts[1], 10) : 1;

            // Parse the start number and determine format
            const startNumber = parseInt(startValueStr, 10);

            if (isNaN(startNumber) || isNaN(step)) {
                throw new Error('Invalid number format');
            }

            // Determine if zero-padding is needed and how many digits
            const hasPadding = startValueStr.match(/^0+\d/);
            const totalWidth = hasPadding ? startValueStr.length : 0;

            // Sort selections by position to ensure consistent numbering regardless of selection order
            const sortedSelections = [...editor.selections].sort((a, b) => {
                if (a.start.line !== b.start.line) {
                    return a.start.line - b.start.line;
                }
                return a.start.character - b.start.character;
            });

            // Replace each selection with the appropriate number in the sequence
            await editor.edit(editBuilder => {
                sortedSelections.forEach((selection, index) => {
                    const number = startNumber + (index * step);

                    // Format the number with appropriate padding if needed
                    let formattedNumber;
                    if (hasPadding) {
                        formattedNumber = number.toString().padStart(totalWidth, '0');
                    } else {
                        formattedNumber = number.toString();
                    }

                    editBuilder.replace(selection, formattedNumber);
                });
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));

    // Register the number operation command
    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.operateOnNumbers', async () => {
        // Get the active text editor
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }

        // Check if there are selections
        if (editor.selections.length < 1) {
            vscode.window.showInformationMessage('This command requires at least one selection.');
            return;
        }

        // Ask for the operation to perform
        const operation = await vscode.window.showInputBox({
            placeHolder: '+1, *2, /3, ($ + 10) / 2, ($ * 2.5)//3',
            prompt: 'Enter operation to perform on numbers (use $ to reference the number)'
        });

        // Exit if user canceled
        if (operation === undefined) {
            return;
        }

        try {
            // Wait for edit to complete
            await editor.edit(editBuilder => {
                // Process each selection
                for (const selection of editor.selections) {
                    // Get the selected text
                    const selectionText = editor.document.getText(selection);

                    // Find numbers in the selection
                    const result = processNumberOperation(selectionText, operation);

                    // Replace the selection with the result
                    editBuilder.replace(selection, result);
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));

    // Register the line selection/manipulation command
    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.lineOperation', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }

        const document = editor.document;
        const selections = editor.selections;

        if (selections.length === 1 && selections[0].isEmpty) {
            // Case 1: No selection and only one cursor - select the whole line
            const lineNumber = selections[0].active.line;
            const line = document.lineAt(lineNumber);
            const newSelection = new vscode.Selection(
                new vscode.Position(lineNumber, 0),
                new vscode.Position(lineNumber, line.text.length)
            );
            editor.selection = newSelection;
        } else if (selections.length === 1 && !selections[0].isEmpty &&
            selections[0].start.line !== selections[0].end.line) {
            // Case 2: Multiline selection - create cursors at the end of each line
            const startLine = selections[0].start.line;
            const endLine = selections[0].end.line;
            const newSelections: vscode.Selection[] = [];

            for (let i = startLine; i <= endLine; i++) {
                const line = document.lineAt(i);
                const position = new vscode.Position(i, line.text.length);
                newSelections.push(new vscode.Selection(position, position));
            }

            editor.selections = newSelections;
        } else {
            // Case 3: Multiple cursors already - move them to end of line
            const newSelections: vscode.Selection[] = [];

            for (const selection of selections) {
                const lineNumber = selection.active.line;
                const line = document.lineAt(lineNumber);
                const position = new vscode.Position(lineNumber, line.text.length);
                newSelections.push(new vscode.Selection(position, position));
            }

            editor.selections = newSelections;
        }
    }));

    // ── Bracket / Quote Select (Ctrl+Q) ──────────────────────────────────────
    // State per editor URI
    interface BracketSelectState {
        // The *original* selections recorded on the very first press
        originalSelections: readonly vscode.Selection[];
        // Data per cursor that found a valid bracket pair
        cursorsData: {
            openOff: number;
            closeOff: number;
            origIndex: number;
            // The sequence of 6 indices to cycle through.
            // [0] is origIndex. [1]..[5] are the other indices in order 0..5.
            cycleIndices: number[];
        }[];
        // Which step in the cycle are we on? (0 to 7)
        // 0=select, 1-5=replace with bracket types, 6=remove brackets, 7=restore
        step: number;
        // True when the brackets have been physically deleted from the document
        bracketsRemoved: boolean;
        // The selections we last applied — used to detect if user moved away
        lastAppliedSelections: { anchor: number; active: number }[];
    }

    const OPEN_CHARS = ['"', "'", '(', '[', '{', '<'];
    const CLOSE_CHARS = ['"', "'", ')', ']', '}', '>'];

    const bracketSelectStates = new Map<string, BracketSelectState>();

    function scanNaturalPair(
        text: string,
        cursorOffset: number
    ): { openOff: number; closeOff: number; origIndex: number } | null {
        let openOff = -1;
        let origIndex = -1;
        // Find nearest open char of any type to the left of cursor
        for (let i = cursorOffset - 1; i >= 0; i--) {
            const idx = OPEN_CHARS.indexOf(text[i]);
            if (idx !== -1) {
                openOff = i;
                origIndex = idx;
                break;
            }
        }
        if (openOff === -1) return null;

        const closeChar = CLOSE_CHARS[origIndex];
        let closeOff = -1;
        // Find nearest matching close char to the right of cursor
        for (let i = cursorOffset; i < text.length; i++) {
            if (text[i] === closeChar) {
                closeOff = i;
                break;
            }
        }
        if (closeOff === -1) return null;

        return { openOff, closeOff, origIndex };
    }

    function selectionsMatch(
        editor: vscode.TextEditor,
        stored: { anchor: number; active: number }[]
    ): boolean {
        const doc = editor.document;
        const current = editor.selections;
        if (current.length !== stored.length) return false;
        return stored.every((s, i) =>
            doc.offsetAt(current[i].anchor) === s.anchor &&
            doc.offsetAt(current[i].active) === s.active
        );
    }

    context.subscriptions.push(vscode.commands.registerCommand('snippetcreator.bracketSelect', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const doc = editor.document;
        const text = doc.getText();
        const editorId = doc.uri.toString();

        const currentSelections = editor.selections;

        let state = bracketSelectStates.get(editorId);

        // ── Detect if we're continuing a cycle or starting fresh ─────────────
        const isContinuing = state !== undefined &&
            selectionsMatch(editor, state.lastAppliedSelections);

        if (!isContinuing) {
            // ── Fresh start ───────────────────────────────────────────────────
            const cursorsData: BracketSelectState['cursorsData'] = [];

            for (const sel of currentSelections) {
                const cursorOffset = doc.offsetAt(sel.start);
                const pair = scanNaturalPair(text, cursorOffset);
                if (pair) {
                    const cycleIndices = [pair.origIndex];
                    for (let i = 0; i < OPEN_CHARS.length; i++) {
                        if (i !== pair.origIndex) cycleIndices.push(i);
                    }
                    cursorsData.push({
                        openOff: pair.openOff,
                        closeOff: pair.closeOff,
                        origIndex: pair.origIndex,
                        cycleIndices
                    });
                }
            }

            if (cursorsData.length === 0) return; // Nothing to target

            state = {
                originalSelections: currentSelections,
                cursorsData,
                step: 0,
                bracketsRemoved: false,
                lastAppliedSelections: []
            };
            bracketSelectStates.set(editorId, state);
        }

        if (!state) return;

        // ── Main state machine ────────────────────────────────────────────────

        if (state.step === 0) {
            // Step 0: Just select text inside the original brackets
            const newSelections = state.cursorsData.map(c =>
                new vscode.Selection(doc.positionAt(c.openOff + 1), doc.positionAt(c.closeOff))
            );
            editor.selections = newSelections;
            state.lastAppliedSelections = newSelections.map(s => ({
                anchor: doc.offsetAt(s.anchor),
                active: doc.offsetAt(s.active)
            }));
            state.step = 1;
        }
        else if (state.step >= 1 && state.step <= 5) {
            // Step 1-5: Apply next bracket type.
            // If brackets were removed, we INSERT them; otherwise REPLACE the existing ones.
            const stepIndex = state.step;
            const wasRemoved = state.bracketsRemoved;
            editor.edit(editBuilder => {
                for (const c of state!.cursorsData) {
                    const bracketIdx = c.cycleIndices[stepIndex];
                    if (wasRemoved) {
                        // Brackets were deleted: insert at content boundaries.
                        // Content is at [openOff, closeOff-1) in the current document.
                        editBuilder.insert(doc.positionAt(c.openOff), OPEN_CHARS[bracketIdx]);
                        editBuilder.insert(doc.positionAt(c.closeOff - 1), CLOSE_CHARS[bracketIdx]);
                    } else {
                        editBuilder.replace(
                            new vscode.Range(doc.positionAt(c.openOff), doc.positionAt(c.openOff + 1)),
                            OPEN_CHARS[bracketIdx]
                        );
                        editBuilder.replace(
                            new vscode.Range(doc.positionAt(c.closeOff), doc.positionAt(c.closeOff + 1)),
                            CLOSE_CHARS[bracketIdx]
                        );
                    }
                }
            }).then(success => {
                if (success) {
                    // After insert/replace, openOff and closeOff are canonical again
                    if (state!.bracketsRemoved) {
                        state!.bracketsRemoved = false;
                    }
                    const newSelections = state!.cursorsData.map(c =>
                        new vscode.Selection(doc.positionAt(c.openOff + 1), doc.positionAt(c.closeOff))
                    );
                    editor.selections = newSelections;
                    state!.lastAppliedSelections = newSelections.map(s => ({
                        anchor: doc.offsetAt(s.anchor),
                        active: doc.offsetAt(s.active)
                    }));
                    state!.step++;
                }
            });
        }
        else if (state.step === 6) {
            // Step 6: Remove the brackets entirely
            editor.edit(editBuilder => {
                for (const c of state!.cursorsData) {
                    // Delete open and close chars in a single transaction.
                    // Specify ranges in the original (pre-edit) document.
                    editBuilder.delete(new vscode.Range(doc.positionAt(c.openOff), doc.positionAt(c.openOff + 1)));
                    editBuilder.delete(new vscode.Range(doc.positionAt(c.closeOff), doc.positionAt(c.closeOff + 1)));
                }
            }).then(success => {
                if (success) {
                    state!.bracketsRemoved = true;
                    // After removing 2 chars, content is at [openOff, closeOff-1) in the new doc.
                    const newSelections = state!.cursorsData.map(c =>
                        new vscode.Selection(doc.positionAt(c.openOff), doc.positionAt(c.closeOff - 1))
                    );
                    editor.selections = newSelections;
                    state!.lastAppliedSelections = newSelections.map(s => ({
                        anchor: doc.offsetAt(s.anchor),
                        active: doc.offsetAt(s.active)
                    }));
                    state!.step++;
                }
            });
        }
        else if (state.step === 7) {
            // Step 7: Restore original brackets and original cursor/selection
            editor.edit(editBuilder => {
                for (const c of state!.cursorsData) {
                    const bracketIdx = c.origIndex;
                    if (state!.bracketsRemoved) {
                        // Brackets were deleted: insert them back
                        editBuilder.insert(doc.positionAt(c.openOff), OPEN_CHARS[bracketIdx]);
                        editBuilder.insert(doc.positionAt(c.closeOff - 1), CLOSE_CHARS[bracketIdx]);
                    } else {
                        editBuilder.replace(
                            new vscode.Range(doc.positionAt(c.openOff), doc.positionAt(c.openOff + 1)),
                            OPEN_CHARS[bracketIdx]
                        );
                        editBuilder.replace(
                            new vscode.Range(doc.positionAt(c.closeOff), doc.positionAt(c.closeOff + 1)),
                            CLOSE_CHARS[bracketIdx]
                        );
                    }
                }
            }).then(success => {
                if (success) {
                    editor.selections = [...state!.originalSelections];
                    bracketSelectStates.delete(editorId);
                }
            });
        }
    }));
}

function writeToFile(folder: any, filename: any, content: any) {
    // Remove invalid file name characters
    filename = filename.replace(/[/\\?%*:"|<>]/g, "").replace(/\s{2,}/g, " ");
    var writeStream = fs.createWriteStream(path.join(folder, filename));
    writeStream.write(content);
    writeStream.end();
    vscode.window.showInformationMessage(filename + " created!");
}

// this method is called when your extension is deactivated
export function deactivate() { }
