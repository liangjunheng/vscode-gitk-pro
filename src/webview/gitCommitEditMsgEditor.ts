import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { readCommitHistoryMessages, readCurrentCommitMessage, type CommitHistoryMessage } from '../git/gitLogProvider';
import { commitWithMessage } from '../git/gitCommitService';
import { configGet } from '../git/gitNativeOperations';

type HistoryMessage = CommitHistoryMessage;

interface CommitEditSession {
    readonly rootUri: vscode.Uri;
    readonly documentUri: vscode.Uri;
    readonly amend: boolean;
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

    constructor(_extensionPath: string) {
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
        if (this.startingRepositories.has(repositoryKey) || this.sessions.has(repositoryKey)) {
            throw new Error('该仓库已有正在进行的提交编辑会话。');
        }
        this.startingRepositories.add(repositoryKey);
        let resolveEditor!: (accepted: boolean) => void;
        let rejectEditor!: (reason?: unknown) => void;
        const completed = new Promise<boolean>((resolve, reject) => { resolveEditor = resolve; rejectEditor = reject; });
        try {
            const commentChar = await this.readCommentChar(rootUri);
            const initialMessage = amend ? await readCurrentCommitMessage(rootUri) : '';
            const filePath = path.join(os.tmpdir(), `vscode-gitk-COMMIT_EDITMSG-${randomUUID()}`);
            const help = [
                `${commentChar} 请输入提交说明。以 ${commentChar} 开头的行不会进入提交信息。`,
                `${commentChar} 使用 Ctrl+Enter 提交，Esc 取消。`,
            ].join('\n');
            await fs.writeFile(filePath, `${initialMessage}${initialMessage ? '\n\n' : ''}${help}\n`, 'utf8');
            const documentUri = vscode.Uri.file(filePath);
            const openedDocument = await vscode.workspace.openTextDocument(documentUri);
            const document = await vscode.languages.setTextDocumentLanguage(openedDocument, 'COMMIT_MSG_EDITOR');
            this.sessions.set(repositoryKey, { rootUri, documentUri, amend, resolveEditor, completing: false });
            await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false });
            await this.updateActiveContext();
            return { opened: Promise.resolve(), completed };
        } catch (error) {
            rejectEditor(error);
            throw error;
        } finally {
            this.startingRepositories.delete(repositoryKey);
        }
    }

    dispose(): void {
        for (const session of [...this.sessions.values()]) { this.finishSession(session, false); }
        for (const disposable of this.disposables) { disposable.dispose(); }
        void vscode.commands.executeCommand('setContext', 'gitk:commitEditMsgActive', false);
    }

    private async completeActiveSession(): Promise<void> {
        const session = this.getActiveSession();
        if (!session || session.completing) { return; }
        session.completing = true;
        try {
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === session.documentUri.toString());
            if (!document || !(await document.save())) { throw new Error('COMMIT_EDITMSG 保存失败'); }
            const commentChar = await this.readCommentChar(session.rootUri);
            const range = this.getMessageRange(document, commentChar);
            const message = document.getText(range).replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (!message.trim()) { throw new Error('提交信息不能为空'); }
            await commitWithMessage(session.rootUri, message, session.amend);
            this.finishSession(session, true);
            await this.closeDocumentTab(session.documentUri);
        } catch (error) {
            session.completing = false;
            vscode.window.setStatusBarMessage(`$(warning) Git Commit 失败：${error instanceof Error ? error.message : String(error)}`, 4000);
        }
    }

    private async fillHistoryMessage(): Promise<void> {
        const session = this.getActiveSession();
        if (!session || session.completing) { return; }
        const [history, commentChar] = await Promise.all([this.readHistoryMessages(session.rootUri), this.readCommentChar(session.rootUri)]);
        if (history.length === 0) {
            void vscode.window.showInformationMessage('当前仓库没有可复用的历史提交信息。');
            return;
        }
        const picked = await vscode.window.showQuickPick(history.map(item => ({
            label: item.subject,
            description: item.shortHash,
            detail: item.message.includes('\n') ? item.message.split('\n').slice(1).join(' ').trim() : undefined,
            message: item.message,
        })), { title: '选择历史提交信息', placeHolder: '选中后替换当前提交信息', matchOnDescription: true, matchOnDetail: true });
        if (!picked) { return; }
        const document = await vscode.workspace.openTextDocument(session.documentUri);
        const messageRange = this.getMessageRange(document, commentChar);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, messageRange, `${picked.message}\n\n`);
        if (!await vscode.workspace.applyEdit(edit)) {
            vscode.window.setStatusBarMessage('$(warning) 历史提交信息填充失败', 3000);
        }
    }

    private readHistoryMessages(rootUri: vscode.Uri): Promise<HistoryMessage[]> { return readCommitHistoryMessages(rootUri); }

    private async readCommentChar(rootUri: vscode.Uri): Promise<string> {
        const value = (await configGet(rootUri, 'core.commentChar', '#')).trim();
        return !value || value === 'auto' ? '#' : value;
    }

    private getMessageRange(document: vscode.TextDocument, commentChar: string): vscode.Range {
        const start = new vscode.Position(0, 0);
        for (let line = 0; line < document.lineCount; line++) {
            if (document.lineAt(line).text.startsWith(commentChar)) { return new vscode.Range(start, new vscode.Position(line, 0)); }
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
            const input = tab.input;
            if (!(input instanceof vscode.TabInputText)) { continue; }
            const session = [...this.sessions.values()].find(candidate => candidate.documentUri.toString() === input.uri.toString());
            if (session) { this.finishSession(session, false); }
        }
    }

    private getActiveSession(): CommitEditSession | undefined {
        const uri = vscode.window.activeTextEditor?.document.uri;
        return uri ? [...this.sessions.values()].find(session => session.documentUri.toString() === uri.toString()) : undefined;
    }

    private async updateActiveContext(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitk:commitEditMsgActive', Boolean(this.getActiveSession()));
    }

    private finishSession(session: CommitEditSession, accepted: boolean): void {
        if (!this.sessions.delete(session.rootUri.toString())) { return; }
        session.resolveEditor(accepted);
        void fs.rm(session.documentUri.fsPath, { force: true });
        void this.updateActiveContext();
    }

    private async closeDocumentTab(uri: vscode.Uri): Promise<void> {
        for (const group of vscode.window.tabGroups.all) {
            const tab = group.tabs.find(candidate => candidate.input instanceof vscode.TabInputText && candidate.input.uri.toString() === uri.toString());
            if (tab) { await vscode.window.tabGroups.close(tab); return; }
        }
    }
}