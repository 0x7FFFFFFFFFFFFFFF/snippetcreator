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
        statusMessage: ''
    };

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.syncSelectionAvailability();
                this.refreshMatches();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor === vscode.window.activeTextEditor) {
                    this.syncSelectionAvailability();
                    this.refreshMatches();
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                const activeEditor = vscode.window.activeTextEditor;
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
                }
            }),
            webviewView.webview.onDidReceiveMessage(async message => {
                await this.handleMessage(message);
            })
        );

        this.syncSelectionAvailability();
        this.postState();
        this.refreshMatches();
    }

    public async toggleVisibility(): Promise<void> {
        if (this.view?.visible) {
            await vscode.commands.executeCommand('workbench.action.closeSidebar');
            return;
        }

        this.prefillFindFromSelection(true);
        await vscode.commands.executeCommand(`workbench.view.extension.${LargeFindReplaceViewProvider.containerId}`);
        this.view?.show(false);
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
                break;
            case 'updateState':
                this.state = {
                    ...this.state,
                    ...message.payload,
                    preserveCase: message.payload?.useRegex ? false : (message.payload?.preserveCase ?? this.state.preserveCase)
                };
                this.refreshMatches();
                break;
            case 'findNext':
                await this.selectAdjacentMatch(1);
                break;
            case 'findPrevious':
                await this.selectAdjacentMatch(-1);
                break;
            case 'replaceOne':
                await this.replaceCurrentMatch();
                break;
            case 'replaceAll':
                await this.replaceAllMatches();
                break;
            case 'syncSelection':
                this.prefillFindFromSelection(true);
                this.refreshMatches();
                break;
            default:
                break;
        }
    }

    private getActiveEditor(): vscode.TextEditor | undefined {
        return vscode.window.activeTextEditor;
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
        const sourceText = this.state.useRegex ? this.state.findText : this.escapeRegExp(this.state.findText);
        const wrappedSource = this.state.wholeWord ? this.wrapWholeWord(sourceText) : sourceText;
        const flags = `g${this.state.matchCase ? '' : 'i'}m`;

        try {
            return new RegExp(wrappedSource, flags);
        } catch (error) {
            throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private createSingleMatchRegExp(): RegExp {
        const sourceText = this.state.useRegex ? this.state.findText : this.escapeRegExp(this.state.findText);
        const wrappedSource = this.state.wholeWord ? this.wrapWholeWord(sourceText) : sourceText;
        const flags = `${this.state.matchCase ? '' : 'i'}m`;
        return new RegExp(wrappedSource, flags);
    }

    private wrapWholeWord(source: string): string {
        const startsWithWord = /^\w/.test(this.state.findText);
        const endsWithWord = /\w$/.test(this.state.findText);
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

    private async replaceCurrentMatch(): Promise<void> {
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
        await editor.edit(editBuilder => {
            editBuilder.replace(selectedMatch.range, replacement);
        });

        await this.selectAdjacentMatch(1);
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
            min-height: 150px;
            resize: vertical;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 6px 8px;
            font: inherit;
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

        .action {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .action:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .action[disabled] {
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
            <button class="action" id="findPrevious">Find Previous</button>
            <button class="action" id="findNext">Find Next</button>
            <button class="secondary" id="replaceOne">Replace</button>
            <button class="secondary" id="replaceAll">Replace All</button>
            <button class="secondary" id="syncSelection">Use Current Selection</button>
        </div>

        <div class="hint">Literal search is used whenever Regex is disabled. Replace supports multi-line text, wrapped display, and standard replacement escapes such as \\n and \\t.</div>
        <div class="status" id="status"></div>
    </div>

    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        const initialState = ${initialState};
        let state = vscodeApi.getState() || initialState;

        const findText = document.getElementById('findText');
        const replaceText = document.getElementById('replaceText');
        const counter = document.getElementById('counter');
        const status = document.getElementById('status');
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

        findText.addEventListener('input', function() { pushState({ findText: findText.value }); });
        replaceText.addEventListener('input', function() { pushState({ replaceText: replaceText.value }); });

        document.getElementById('findNext').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findNext' }); });
        document.getElementById('findPrevious').addEventListener('click', function() { vscodeApi.postMessage({ type: 'findPrevious' }); });
        document.getElementById('replaceOne').addEventListener('click', function() { vscodeApi.postMessage({ type: 'replaceOne' }); });
        document.getElementById('replaceAll').addEventListener('click', function() { vscodeApi.postMessage({ type: 'replaceAll' }); });
        document.getElementById('syncSelection').addEventListener('click', function() { vscodeApi.postMessage({ type: 'syncSelection' }); });

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

        window.addEventListener('message', function(event) {
            if (event.data && event.data.type === 'state') {
                state = event.data.payload;
                vscodeApi.setState(state);
                render();
            }
        });

        render();
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