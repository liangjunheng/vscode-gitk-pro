import * as vscode from 'vscode';
import { invokeNativeGit } from '../git/nativeGitBinding';
import { createMergePlan, type MergePlan } from './mergeEditor';

interface MergeData {
    stages: Array<{ oid: string; mode: number; content: string } | null>;
    worktree: string | null;
}
export interface MergeSnapshot {
    type: 'snapshot'; path: string; base: string; current: string; incoming: string; plan: MergePlan;
    /** Pure diff3 output, independent of pre-existing working-tree conflict markers. */
    automaticPlan: MergePlan;
}
interface Session {
    id: number; repositoryPath: string; path: string; data: MergeData;
    snapshot: MergeSnapshot; busy: boolean; draft?: string; saved?: string;
}

/** Host-side conflict sessions for embedded MultiDiff cards, with no independent WebviewPanel. */
export class MergeEditorSessions implements vscode.Disposable {
    private readonly sessions = new Map<number, Session>();
    private nextId = 0;
    constructor(private readonly onComplete: (repositoryPath: string) => Promise<void>) {}

    async load(repositoryPath: string, filePath: string): Promise<{ sessionId: number; snapshot: MergeSnapshot }> {
        const root = vscode.Uri.parse(repositoryPath);
        const data = await invokeNativeGit<MergeData>('readMergeConflict', { rootPath: root.fsPath, path: filePath });
        const [base, current, incoming] = data.stages.map(stage => stage?.content ?? '');
        const automaticPlan = createMergePlan(base, current, incoming);
        const snapshot: MergeSnapshot = { type: 'snapshot', path: filePath, base, current, incoming,
            plan: createMergePlan(base, current, incoming, data.worktree ?? undefined), automaticPlan };
        const session: Session = { id: ++this.nextId, repositoryPath, path: filePath, data, snapshot, busy: false };
        this.sessions.set(session.id, session);
        return { sessionId: session.id, snapshot };
    }

    async save(sessionId: number, content: string, complete: boolean, remaining: number): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) { throw new Error('Merge session expired. Reload this conflict.'); }
        if (session.busy) { throw new Error('Merge save is already running.'); }
        if (complete && remaining !== 0) { throw new Error('Resolve all conflicts before completing the merge.'); }
        const root = vscode.Uri.parse(session.repositoryPath);
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === vscode.Uri.joinPath(root, ...session.path.split('/')).toString());
        if (document?.isDirty) { throw new Error('Save the open text document before saving this merge result.'); }
        session.busy = true;
        try {
            const saved = await invokeNativeGit<{ worktree: string }>('saveMergeResult', {
                rootPath: root.fsPath, path: session.path, ...session.data, content, complete,
            });
            session.data.worktree = saved.worktree;
            session.saved = content;
            session.draft = undefined;
            if (complete) {
                this.sessions.delete(sessionId);
                await this.onComplete(session.repositoryPath);
            }
        } catch (error) {
            // Failed index writes may already have saved the worktree. Keep a valid retry token.
            try {
                const actual = await invokeNativeGit<MergeData>('readMergeConflict', { rootPath: root.fsPath, path: session.path });
                if (actual.worktree?.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')
                    && JSON.stringify(actual.stages) === JSON.stringify(session.data.stages)) { session.data = actual; }
            } catch { /* Preserve the original save error. */ }
            throw error;
        } finally { session.busy = false; }
    }

    setDraft(sessionId: number, content: string): void {
        const session = this.sessions.get(sessionId);
        if (session) { session.draft = content; }
    }
    release(sessionId: number): void {
        const session = this.sessions.get(sessionId);
        if (!session || session.busy) { return; }
        this.sessions.delete(sessionId);
        if (session.draft === undefined || session.draft === (session.saved ?? session.snapshot.plan.result)) { return; }
        void vscode.window.showWarningMessage(`Unsaved merge result: ${session.path}`, 'Recover Result').then(async action => {
            if (action !== 'Recover Result') { return; }
            const document = await vscode.workspace.openTextDocument({ content: session.draft });
            await vscode.window.showTextDocument(document);
        });
    }
    dispose(): void { this.sessions.clear(); }
}
