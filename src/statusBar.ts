import * as vscode from 'vscode';

// 状态栏管理: 仅在 workspace 有 git 仓库时显示 "Gitk" 字样 + 内置 git-merge 图标
export class GitkStatusBar {
    private item: vscode.StatusBarItem;
    private gitApi?: any;

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

    // 初始化: 检查 git 仓库并决定是否显示
    async initialize(): Promise<void> {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            this.gitApi = await gitExtension.activate();
            // 监听仓库打开/关闭
            if (this.gitApi?.onDidOpenRepository) {
                this.context.subscriptions.push(
                    this.gitApi.onDidOpenRepository(() => void this.checkVisibility())
                );
            }
            if (this.gitApi?.onDidCloseRepository) {
                this.context.subscriptions.push(
                    this.gitApi.onDidCloseRepository(() => void this.checkVisibility())
                );
            }
        }
        await this.checkVisibility();
    }

    // 检查是否有 git 仓库, 有则显示, 无则隐藏
    async checkVisibility(): Promise<void> {
        const hasRepo = this.gitApi && this.gitApi.repositories && this.gitApi.repositories.length > 0;
        if (hasRepo) {
            this.item.show();
        } else {
            this.item.hide();
        }
    }

    dispose(): void {
        this.item.dispose();
    }
}
