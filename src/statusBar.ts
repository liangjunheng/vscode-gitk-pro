import * as vscode from 'vscode';
import { store } from './state/store';
import { getGitApi } from './git/gitLogProvider';

// 状态栏管理: 仅在 workspace 有 git 仓库时显示 "Gitk" 字样 + 内置 git-merge 图标
// 通过 Store 订阅仓库变化, 不维护独立 gitApi
export class GitkStatusBar {
    private item: vscode.StatusBarItem;
    private unsubscribe?: () => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly openCommand: string,
    ) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = openCommand;
        this.item.tooltip = '打开 Gitk 提交图面板';
        this.item.name = 'Gitk';
        this.item.text = '$(git-merge) Gitk';
    }

    // 初始化: 直接查 Git API 决定可见性, 不依赖 Store (避免面板未显示时 Store 永远为空的死锁)
    async initialize(): Promise<void> {
        // 订阅 Store repositories 变化, 后续数据驱动可见性
        this.unsubscribe = store.subscribeSelector(
            state => state.repositories,
            repos => { this.checkVisibility(repos.length > 0); }
        );
        const api = await getGitApi();
        if (api) {
            // 直接查 Git API 已打开的仓库, 打破死锁
            this.checkVisibility(api.repositories.length > 0);
            if (api.onDidOpenRepository) {
                this.context.subscriptions.push(
                    api.onDidOpenRepository(() => void this.checkVisibility(api.repositories.length > 0))
                );
            }
            if (api.onDidCloseRepository) {
                this.context.subscriptions.push(
                    api.onDidCloseRepository(() => void this.checkVisibility(api.repositories.length > 0))
                );
            }
        }
        // Store 可能已有数据 (面板已显示过的情况)
        this.checkVisibility(store.getState().repositories.length > 0);
    }

    // 检查是否有 git 仓库, 有则显示状态栏和面板, 无则隐藏
    private async checkVisibility(hasRepo: boolean): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitk:hasRepository', hasRepo);
        if (hasRepo) {
            this.item.show();
        } else {
            this.item.hide();
        }
    }

    dispose(): void {
        this.unsubscribe?.();
        this.item.dispose();
    }
}
