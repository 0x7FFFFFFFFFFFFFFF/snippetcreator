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

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, snippetcreator is now active!');

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
