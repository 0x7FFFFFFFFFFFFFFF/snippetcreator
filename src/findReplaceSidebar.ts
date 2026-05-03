import * as vscode from 'vscode';

interface FindReplaceViewState {
    findText: string;
    replaceText: string;
    useRegex: boolean;
    matchCase: boolean;
    wholeWord: boolean;
    preserveCase: boolean;
    inSelection: boolean;
    matchCount: number;
    activeMatch: number;
    canUseSelection: boolean;
    statusMessage: string;
    regexFlagsInfo: string;
}

interface FindReplaceHistoryEntry {
    findText: string;
    replaceText: string;
    useRegex: boolean;
    matchCase: boolean;
    wholeWord: boolean;
    preserveCase: boolean;
    inSelection: boolean;
    name?: string;
}

interface SearchMatch {
    range: vscode.Range;
    text: string;
}

export class LargeFindReplaceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'snippetcreator.findReplaceView';
    public static readonly containerId = 'snippetcreatorFindReplace';

    private view: vscode.WebviewView | undefined;
    private readonly allMatchesDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
        border: '1px solid var(--vscode-editor-findMatchHighlightBorder)'
    });
    private readonly activeMatchDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'var(--vscode-editor-findMatchBackground)',
        border: '1px solid var(--vscode-editor-findMatchBorder)'
    });
    private readonly disposables: vscode.Disposable[] = [];
    private lastKnownTextEditor: vscode.TextEditor | undefined;
    private history: FindReplaceHistoryEntry[] = [];
    private findInputFocused = false;
    private pendingFocusFindInput = false;
    private recentFinds: string[] = [];
    private recentReplaces: string[] = [];
    private static readonly MAX_HISTORY = 50;
    private static readonly MAX_RECENT = 20;
    private static readonly HISTORY_KEY = 'snippetcreator.findReplaceHistory';
    private static readonly RECENT_FINDS_KEY = 'snippetcreator.recentFinds';
    private static readonly RECENT_REPLACES_KEY = 'snippetcreator.recentReplaces';
    private state: FindReplaceViewState = {
        findText: '',
        replaceText: '',
        useRegex: false,
        matchCase: false,
        wholeWord: false,
        preserveCase: false,
        inSelection: false,
        matchCount: 0,
        activeMatch: 0,
        canUseSelection: false,
        statusMessage: '',
        regexFlagsInfo: ''
    };

    constructor(private readonly context: vscode.ExtensionContext) {
        this.lastKnownTextEditor = vscode.window.activeTextEditor;
        this.history = this.context.globalState.get<FindReplaceHistoryEntry[]>(LargeFindReplaceViewProvider.HISTORY_KEY, []);
        this.recentFinds = this.context.globalState.get<string[]>(LargeFindReplaceViewProvider.RECENT_FINDS_KEY, []);
        this.recentReplaces = this.context.globalState.get<string[]>(LargeFindReplaceViewProvider.RECENT_REPLACES_KEY, []);
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.lastKnownTextEditor = editor;
                }
                this.syncSelectionAvailability();
                this.refreshMatches();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor === this.getActiveEditor()) {
                    this.syncSelectionAvailability();
                    this.refreshMatches();
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                const activeEditor = this.getActiveEditor();
                if (activeEditor && event.document === activeEditor.document) {
                    this.refreshMatches();
                }
            })
        );
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };
        webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

        this.disposables.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.prefillFindFromSelection(false);
                    this.refreshMatches();
                    if (this.pendingFocusFindInput) {
                        this.pendingFocusFindInput = false;
                        this.focusFindInput();
                    }
                }
            }),
            webviewView.webview.onDidReceiveMessage(async message => {
                await this.handleMessage(message);
            })
        );

        this.syncSelectionAvailability();
        this.postState();
        this.postHistory();
        this.postRecentTexts();
        this.refreshMatches();
    }

    public async toggleVisibility(): Promise<void> {
        if (this.view?.visible) {
            if (this.findInputFocused) {
                await vscode.commands.executeCommand('workbench.action.closeSidebar');
            } else {
                this.focusFindInput();
            }
            return;
        }

        this.pendingFocusFindInput = true;
        this.prefillFindFromSelection(true);
        await vscode.commands.executeCommand(`workbench.view.extension.${LargeFindReplaceViewProvider.containerId}`);
        this.view?.show(false);
    }

    public focusFindInput(): void {
        this.view?.webview.postMessage({ type: 'focusFindInput' });
    }

    public dispose(): void {
        this.clearDecorations();
        this.allMatchesDecoration.dispose();
        this.activeMatchDecoration.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async handleMessage(message: { type?: string; payload?: Partial<FindReplaceViewState> }): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.syncSelectionAvailability();
                this.postState();
                this.postHistory();
                this.postRecentTexts();
                if (this.pendingFocusFindInput) {
                    this.pendingFocusFindInput = false;
                    this.focusFindInput();
                }
                break;
            case 'updateState':
                this.state = {
                    ...this.state,
                    ...message.payload,
                    preserveCase: message.payload?.useRegex ? false : (message.payload?.preserveCase ?? this.state.preserveCase)
                };
                this.refreshMatches();
                break;
            case 'findFirst':
                this.recordHistory();
                this.recordRecentTexts();
                await this.selectFirstMatch();
                break;
            case 'findNext':
                this.recordHistory();
                this.recordRecentTexts();
                await this.selectAdjacentMatch(1);
                break;
            case 'findPrevious':
                this.recordHistory();
                this.recordRecentTexts();
                await this.selectAdjacentMatch(-1);
                break;
            case 'findPrevious10':
                this.recordHistory();
                this.recordRecentTexts();
                for (let i = 0; i < 10; i++) { await this.selectAdjacentMatch(-1); }
                break;
            case 'findNext10':
                this.recordHistory();
                this.recordRecentTexts();
                for (let i = 0; i < 10; i++) { await this.selectAdjacentMatch(1); }
                break;
            case 'replaceOne':
                this.recordHistory();
                this.recordRecentTexts();
                await this.replaceCurrentMatch();
                break;
            case 'replaceOneStay':
                this.recordHistory();
                this.recordRecentTexts();
                await this.replaceCurrentMatch(true);
                break;
            case 'replaceOne10':
                this.recordHistory();
                this.recordRecentTexts();
                for (let i = 0; i < 10; i++) { await this.replaceCurrentMatch(); }
                break;
            case 'replaceAll':
                this.recordHistory();
                this.recordRecentTexts();
                await this.replaceAllMatches();
                break;
            case 'loadHistory':
                if (message.payload) {
                    this.state = { ...this.state, ...message.payload };
                    this.refreshMatches();
                }
                break;
            case 'findInputFocused':
                this.findInputFocused = true;
                break;
            case 'findInputBlurred':
                this.findInputFocused = false;
                break;
            case 'saveToHistory': {
                this.recordHistory();
                const findDisplay = this.state.findText.replace(/\n/g, ' ').replace(/\r/g, '');
                const replaceDisplay = this.state.replaceText.replace(/\n/g, ' ').replace(/\r/g, '');
                const defaultName = `${findDisplay} \u2192 ${replaceDisplay}`;
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter an optional name for this history entry',
                    value: defaultName,
                    valueSelection: [0, defaultName.length]
                });
                if (name !== undefined && this.history.length > 0) {
                    this.history[0].name = name || undefined;
                    this.context.globalState.update(LargeFindReplaceViewProvider.HISTORY_KEY, this.history);
                    this.postHistory();
                }
                break;
            }
            case 'renameHistory': {
                const index = (message as any).payload?.index;
                if (typeof index === 'number' && index >= 0 && index < this.history.length) {
                    const entry = this.history[index];
                    const currentName = entry.name || '';
                    const renameResult = await vscode.window.showInputBox({
                        prompt: 'Enter a name for this history entry',
                        value: currentName,
                        valueSelection: [0, currentName.length]
                    });
                    if (renameResult !== undefined) {
                        entry.name = renameResult || undefined;
                        this.context.globalState.update(LargeFindReplaceViewProvider.HISTORY_KEY, this.history);
                        this.postHistory();
                    }
                }
                break;
            }
            case 'deleteHistory': {
                const deleteIndex = (message as any).payload?.index;
                if (typeof deleteIndex === 'number' && deleteIndex >= 0 && deleteIndex < this.history.length) {
                    this.history.splice(deleteIndex, 1);
                    this.context.globalState.update(LargeFindReplaceViewProvider.HISTORY_KEY, this.history);
                    this.postHistory();
                }
                break;
            }
            default:
                break;
        }
    }

    private getActiveEditor(): vscode.TextEditor | undefined {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.lastKnownTextEditor = editor;
            return editor;
        }
        // When the sidebar webview has focus, activeTextEditor may be undefined.
        // Fall back to the last known text editor.
        if (this.lastKnownTextEditor && !this.lastKnownTextEditor.document.isClosed) {
            return this.lastKnownTextEditor;
        }
        return undefined;
    }

    private prefillFindFromSelection(force: boolean): void {
        const editor = this.getActiveEditor();
        if (!editor || editor.selection.isEmpty) {
            return;
        }

        const selectionText = editor.document.getText(editor.selection);
        if (!selectionText) {
            return;
        }

        if (force || this.state.findText.length === 0) {
            this.state.findText = selectionText;
        }
    }

    private syncSelectionAvailability(): void {
        const editor = this.getActiveEditor();
        this.state.canUseSelection = !!editor && !editor.selection.isEmpty;
        if (this.state.inSelection && !this.state.canUseSelection) {
            this.state.inSelection = false;
            this.state.statusMessage = 'In Selection was disabled because there is no active selection.';
        }
        this.postState();
    }

    private refreshMatches(statusMessage?: string): void {
        if (this.state.useRegex && this.state.findText.length > 0) {
            const parsed = this.parseInlineRegexFlags(this.state.findText);
            this.state.regexFlagsInfo = parsed.descriptions.join(', ');
        } else {
            this.state.regexFlagsInfo = '';
        }

        const editor = this.getActiveEditor();
        if (!editor || this.state.findText.length === 0) {
            this.state.matchCount = 0;
            this.state.activeMatch = 0;
            this.state.statusMessage = statusMessage ?? '';
            this.clearDecorations();
            this.postState();
            return;
        }

        try {
            const matches = this.getMatches(editor);
            const activeIndex = this.findSelectedMatchIndex(matches, editor.selection);
            this.state.matchCount = matches.length;
            this.state.activeMatch = activeIndex >= 0 ? activeIndex + 1 : 0;
            this.state.statusMessage = statusMessage ?? (matches.length > 0 ? '' : 'No matches found.');
            this.applyDecorations(editor, matches, activeIndex);
        } catch (error) {
            this.state.matchCount = 0;
            this.state.activeMatch = 0;
            this.state.statusMessage = error instanceof Error ? error.message : String(error);
            this.clearDecorations();
        }

        this.postState();
    }

    private clearDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.allMatchesDecoration, []);
            editor.setDecorations(this.activeMatchDecoration, []);
        }
    }

    private applyDecorations(editor: vscode.TextEditor, matches: SearchMatch[], activeIndex: number): void {
        const inactiveRanges = matches.map(match => match.range);
        editor.setDecorations(this.allMatchesDecoration, inactiveRanges);

        if (activeIndex >= 0 && activeIndex < matches.length) {
            editor.setDecorations(this.activeMatchDecoration, [matches[activeIndex].range]);
        } else {
            editor.setDecorations(this.activeMatchDecoration, []);
        }
    }

    private getSearchRange(editor: vscode.TextEditor): vscode.Range {
        if (this.state.inSelection && !editor.selection.isEmpty) {
            return new vscode.Range(editor.selection.start, editor.selection.end);
        }

        const document = editor.document;
        return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    }

    private getMatches(editor: vscode.TextEditor): SearchMatch[] {
        const range = this.getSearchRange(editor);
        const text = editor.document.getText(range);
        const regex = this.createSearchRegExp();
        const matches: SearchMatch[] = [];
        let match: RegExpExecArray | null;
        let guard = 0;

        while ((match = regex.exec(text)) !== null) {
            const startOffset = editor.document.offsetAt(range.start) + match.index;
            const endOffset = startOffset + match[0].length;
            matches.push({
                range: new vscode.Range(editor.document.positionAt(startOffset), editor.document.positionAt(endOffset)),
                text: match[0]
            });

            if (match[0].length === 0) {
                regex.lastIndex += 1;
            }

            guard += 1;
            if (guard > 20000) {
                break;
            }
        }

        return matches;
    }

    private createSearchRegExp(): RegExp {
        return this.buildRegexFromState(true);
    }

    private createSingleMatchRegExp(): RegExp {
        return this.buildRegexFromState(false);
    }

    private buildRegexFromState(global: boolean): RegExp {
        let sourceText = this.state.useRegex ? this.state.findText : this.escapeRegExp(this.state.findText);
        let flags = global ? 'g' : '';
        let findTextForWordCheck = this.state.findText;

        if (this.state.useRegex) {
            const parsed = this.parseInlineRegexFlags(sourceText);
            sourceText = parsed.cleanPattern;
            findTextForWordCheck = parsed.cleanPattern;

            if (parsed.flagOverrides.i !== undefined) {
                if (parsed.flagOverrides.i) { flags += 'i'; }
            } else if (!this.state.matchCase) {
                flags += 'i';
            }

            if (parsed.flagOverrides.s !== undefined) {
                if (parsed.flagOverrides.s) { flags += 's'; }
            }

            if (parsed.flagOverrides.m !== undefined) {
                if (parsed.flagOverrides.m) { flags += 'm'; }
            } else {
                flags += 'm';
            }
        } else {
            if (!this.state.matchCase) { flags += 'i'; }
            flags += 'm';
        }

        const wrappedSource = this.state.wholeWord ? this.wrapWholeWord(sourceText, findTextForWordCheck) : sourceText;

        try {
            return new RegExp(wrappedSource, flags);
        } catch (error) {
            throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private parseInlineRegexFlags(pattern: string): { cleanPattern: string; flagOverrides: { i?: boolean; s?: boolean; m?: boolean }; descriptions: string[] } {
        const match = pattern.match(/^\(\?(-?[ism])+\)/);
        if (!match) {
            return { cleanPattern: pattern, flagOverrides: {}, descriptions: [] };
        }

        const flagStr = match[0].slice(2, -1);
        const flagOverrides: { i?: boolean; s?: boolean; m?: boolean } = {};
        const descriptions: string[] = [];

        let idx = 0;
        while (idx < flagStr.length) {
            let negate = false;
            if (flagStr[idx] === '-') {
                negate = true;
                idx++;
            }
            if (idx < flagStr.length) {
                const flag = flagStr[idx] as 'i' | 's' | 'm';
                switch (flag) {
                    case 'i':
                        flagOverrides.i = !negate;
                        descriptions.push(negate ? 'case sensitive' : 'case insensitive');
                        break;
                    case 's':
                        flagOverrides.s = !negate;
                        descriptions.push(negate ? "dot doesn't match line breaks" : 'dot matches line breaks');
                        break;
                    case 'm':
                        flagOverrides.m = !negate;
                        descriptions.push(negate ? '^$ match at string start/end' : '^$ match at line breaks');
                        break;
                }
                idx++;
            }
        }

        const cleanPattern = pattern.slice(match[0].length);
        return { cleanPattern, flagOverrides, descriptions };
    }

    private wrapWholeWord(source: string, findTextForCheck?: string): string {
        const checkText = findTextForCheck ?? this.state.findText;
        const startsWithWord = /^\w/.test(checkText);
        const endsWithWord = /\w$/.test(checkText);
        const prefix = startsWithWord ? '\\b' : '';
        const suffix = endsWithWord ? '\\b' : '';
        return `${prefix}(?:${source})${suffix}`;
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private findSelectedMatchIndex(matches: SearchMatch[], selection: vscode.Selection): number {
        return matches.findIndex(match =>
            match.range.start.isEqual(selection.start) && match.range.end.isEqual(selection.end)
        );
    }

    private async selectFirstMatch(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) {
            this.refreshMatches('No active editor is available.');
            return;
        }

        let matches: SearchMatch[];
        try {
            matches = this.getMatches(editor);
        } catch (error) {
            this.refreshMatches(error instanceof Error ? error.message : String(error));
            return;
        }

        if (matches.length === 0) {
            this.refreshMatches('No matches found.');
            return;
        }

        const match = matches[0];
        editor.selection = new vscode.Selection(match.range.start, match.range.end);
        editor.revealRange(match.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.refreshMatches();
    }

    private async selectAdjacentMatch(direction: 1 | -1): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) {
            this.refreshMatches('No active editor is available.');
            return;
        }

        let matches: SearchMatch[];
        try {
            matches = this.getMatches(editor);
        } catch (error) {
            this.refreshMatches(error instanceof Error ? error.message : String(error));
            return;
        }

        if (matches.length === 0) {
            this.refreshMatches('No matches found.');
            return;
        }

        const anchorOffset = direction > 0
            ? editor.document.offsetAt(editor.selection.end)
            : editor.document.offsetAt(editor.selection.start);

        let nextIndex = -1;
        if (direction > 0) {
            nextIndex = matches.findIndex(match => editor.document.offsetAt(match.range.start) >= anchorOffset);
            if (nextIndex === -1) {
                nextIndex = 0;
            }
        } else {
            for (let index = matches.length - 1; index >= 0; index -= 1) {
                if (editor.document.offsetAt(matches[index].range.end) <= anchorOffset) {
                    nextIndex = index;
                    break;
                }
            }
            if (nextIndex === -1) {
                nextIndex = matches.length - 1;
            }
        }

        const match = matches[nextIndex];
        editor.selection = new vscode.Selection(match.range.start, match.range.end);
        editor.revealRange(match.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.refreshMatches();
    }

    private async replaceCurrentMatch(stayAtPosition = false): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) {
            this.refreshMatches('No active editor is available.');
            return;
        }

        let matches: SearchMatch[];
        try {
            matches = this.getMatches(editor);
        } catch (error) {
            this.refreshMatches(error instanceof Error ? error.message : String(error));
            return;
        }

        if (matches.length === 0) {
            this.refreshMatches('No matches found.');
            return;
        }

        const selectedIndex = this.findSelectedMatchIndex(matches, editor.selection);
        if (selectedIndex === -1) {
            await this.selectAdjacentMatch(1);
            return;
        }

        const selectedMatch = matches[selectedIndex];
        const replacement = this.resolveReplacement(selectedMatch, editor.document.getText(this.getSearchRange(editor)));
        const replaceStart = selectedMatch.range.start;
        await editor.edit(editBuilder => {
            editBuilder.replace(selectedMatch.range, replacement);
        });

        if (stayAtPosition) {
            const replaceEnd = editor.document.positionAt(editor.document.offsetAt(replaceStart) + replacement.length);
            editor.selection = new vscode.Selection(replaceStart, replaceEnd);
            editor.revealRange(new vscode.Range(replaceStart, replaceEnd), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            this.refreshMatches();
        } else {
            await this.selectAdjacentMatch(1);
        }
    }

    private async replaceAllMatches(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) {
            this.refreshMatches('No active editor is available.');
            return;
        }

        if (this.state.inSelection && editor.selection.isEmpty) {
            this.refreshMatches('In Selection requires a non-empty selection.');
            return;
        }

        const range = this.getSearchRange(editor);
        const targetText = editor.document.getText(range);

        if (targetText.length === 0 || this.state.findText.length === 0) {
            this.refreshMatches('Nothing to replace.');
            return;
        }

        let regex: RegExp;
        try {
            regex = this.createSearchRegExp();
        } catch (error) {
            this.refreshMatches(error instanceof Error ? error.message : String(error));
            return;
        }

        const processedReplacement = this.decodeReplacementEscapes(this.state.replaceText);
        let replacementCount = 0;
        const nextText = targetText.replace(regex, (matched, ...args) => {
            replacementCount += 1;
            if (this.state.useRegex) {
                return this.state.preserveCase ? this.applyPreserveCase(matched, this.expandRegexReplacement(matched, args, processedReplacement, targetText)) : this.expandRegexReplacement(matched, args, processedReplacement, targetText);
            }

            return this.state.preserveCase ? this.applyPreserveCase(matched, processedReplacement) : processedReplacement;
        });

        if (replacementCount === 0) {
            this.refreshMatches('No matches found.');
            return;
        }

        await editor.edit(editBuilder => {
            editBuilder.replace(range, nextText);
        });

        this.refreshMatches(`Replaced ${replacementCount} match${replacementCount === 1 ? '' : 'es'}.`);
    }

    private resolveReplacement(match: SearchMatch, targetText: string): string {
        const processedReplacement = this.decodeReplacementEscapes(this.state.replaceText);
        if (!this.state.useRegex) {
            return this.state.preserveCase ? this.applyPreserveCase(match.text, processedReplacement) : processedReplacement;
        }

        const regex = this.createSingleMatchRegExp();
        const replaced = match.text.replace(regex, (...args) => this.expandRegexReplacement(args[0], args.slice(1), processedReplacement, targetText));
        return this.state.preserveCase ? this.applyPreserveCase(match.text, replaced) : replaced;
    }

    private decodeReplacementEscapes(replacement: string): string {
        return replacement.replace(/\\(\\)|\\([tnrfv]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (match, escapedBackslash, escapeChar) => {
            if (escapedBackslash) {
                return '\\';
            }

            switch (escapeChar[0]) {
                case 't': return '\t';
                case 'n': return '\n';
                case 'r': return '\r';
                case 'f': return '\f';
                case 'v': return '\v';
                case 'x': return String.fromCharCode(parseInt(escapeChar.slice(1), 16));
                case 'u': return String.fromCharCode(parseInt(escapeChar.slice(1), 16));
                default: return match;
            }
        });
    }

    private expandRegexReplacement(match: string, args: unknown[], replacement: string, fullText: string): string {
        const captures = args.slice(0, -2).map(value => value === undefined ? '' : String(value));
        const offset = Number(args[args.length - 2]);

        return replacement.replace(/\$(\$|&|`|'|\d+)/g, (_token, symbol: string) => {
            if (symbol === '$') {
                return '$';
            }
            if (symbol === '&') {
                return match;
            }
            if (symbol === '`') {
                return fullText.slice(0, offset);
            }
            if (symbol === "'") {
                return fullText.slice(offset + match.length);
            }

            const captureIndex = Number(symbol) - 1;
            if (captureIndex >= 0 && captureIndex < captures.length) {
                return captures[captureIndex];
            }

            return '';
        });
    }

    private applyPreserveCase(source: string, replacement: string): string {
        if (source.length === 0 || replacement.length === 0) {
            return replacement;
        }

        if (source === source.toUpperCase()) {
            return replacement.toUpperCase();
        }

        if (source === source.toLowerCase()) {
            return replacement.toLowerCase();
        }

        const capitalizedSource = source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
        if (source === capitalizedSource) {
            return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
        }

        return replacement;
    }

    private recordHistory(): void {
        if (this.state.findText.length === 0) {
            return;
        }
        const entry: FindReplaceHistoryEntry = {
            findText: this.state.findText,
            replaceText: this.state.replaceText,
            useRegex: this.state.useRegex,
            matchCase: this.state.matchCase,
            wholeWord: this.state.wholeWord,
            preserveCase: this.state.preserveCase,
            inSelection: this.state.inSelection
        };
        const existingIndex = this.history.findIndex(h =>
            h.findText === entry.findText &&
            h.replaceText === entry.replaceText &&
            h.useRegex === entry.useRegex &&
            h.matchCase === entry.matchCase &&
            h.wholeWord === entry.wholeWord &&
            h.preserveCase === entry.preserveCase &&
            h.inSelection === entry.inSelection
        );
        if (existingIndex >= 0) {
            entry.name = this.history[existingIndex].name;
            this.history.splice(existingIndex, 1);
        }
        this.history.unshift(entry);
        if (this.history.length > LargeFindReplaceViewProvider.MAX_HISTORY) {
            this.history.length = LargeFindReplaceViewProvider.MAX_HISTORY;
        }
        this.context.globalState.update(LargeFindReplaceViewProvider.HISTORY_KEY, this.history);
        this.postHistory();
    }

    private recordRecentTexts(): void {
        const findText = this.state.findText;
        if (findText.length > 0) {
            const idx = this.recentFinds.indexOf(findText);
            if (idx >= 0) { this.recentFinds.splice(idx, 1); }
            this.recentFinds.unshift(findText);
            if (this.recentFinds.length > LargeFindReplaceViewProvider.MAX_RECENT) {
                this.recentFinds.length = LargeFindReplaceViewProvider.MAX_RECENT;
            }
            this.context.globalState.update(LargeFindReplaceViewProvider.RECENT_FINDS_KEY, this.recentFinds);
        }
        const replaceText = this.state.replaceText;
        if (replaceText.length > 0) {
            const idx = this.recentReplaces.indexOf(replaceText);
            if (idx >= 0) { this.recentReplaces.splice(idx, 1); }
            this.recentReplaces.unshift(replaceText);
            if (this.recentReplaces.length > LargeFindReplaceViewProvider.MAX_RECENT) {
                this.recentReplaces.length = LargeFindReplaceViewProvider.MAX_RECENT;
            }
            this.context.globalState.update(LargeFindReplaceViewProvider.RECENT_REPLACES_KEY, this.recentReplaces);
        }
        this.postRecentTexts();
    }

    private postRecentTexts(): void {
        this.view?.webview.postMessage({
            type: 'recentTexts',
            payload: { finds: this.recentFinds, replaces: this.recentReplaces }
        });
    }

    private postHistory(): void {
        this.view?.webview.postMessage({
            type: 'history',
            payload: this.history
        });
    }

    private postState(): void {
        this.view?.webview.postMessage({
            type: 'state',
            payload: this.state
        });
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const initialState = JSON.stringify(this.state).replace(/</g, '\\u003c');
        const nonce = this.createNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Find and Replace</title>
    <style>
        :root {
            color-scheme: light dark;
        }

        * {
            box-sizing: border-box;
        }

        html, body {
            height: 100%;
        }

        body {
            margin: 0;
            padding: 12px;
            background: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        .layout {
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-height: 100%;
        }

        .heading {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .title {
            font-size: 1rem;
            font-weight: 700;
            letter-spacing: 0.02em;
        }

        .counter {
            color: var(--vscode-descriptionForeground);
            font-size: 0.86rem;
            white-space: nowrap;
        }

        .field {
            display: flex;
            flex-direction: column;
            gap: 0;
        }

        textarea {
            width: 100%;
            min-height: 120px;
            resize: vertical;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 6px 8px;
            font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', Menlo, Monaco, Consolas, 'Courier New', monospace);
            font-size: var(--vscode-editor-font-size, inherit);
            line-height: 1.45;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0;
        }

        .options-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px 12px;
        }

        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            user-select: none;
            font-size: 0.88rem;
            white-space: nowrap;
        }

        .checkbox-row input[type="checkbox"] {
            margin: 0;
            cursor: pointer;
            accent-color: var(--vscode-button-background);
        }

        .checkbox-row.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .checkbox-row.disabled input[type="checkbox"] {
            cursor: not-allowed;
        }

        .toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
        }

        button {
            border: 1px solid transparent;
            border-radius: 4px;
            padding: 3px 8px;
            font: inherit;
            cursor: pointer;
            transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
        }

        .action-find {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .action-find:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .action-find-x10 {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            opacity: 0.78;
        }

        .action-find-x10:hover {
            background: var(--vscode-button-hoverBackground);
            opacity: 1;
        }

        .action-replace {
            background: #89513a;
            color: #ffffff;
        }

        .action-replace:hover {
            background: #a0624a;
        }

        .action-replace-x10 {
            background: #89513a;
            color: #ffffff;
            opacity: 0.75;
        }

        .action-replace-x10:hover {
            background: #a0624a;
            opacity: 1;
        }

        .action-save {
            background: #2e7d32;
            color: #ffffff;
        }

        .action-save:hover {
            background: #388e3c;
        }

        .action-rename {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            white-space: nowrap;
        }

        .action-rename:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .history-row {
            display: flex;
            gap: 4px;
            align-items: center;
        }

        .history-row select {
            flex: 1;
            min-width: 0;
        }

        button[disabled] {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 0.84rem;
            line-height: 1.4;
        }

        .status {
            min-height: 1.3rem;
            color: var(--vscode-descriptionForeground);
            font-size: 0.84rem;
        }

        .regex-flags-info {
            font-size: 0.76rem;
            color: var(--vscode-textLink-foreground);
            line-height: 1.3;
            padding: 0 2px;
            margin-top: -6px;
            display: none;
        }

        .regex-flags-info.visible {
            display: block;
        }

        .history-section {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .history-label {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
        }

        .custom-dropdown {
            position: relative;
            flex: 1;
            min-width: 0;
        }

        .dropdown-trigger {
            width: 100%;
            text-align: left;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 3px 6px;
            font: inherit;
            cursor: pointer;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .dropdown-trigger:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0;
        }

        .dropdown-list {
            display: none;
            position: absolute;
            left: 0;
            right: 0;
            top: 100%;
            max-height: 300px;
            overflow-y: auto;
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--vscode-panel-border)));
            border-radius: 4px;
            z-index: 100;
            margin-top: 2px;
        }

        .dropdown-list.open {
            display: block;
        }

        .dropdown-item {
            padding: 4px 8px;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', Menlo, Monaco, Consolas, 'Courier New', monospace);
            font-size: var(--vscode-editor-font-size, inherit);
        }

        .dropdown-item:hover,
        .dropdown-item.highlighted {
            background: var(--vscode-list-hoverBackground);
        }

        .history-name {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 5px;
            border-radius: 3px;
            font-weight: 600;
        }

        .history-arrow {
            color: #ffffff;
            background: var(--vscode-textLink-foreground);
            padding: 0 4px;
            border-radius: 3px;
            font-weight: bold;
        }

        .context-menu {
            display: none;
            position: fixed;
            max-height: 300px;
            min-width: 180px;
            max-width: 400px;
            overflow-y: auto;
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--vscode-panel-border)));
            border-radius: 4px;
            z-index: 200;
            padding: 2px 0;
        }

        .context-menu.open {
            display: block;
        }

        .context-menu-item {
            padding: 4px 10px;
            cursor: pointer;
            white-space: pre-wrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, inherit);
            max-height: 3.2em;
            line-height: 1.45;
        }

        .context-menu-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .context-menu-empty {
            padding: 4px 10px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 0.86rem;
        }
    </style>
</head>
<body>
    <div class="layout">
        <div class="heading">
            <div class="title">Find and Replace</div>
            <div class="counter" id="counter">0 matches</div>
        </div>

        <div class="field">
            <textarea id="findText" wrap="soft" spellcheck="false" placeholder="Find"></textarea>
        </div>
        <div id="regexFlagsInfo" class="regex-flags-info"></div>

        <div class="field">
            <textarea id="replaceText" wrap="soft" spellcheck="false" placeholder="Replace"></textarea>
        </div>

        <div class="options-group">
            <label class="checkbox-row"><input type="checkbox" id="useRegex"> Regex</label>
            <label class="checkbox-row"><input type="checkbox" id="matchCase"> Match Case</label>
            <label class="checkbox-row"><input type="checkbox" id="wholeWord"> Whole Word</label>
            <label class="checkbox-row"><input type="checkbox" id="preserveCase"> Preserve Case</label>
            <label class="checkbox-row"><input type="checkbox" id="inSelection"> In Selection</label>
        </div>

        <div class="toolbar">
            <button class="action-find" id="findFirst">Find First</button>
            <button class="action-find" id="findPrevious">Find Previous</button>
            <button class="action-find" id="findNext">Find Next</button>
            <button class="action-find-x10" id="findPrevious10">Find Previous x10</button>
            <button class="action-find-x10" id="findNext10">Find Next x10</button>
        </div>
        <div class="toolbar">
            <button class="action-replace" id="replaceOne">Replace Current</button>
            <button class="action-replace" id="replaceAll">Replace All</button>
            <button class="action-replace-x10" id="replaceOne10">Replace Current x10</button>
            <button class="action-save" id="saveToHistory">Save</button>
        </div>

        <div class="history-section">
            <label class="history-label">History</label>
            <div class="history-row">
                <div class="custom-dropdown" id="historyDropdown">
                    <button class="dropdown-trigger" id="historyTrigger" type="button">-- No history --</button>
                    <div class="dropdown-list" id="historyListEl"></div>
                </div>
            </div>
        </div>

        <div class="status" id="status"></div>
        <div class="context-menu" id="contextMenu"></div>

        <div class="hint">In History dropdown: <b>Ctrl+D</b> delete, <b>Ctrl+R</b> rename.<br>In Find/Replace input: <b>Esc</b> clear current input, <b>Enter</b> Find Next, <b>Shift+Enter</b> newline.<br>Replace Current: <b>Ctrl+Click</b> skip to next, <b>Alt+Click</b> replace &amp; stay.</div>
    </div>

    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        const initialState = ${initialState};
        let state = vscodeApi.getState() || initialState;

        const findText = document.getElementById('findText');
        const replaceText = document.getElementById('replaceText');
        const counter = document.getElementById('counter');
        const status = document.getElementById('status');
        const regexFlagsInfo = document.getElementById('regexFlagsInfo');
        const historyTrigger = document.getElementById('historyTrigger');
        const historyListEl = document.getElementById('historyListEl');
        var historyList = [];
        var recentFinds = [];
        var recentReplaces = [];
        var dropdownOpen = false;
        var highlightedIdx = -1;
        var selectedHistoryIdx = -1;
        const controls = {
            useRegex: document.getElementById('useRegex'),
            matchCase: document.getElementById('matchCase'),
            wholeWord: document.getElementById('wholeWord'),
            preserveCase: document.getElementById('preserveCase'),
            inSelection: document.getElementById('inSelection')
        };

        function pushState(partial) {
            state = { ...state, ...partial };
            vscodeApi.setState(state);
            vscodeApi.postMessage({ type: 'updateState', payload: partial });
        }

        function updateCheckbox(id, value, disabled) {
            var element = controls[id];
            element.checked = !!value;
            element.disabled = !!disabled;
            var row = element.closest('.checkbox-row');
            if (row) {
                if (disabled) { row.classList.add('disabled'); }
                else { row.classList.remove('disabled'); }
            }
        }

        function render() {
            if (findText.value !== state.findText) {
                findText.value = state.findText;
            }
            if (replaceText.value !== state.replaceText) {
                replaceText.value = state.replaceText;
            }

            updateCheckbox('useRegex', state.useRegex, false);
            updateCheckbox('matchCase', state.matchCase, false);
            updateCheckbox('wholeWord', state.wholeWord, false);
            updateCheckbox('preserveCase', state.preserveCase, state.useRegex);
            updateCheckbox('inSelection', state.inSelection, !state.canUseSelection && !state.inSelection);

            if (state.matchCount > 0) {
                counter.textContent = state.activeMatch > 0
                    ? state.activeMatch + ' of ' + state.matchCount
                    : state.matchCount + ' matches';
            } else {
                counter.textContent = '0 matches';
            }

            status.textContent = state.statusMessage || '';

            if (state.regexFlagsInfo) {
                regexFlagsInfo.textContent = state.regexFlagsInfo;
                regexFlagsInfo.classList.add('visible');
            } else {
                regexFlagsInfo.textContent = '';
                regexFlagsInfo.classList.remove('visible');
            }
        }

        function toggleOption(key) {
            var nextValue = !state[key];
            var partial = {};
            partial[key] = nextValue;
            if (key === 'useRegex' && nextValue) {
                partial.preserveCase = false;
            }
            pushState(partial);
        }

        function truncateText(text, maxLen) {
            if (!text) return '(empty)';
            var s = text.replace(/\\n/g, ' ').replace(/\\r/g, '');
            if (s.length > maxLen) return s.substring(0, maxLen) + '...';
            return s;
        }

        function openDropdown() {
            if (historyList.length === 0) return;
            historyListEl.classList.add('open');
            dropdownOpen = true;
            highlightedIdx = -1;
        }

        function closeDropdown() {
            historyListEl.classList.remove('open');
            dropdownOpen = false;
            highlightedIdx = -1;
            clearHighlight();
        }

        function clearHighlight() {
            var items = historyListEl.querySelectorAll('.dropdown-item');
            items.forEach(function(el) { el.classList.remove('highlighted'); });
        }

        function applyHighlight() {
            var items = historyListEl.querySelectorAll('.dropdown-item');
            items.forEach(function(el, i) {
                if (i === highlightedIdx) el.classList.add('highlighted');
                else el.classList.remove('highlighted');
            });
            if (highlightedIdx >= 0 && highlightedIdx < items.length) {
                items[highlightedIdx].scrollIntoView({ block: 'nearest' });
            }
        }

        function renderHistory() {
            historyListEl.innerHTML = '';
            if (historyList.length === 0) {
                historyTrigger.textContent = '-- No history --';
                historyTrigger.disabled = true;
                closeDropdown();
                return;
            }
            historyTrigger.disabled = false;
            historyTrigger.textContent = '-- Select from history (' + historyList.length + ') --';
            for (var i = 0; i < historyList.length; i++) {
                var entry = historyList[i];
                var item = document.createElement('div');
                item.className = 'dropdown-item';
                item.dataset.index = String(i);
                var flags = [];
                if (entry.useRegex) flags.push('Re');
                if (entry.matchCase) flags.push('Cs');
                if (entry.wholeWord) flags.push('Wd');
                if (entry.preserveCase) flags.push('Pc');
                if (entry.inSelection) flags.push('Sel');
                var flagStr = flags.length > 0 ? ' [' + flags.join(',') + ']' : '';
                if (entry.name) {
                    var nameSpan = document.createElement('span');
                    nameSpan.className = 'history-name';
                    nameSpan.textContent = entry.name;
                    item.appendChild(nameSpan);
                    item.appendChild(document.createTextNode(': ' + truncateText(entry.findText, 30) + ' '));
                    var arrowSpan = document.createElement('span');
                    arrowSpan.className = 'history-arrow';
                    arrowSpan.textContent = '\u2192';
                    item.appendChild(arrowSpan);
                    item.appendChild(document.createTextNode(' ' + truncateText(entry.replaceText, 20) + flagStr));
                } else {
                    item.appendChild(document.createTextNode(truncateText(entry.findText, 30) + ' '));
                    var arrowSpan2 = document.createElement('span');
                    arrowSpan2.className = 'history-arrow';
                    arrowSpan2.textContent = '\u2192';
                    item.appendChild(arrowSpan2);
                    item.appendChild(document.createTextNode(' ' + truncateText(entry.replaceText, 20) + flagStr));
                }
                historyListEl.appendChild(item);
            }
        }

        historyTrigger.addEventListener('click', function() {
            if (dropdownOpen) closeDropdown();
            else openDropdown();
        });

        historyListEl.addEventListener('click', function(e) {
            var item = e.target.closest('.dropdown-item');
            if (!item) return;
            var idx = parseInt(item.dataset.index, 10);
            if (isNaN(idx) || idx < 0 || idx >= historyList.length) return;
            selectedHistoryIdx = idx;
            var entry = historyList[idx];
            state = Object.assign({}, state, entry);
            vscodeApi.setState(state);
            vscodeApi.postMessage({ type: 'loadHistory', payload: entry });
            render();
            closeDropdown();
        });

        historyListEl.addEventListener('mousemove', function(e) {
            var item = e.target.closest('.dropdown-item');
            if (!item) return;
            highlightedIdx = parseInt(item.dataset.index, 10);
            applyHighlight();
        });

        document.addEventListener('click', function(e) {
            if (!dropdownOpen) return;
            var dropdown = document.getElementById('historyDropdown');
            if (!dropdown.contains(e.target)) closeDropdown();
        });

        findText.addEventListener('focus', function() { vscodeApi.postMessage({ type: 'findInputFocused' }); });
        findText.addEventListener('blur', function() { vscodeApi.postMessage({ type: 'findInputBlurred' }); });

        findText.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                findText.value = '';
                pushState({ findText: '' });
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                vscodeApi.postMessage({ type: 'findNext' });
            }
        });
        replaceText.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                replaceText.value = '';
                pushState({ replaceText: '' });
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                vscodeApi.postMessage({ type: 'findNext' });
            }
        });

        findText.addEventListener('input', function() { pushState({ findText: findText.value }); });
        replaceText.addEventListener('input', function() { pushState({ replaceText: replaceText.value }); });

        document.getElementById('findFirst').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findFirst' }); });
        document.getElementById('findNext').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findNext' }); });
        document.getElementById('findPrevious').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findPrevious' }); });
        document.getElementById('findPrevious10').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findPrevious10' }); });
        document.getElementById('findNext10').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findNext10' }); });
        document.getElementById('replaceOne').addEventListener('click', function(e) { vscodeApi.postMessage({ type: e.ctrlKey ? 'findNext' : e.altKey ? 'replaceOneStay' : 'replaceOne' }); });
        document.getElementById('replaceOne10').addEventListener('click', function() { vscodeApi.postMessage({ type: 'replaceOne10' }); });
        document.getElementById('replaceAll').addEventListener('click', function() { vscodeApi.postMessage({ type: 'replaceAll' }); });
        document.getElementById('saveToHistory').addEventListener('click', function() { vscodeApi.postMessage({ type: 'saveToHistory' }); });

        historyTrigger.addEventListener('keydown', function(e) {
            if (!dropdownOpen) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDropdown();
                }
                return;
            }
            handleDropdownKeydown(e);
        });

        function handleDropdownKeydown(e) {
            var itemCount = historyList.length;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                highlightedIdx = (highlightedIdx + 1) % itemCount;
                applyHighlight();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                highlightedIdx = highlightedIdx <= 0 ? itemCount - 1 : highlightedIdx - 1;
                applyHighlight();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightedIdx >= 0 && highlightedIdx < itemCount) {
                    selectedHistoryIdx = highlightedIdx;
                    var entry = historyList[highlightedIdx];
                    state = Object.assign({}, state, entry);
                    vscodeApi.setState(state);
                    vscodeApi.postMessage({ type: 'loadHistory', payload: entry });
                    render();
                    closeDropdown();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeDropdown();
            } else if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                e.stopPropagation();
                if (highlightedIdx < 0 || highlightedIdx >= itemCount) return;
                var nextIdx = highlightedIdx < itemCount - 1 ? highlightedIdx : highlightedIdx - 1;
                pendingHistoryReopen = true;
                pendingHistoryIndex = nextIdx;
                vscodeApi.postMessage({ type: 'deleteHistory', payload: { index: highlightedIdx } });
            } else if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                e.stopPropagation();
                if (highlightedIdx < 0 || highlightedIdx >= itemCount) return;
                pendingHistoryReopen = true;
                pendingHistoryIndex = highlightedIdx;
                vscodeApi.postMessage({ type: 'renameHistory', payload: { index: highlightedIdx } });
            }
        }

        controls.useRegex.addEventListener('change', function() { toggleOption('useRegex'); });
        controls.matchCase.addEventListener('change', function() { toggleOption('matchCase'); });
        controls.wholeWord.addEventListener('change', function() { toggleOption('wholeWord'); });
        controls.preserveCase.addEventListener('change', function() {
            if (!state.useRegex) {
                toggleOption('preserveCase');
            }
        });
        controls.inSelection.addEventListener('change', function() {
            if (state.canUseSelection || state.inSelection) {
                toggleOption('inSelection');
            }
        });

        var pendingHistoryReopen = false;
        var pendingHistoryIndex = -1;

        window.addEventListener('message', function(event) {
            if (event.data && event.data.type === 'state') {
                state = event.data.payload;
                vscodeApi.setState(state);
                render();
            }
            if (event.data && event.data.type === 'focusFindInput') {
                findText.focus();
            }
            if (event.data && event.data.type === 'recentTexts') {
                recentFinds = event.data.payload.finds || [];
                recentReplaces = event.data.payload.replaces || [];
            }
            if (event.data && event.data.type === 'history') {
                historyList = event.data.payload || [];
                renderHistory();
                if (pendingHistoryReopen && historyList.length > 0) {
                    pendingHistoryReopen = false;
                    highlightedIdx = pendingHistoryIndex >= 0 && pendingHistoryIndex < historyList.length ? pendingHistoryIndex : 0;
                    pendingHistoryIndex = -1;
                    openDropdown();
                    applyHighlight();
                } else {
                    pendingHistoryReopen = false;
                    pendingHistoryIndex = -1;
                }
            }
        });

        var contextMenuEl = document.getElementById('contextMenu');
        var contextMenuTarget = null;

        function showContextMenu(targetTextarea, items, x, y) {
            contextMenuTarget = targetTextarea;
            contextMenuEl.innerHTML = '';
            if (items.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'context-menu-empty';
                empty.textContent = 'No recent entries';
                contextMenuEl.appendChild(empty);
            } else {
                for (var i = 0; i < items.length; i++) {
                    var item = document.createElement('div');
                    item.className = 'context-menu-item';
                    item.dataset.index = String(i);
                    var display = items[i].length > 80 ? items[i].substring(0, 80) + '...' : items[i];
                    item.textContent = display;
                    item.title = items[i];
                    contextMenuEl.appendChild(item);
                }
            }
            contextMenuEl.style.left = x + 'px';
            contextMenuEl.style.top = y + 'px';
            contextMenuEl.classList.add('open');
            var rect = contextMenuEl.getBoundingClientRect();
            if (rect.bottom > window.innerHeight) {
                contextMenuEl.style.top = Math.max(0, window.innerHeight - rect.height) + 'px';
            }
            if (rect.right > window.innerWidth) {
                contextMenuEl.style.left = Math.max(0, window.innerWidth - rect.width) + 'px';
            }
        }

        function closeContextMenu() {
            contextMenuEl.classList.remove('open');
            contextMenuTarget = null;
        }

        findText.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            showContextMenu(findText, recentFinds, e.clientX, e.clientY);
        });

        replaceText.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            showContextMenu(replaceText, recentReplaces, e.clientX, e.clientY);
        });

        contextMenuEl.addEventListener('click', function(e) {
            var item = e.target.closest('.context-menu-item');
            if (!item || !contextMenuTarget) return;
            var idx = parseInt(item.dataset.index, 10);
            var items = contextMenuTarget === findText ? recentFinds : recentReplaces;
            if (isNaN(idx) || idx < 0 || idx >= items.length) return;
            contextMenuTarget.value = items[idx];
            if (contextMenuTarget === findText) {
                pushState({ findText: items[idx] });
            } else {
                pushState({ replaceText: items[idx] });
            }
            contextMenuTarget.focus();
            closeContextMenu();
        });

        document.addEventListener('click', function(e) {
            if (!contextMenuEl.contains(e.target)) {
                closeContextMenu();
            }
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                closeContextMenu();
            }
        });

        render();
        renderHistory();
        vscodeApi.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    private createNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let value = '';
        for (let index = 0; index < 32; index += 1) {
            value += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return value;
    }
}