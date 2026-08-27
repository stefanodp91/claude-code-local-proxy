/**
 * vscode.ts — the smallest stand-in for the editor API the host code touches.
 *
 * Only the surface `chat-session.ts` actually calls is here, and each function
 * records what it was asked to do so a test can assert on it. Anything else is
 * deliberately absent: a stub that grows to cover the whole API becomes a
 * second implementation of VS Code, and a fake more forgiving than the real
 * thing is how three bugs have shipped in this repo already.
 *
 * `npm run typecheck` does NOT use this file — it resolves `vscode` to
 * `@types/vscode`, so a call that does not exist in the real API still fails
 * there. Only `tsconfig.test.json` maps the module here.
 *
 * @module test/stubs/vscode
 */

export interface Recorded {
  info: string[];
  error: string[];
  opened: string[];
  executed: { command: string; args: unknown[] }[];
  terminals: string[];
  terminalInput: string[];
}

export const recorded: Recorded = {
  info: [], error: [], opened: [], executed: [], terminals: [], terminalInput: [],
};

export function resetRecorded(): void {
  recorded.info.length = 0;
  recorded.error.length = 0;
  recorded.opened.length = 0;
  recorded.executed.length = 0;
  recorded.terminals.length = 0;
  recorded.terminalInput.length = 0;
}

export const window = {
  showInformationMessage(msg: string) { recorded.info.push(msg); return Promise.resolve(undefined); },
  showErrorMessage(msg: string) { recorded.error.push(msg); return Promise.resolve(undefined); },
  showWarningMessage(msg: string) { recorded.info.push(msg); return Promise.resolve(undefined); },
  createOutputChannel() {
    return { appendLine() {}, show() {}, dispose() {} };
  },
  showTextDocument() { return Promise.resolve(undefined); },
  activeTextEditor: undefined as unknown,
  createTerminal(opts: unknown) {
    recorded.terminals.push(typeof opts === "string" ? opts : JSON.stringify(opts));
    return { sendText(text: string) { recorded.terminalInput.push(text); }, show() {}, dispose() {} };
  },
};

export const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string } }[],
  textDocuments: [] as { uri: { fsPath: string }; getText(): string }[],
  asRelativePath: (p: string | { fsPath: string }) => (typeof p === "string" ? p : p.fsPath),
  onDidChangeConfiguration(_listener: (e: { affectsConfiguration(section: string): boolean }) => void) {
    return { dispose() {} };
  },
  getConfiguration() {
    return { get: (_key: string, fallback?: unknown) => fallback, update() { return Promise.resolve(); } };
  },
  openTextDocument(arg: unknown) {
    recorded.opened.push(typeof arg === "string" ? arg : JSON.stringify(arg));
    return Promise.resolve({});
  },
  fs: {
    readFile() { return Promise.resolve(new Uint8Array()); },
    writeFile() { return Promise.resolve(); },
  },
};

export const commands = {
  executeCommand(command: string, ...args: unknown[]) {
    recorded.executed.push({ command, args });
    return Promise.resolve(undefined);
  },
  registerCommand() { return { dispose() {} }; },
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, path: p, scheme: "file", toString: () => p }),
  parse: (p: string) => ({ fsPath: p, path: p, scheme: "file", toString: () => p }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => Uri.file([base.fsPath, ...parts].join("/")),
};

export const ViewColumn = { One: 1, Two: 2, Beside: -2 };

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(e: T): void { for (const l of [...this.listeners]) l(e); }
  dispose(): void { this.listeners.length = 0; }
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => {}) {}
  dispose(): void { this.callOnDispose(); }
}

export const env = {
  clipboard: { writeText: () => Promise.resolve() },
  language: "en",
};

export default { window, workspace, commands, Uri, ViewColumn, EventEmitter, Disposable, env };
