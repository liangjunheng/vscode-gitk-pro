import * as vscode from 'vscode';
import { GitkViewProvider } from './gitkViewProvider';
import { GitkStatusBar } from './statusBar';

// 插件激活入口
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 诊断信息: 确认插件被加载
    console.log('[vscode-gitk] activate called');
    vscode.window.showInformationMessage('vscode-gitk 已激活');

    // 诊断: 列出所有 multi/diff 相关命令, 确认可用命令名
    const allCmds = await vscode.commands.getCommands();
    const diffCmds = allCmds.filter(c => c.toLowerCase().includes('multidiff') || c.toLowerCase().includes('multi-diff'));
    console.log('[vscode-gitk] multi-diff related commands:', diffCmds);

    // 空文档提供器: 用于 Added/Deleted 文件的 diff 空白侧
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('gitk-empty', {
            provideTextDocumentContent(): string { return ''; },
        })
    );

    const provider = new GitkViewProvider(context);

    // 注册 webview view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            GitkViewProvider.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );


    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-gitk.open', async () => {
            await vscode.commands.executeCommand('vscode-gitk.panelView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-gitk.refresh', () => {
            provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-gitk.selectCommit', (hash: string) => provider.selectCommit(hash))
    );

    // 状态栏: workspace 是 git 仓库时显示 "Gitk" 字样 + 内置 git-merge 图标, 点击打开面板
    const statusBar = new GitkStatusBar(context, 'vscode-gitk.open');
    context.subscriptions.push(statusBar);
    statusBar.initialize();
}

export function deactivate(): void {}