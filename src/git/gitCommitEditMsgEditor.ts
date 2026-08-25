import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { readCommitHistoryMessages, runGitReadCommand, type CommitHistoryMessage } from './gitLogProvider';

type HistoryMessage = CommitHistoryMessage;

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
    private readonly startingRepositories = new Set<string>();
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly extensionPath: string) {
        this.disposables = [
            vscode.commands.registerCommand('vscode-gitk.commitEditMsg.history', () => this.fillHistoryMessage()),
            vscode.commands.registerCommand('vscode-gitk.commitEditMsg.complete', () => this.completeActiveSession()),
            vscode.commands.registerCommand('vscode-gitk.commitEditMsg.cancel', () => this.cancelActiveSession()),
            vscode.window.tabGroups.onDidChangeTabs(event => this.handleTabsClosed(event.closed)),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveContext()),
        ];
    }

    async edit(rootUri: vscode.Uri, amend: boolean): Promise<GitCommitEditMsgSession> {
        const repositoryKey = rootUri.toString();
        if (this.startingRepositories.has(repositoryKey)
            || [...this.sessions.values()].some(session => session.rootUri.toString() === repositoryKey)) {
            throw new Error('该仓库已有正在进行的提交编辑会话。');
        }
        this.startingRepositories.add(repositoryKey);
        const pipeName = `\\\\.\\pipe\\vscode-gitk-${process.pid}-${randomUUID()}`;
        const server = net.createServer();
        const editorReady = new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(pipeName, resolve);
        });
        try {
            await editorReady;
        } catch (error) {
            this.startingRepositories.delete(repositoryKey);
            server.close();
            throw error;
        }
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
                this.startingRepositories.delete(repositoryKey);
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
        const opened = await vscode.workspace.openTextDocument(documentUri);
        // 语言不通过 filenames 关联, 避免与内置 Git 争抢 COMMIT_EDITMSG; 由本扩展打开时显式指定。
        const document = await vscode.languages.setTextDocumentLanguage(opened, 'COMMIT_MSG_EDITOR');
        this.sessions.set(rootUri.toString(), { rootUri, documentUri, socket, resolveEditor, completing: false });
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

    /** 用历史提交信息替换当前 COMMIT_EDITMSG 的消息区, 保留 Git 写入的注释块。 */
    private async fillHistoryMessage(): Promise<void> {
        const session = this.getActiveSession();
        if (!session || session.completing) { return; }
        const [history, commentChar] = await Promise.all([
            this.readHistoryMessages(session.rootUri),
            this.readCommentChar(session.rootUri),
        ]);
        if (history.length === 0) {
            void vscode.window.showInformationMessage('当前仓库没有可复用的历史提交信息。');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            history.map(item => ({
                label: item.subject,
                description: item.shortHash,
                detail: item.message.includes('\n') ? item.message.split('\n').slice(1).join(' ').trim() : undefined,
                message: item.message,
            })),
            { title: '选择历史提交信息', placeHolder: '选中后替换当前提交信息', matchOnDescription: true, matchOnDetail: true },
        );
        if (!picked) { return; }
        const document = await vscode.workspace.openTextDocument(session.documentUri);
        const messageRange = this.getMessageRange(document, commentChar);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, messageRange, `${picked.message}\n${messageRange.end.line < document.lineCount - 1 ? '\n' : ''}`);
        if (!await vscode.workspace.applyEdit(edit)) {
            vscode.window.setStatusBarMessage('$(warning) 历史提交信息填充失败', 3000);
            return;
        }
        const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.toString() === session.documentUri.toString());
        if (editor) {
            const cursor = document.lineAt(Math.min(picked.message.split('\n').length - 1, document.lineCount - 1)).range.end;
            editor.selection = new vscode.Selection(cursor, cursor);
        }
    }

    private readHistoryMessages(rootUri: vscode.Uri): Promise<HistoryMessage[]> {
        return readCommitHistoryMessages(rootUri);
    }

    /**
     * 读取注释字符; core.commentChar=auto 时 Git 优先使用 '#',
     * 仅当消息行以 '#' 开头才改选其他字符, 此处按其首选值处理。
     */
    private async readCommentChar(rootUri: vscode.Uri): Promise<string> {
        const value = (await runGitReadCommand(rootUri, ['config', '--default', '#', '--get', 'core.commentChar'])).trim();
        return !value || value === 'auto' ? '#' : value;
    }

    /** 消息区为文档开头到首个注释行之前的范围。 */
    private getMessageRange(document: vscode.TextDocument, commentChar: string): vscode.Range {
        const start = new vscode.Position(0, 0);
        for (let line = 0; line < document.lineCount; line++) {
            if (document.lineAt(line).text.startsWith(commentChar)) {
                return new vscode.Range(start, new vscode.Position(line, 0));
            }
        }
        return new vscode.Range(start, document.lineAt(document.lineCount - 1).range.end);
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
            const documentUri = tab.input.uri;
            const session = [...this.sessions.values()].find(candidate => candidate.documentUri.toString() === documentUri.toString());
            if (session) { this.finishSession(session, false); }
        }
    }

    private getActiveSession(): CommitEditSession | undefined {
        const uri = vscode.window.activeTextEditor?.document.uri;
        return uri
            ? [...this.sessions.values()].find(session => session.documentUri.toString() === uri.toString())
            : undefined;
    }

    private async updateActiveContext(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitk:commitEditMsgActive', Boolean(this.getActiveSession()));
    }

    private finishSession(session: CommitEditSession, accepted: boolean): void {
        const repositoryPath = session.rootUri.toString();
        if (!this.sessions.delete(repositoryPath)) { return; }
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
