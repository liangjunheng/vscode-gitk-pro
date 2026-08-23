import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

interface CommitEditSession {
    readonly rootUri: vscode.Uri;
    readonly documentUri: vscode.Uri;
    readonly socket: net.Socket;
    readonly resolveEditor: (accepted: boolean) => void;
    completing: boolean;
}

export interface GitCommitEditMsgSession {
    readonly opened: Promise<void>;
    readonly completed: Promise<boolean>;
}

export class GitCommitEditMsgEditor implements vscode.Disposable {
    private readonly sessions = new Map<string, CommitEditSession>();
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly extensionPath: string) {
        this.disposables = [
            vscode.commands.registerCommand('vscode-gitk.commitEditMsg.complete', () => this.completeActiveSession()),
            vscode.commands.registerCommand('vscode-gitk.commitEditMsg.cancel', () => this.cancelActiveSession()),
            vscode.window.tabGroups.onDidChangeTabs(event => this.handleTabsClosed(event.closed)),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveContext()),
        ];
    }

    async edit(rootUri: vscode.Uri, amend: boolean): Promise<GitCommitEditMsgSession> {
        if ([...this.sessions.values()].some(session => session.rootUri.toString() === rootUri.toString())) {
            throw new Error('该仓库已有正在进行的提交编辑会话。');
        }
        const pipeName = `\\\\.\\pipe\\vscode-gitk-${process.pid}-${randomUUID()}`;
        const server = net.createServer();
        const editorReady = new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(pipeName, resolve);
        });
        await editorReady;
        let resolveOpened!: () => void;
        let rejectOpened!: (reason?: unknown) => void;
        const opened = new Promise<void>((resolve, reject) => {
            resolveOpened = resolve;
            rejectOpened = reject;
        });
        let rejectEditorSession!: (reason?: unknown) => void;
        const editorSession = new Promise<boolean>((resolve, reject) => {
            rejectEditorSession = reject;
            server.once('connection', socket => {
                let payload = '';
                socket.setEncoding('utf8');
                socket.on('data', chunk => {
                    payload += chunk;
                    const separator = payload.indexOf('\n');
                    if (separator < 0) { return; }
                    socket.removeAllListeners('data');
                    void this.openEditorSession(rootUri, payload.slice(0, separator), socket, resolve)
                        .then(resolveOpened, error => {
                            rejectOpened(error);
                            reject(error);
                        });
                });
            });
        });
        const bridgePath = path.join(this.extensionPath, 'out', 'git', 'gitCommitEditMsgEditorBridge.js');
        const editorCommand = [process.execPath, bridgePath].map(value => `"${value.replace(/"/g, '\\"')}"`).join(' ');
        const git = spawn('git', ['-C', rootUri.fsPath, 'commit', ...(amend ? ['--amend'] : [])], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                GIT_EDITOR: editorCommand,
                VSCODE_GITK_EDITOR_PIPE: pipeName,
            },
        });
        let stderr = '';
        git.stderr.setEncoding('utf8');
        git.stderr.on('data', chunk => { stderr += chunk; });
        const gitResult = new Promise<void>((resolve, reject) => {
            git.once('error', reject);
            git.once('close', code => {
                if (code === 0) { resolve(); }
                else { reject(new Error(stderr.trim() || `git commit 退出，代码 ${code}`)); }
            });
        });
        void gitResult.catch(error => {
            rejectOpened(error);
            rejectEditorSession(error);
        });
        const completed = (async () => {
            try {
                const accepted = await editorSession;
                if (!accepted) {
                    await gitResult.catch(() => undefined);
                    return false;
                }
                await gitResult;
                return true;
            } finally {
                server.close();
            }
        })();
        return { opened, completed };
    }

    dispose(): void {
        for (const session of [...this.sessions.values()]) {
            this.finishSession(session, false);
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        void vscode.commands.executeCommand('setContext', 'gitk:commitEditMsgActive', false);
    }

    private async openEditorSession(
        rootUri: vscode.Uri,
        filePath: string,
        socket: net.Socket,
        resolveEditor: (accepted: boolean) => void,
    ): Promise<void> {
        const documentUri = vscode.Uri.file(filePath);
        const key = documentUri.toString();
        const document = await vscode.workspace.openTextDocument(documentUri);
        this.sessions.set(key, { rootUri, documentUri, socket, resolveEditor, completing: false });
        await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: false,
            preview: false,
        });
        await this.updateActiveContext();
    }

    private async completeActiveSession(): Promise<void> {
        const session = this.getActiveSession();
        if (!session || session.completing) { return; }
        session.completing = true;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === session.documentUri.toString());
        if (!document || !(await document.save())) {
            session.completing = false;
            vscode.window.setStatusBarMessage('$(warning) COMMIT_EDITMSG 保存失败', 3000);
            return;
        }
        this.finishSession(session, true);
        await this.closeDocumentTab(session.documentUri);
    }

    private async cancelActiveSession(): Promise<void> {
        const session = this.getActiveSession();
        if (!session || session.completing) { return; }
        this.finishSession(session, false);
        await this.closeDocumentTab(session.documentUri);
    }

    private handleTabsClosed(tabs: readonly vscode.Tab[]): void {
        for (const tab of tabs) {
            if (!(tab.input instanceof vscode.TabInputText)) { continue; }
            const session = this.sessions.get(tab.input.uri.toString());
            if (session) { this.finishSession(session, false); }
        }
    }

    private getActiveSession(): CommitEditSession | undefined {
        const uri = vscode.window.activeTextEditor?.document.uri;
        return uri ? this.sessions.get(uri.toString()) : undefined;
    }

    private async updateActiveContext(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitk:commitEditMsgActive', Boolean(this.getActiveSession()));
    }

    private finishSession(session: CommitEditSession, accepted: boolean): void {
        const key = session.documentUri.toString();
        if (!this.sessions.delete(key)) { return; }
        session.socket.end(accepted ? 'commit\n' : 'cancel\n');
        session.resolveEditor(accepted);
        void this.updateActiveContext();
    }

    private async closeDocumentTab(uri: vscode.Uri): Promise<void> {
        for (const group of vscode.window.tabGroups.all) {
            const tab = group.tabs.find(candidate => candidate.input instanceof vscode.TabInputText
                && candidate.input.uri.toString() === uri.toString());
            if (tab) {
                await vscode.window.tabGroups.close(tab);
                return;
            }
        }
    }
}
