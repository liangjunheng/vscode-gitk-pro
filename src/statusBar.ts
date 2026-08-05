import * as vscode from 'vscode';

// 状态栏管理: 常驻显示 "Gitk" 字样 + 内置 git-merge 图标, 点击打开 Gitk 面板
// 常驻版本: 不判断 git 仓库, 始终显示
export class GitkStatusBar {
    private item: vscode.StatusBarItem;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly openCommand: string,
    ) {
        // 状态栏右侧, 优先级 100 (靠左)
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = openCommand;
        this.item.tooltip = '打开 Gitk 提交图面板';
        this.item.name = 'Gitk';
        // 使用内置 git-merge 图标 (分支合并图, 与 gitk 提交图主题高度契合)
        this.item.text = '$(git-merge) Gitk';
        // 常驻显示
        this.item.show();
    }

    // 初始化: 常驻模式无需操作
    initialize(): void {
        // noop - 构造函数里已 show()
    }

    // 释放资源
    dispose(): void {
        this.item.dispose();
    }
}