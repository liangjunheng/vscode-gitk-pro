import * as vscode from 'vscode';
import type { AppState } from '../types';

type CommitRepositories = AppState['commitRepositories'];

/** CommitPanel 的视图标题命令与未提交变更文件徽标。 */
export class CommitPanelViewTitleController implements vscode.Disposable {
    private view?: vscode.WebviewView;
    private readonly command: vscode.Disposable;

    constructor(openCommitPanel: () => void | Promise<void>) {
        this.command = vscode.commands.registerCommand('fastergit.openCommitPanel', () => {
            void openCommitPanel();
        });
    }

    bindView(view: vscode.WebviewView, repositories: CommitRepositories): void {
        this.view = view;
        this.update(repositories);
    }

    unbindView(view: vscode.WebviewView): void {
        if (this.view === view) { this.view = undefined; }
    }

    update(repositories: CommitRepositories): void {
        if (!this.view) { return; }
        const count = repositories.reduce((total, repository) => total
            + new Set([...repository.staged, ...repository.unstaged].map(file => file.path)).size, 0);
        this.view.badge = count > 0
            ? { value: count, tooltip: `${count} 个未提交变更文件` }
            : undefined;
    }

    dispose(): void {
        this.command.dispose();
        this.view = undefined;
    }
}
