import * as vscode from 'vscode';
import type { AppState } from '../types';

type CommitRepositories = AppState['commitRepositories'];

/** CommitPanel 的视图标题命令与未提交仓库徽标。 */
export class CommitPanelViewTitleController implements vscode.Disposable {
    private view?: vscode.WebviewView;
    private readonly command: vscode.Disposable;

    constructor(openCommitPanel: () => void | Promise<void>) {
        this.command = vscode.commands.registerCommand('vscode-gitk.openCommitPanel', () => {
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
        const count = repositories.filter(repository => repository.staged.length > 0 || repository.unstaged.length > 0).length;
        this.view.badge = count > 0
            ? { value: count, tooltip: `${count} 个仓库有未提交文件` }
            : undefined;
    }

    dispose(): void {
        this.command.dispose();
        this.view = undefined;
    }
}
