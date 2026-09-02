import * as vscode from 'vscode';
import { GitkViewProvider } from './webview/gitkViewProvider';
import { GitkStatusBar } from './statusBar';
import { store } from './state/store';
import { GitCommitEditMsgEditor } from './webview/gitCommitEditMsgEditor';

// 插件激活入口
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 单一数据源 Store 在激活时即存在, 存放所有业务数据
    console.log('[vscode-gitk] activate called, Store initialized:', store.getState().isLoading);
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

    const commitEditMsgEditor = new GitCommitEditMsgEditor(context.extensionPath);
    context.subscriptions.push(commitEditMsgEditor);
    const provider = new GitkViewProvider(context, commitEditMsgEditor);
    provider.initializeBackground();

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
        vscode.commands.registerCommand('vscode-gitk.selectCommit', (hash: string) => provider.selectCommit(hash)),
        vscode.commands.registerCommand('vscode-gitk.multiDiff.previousChange', () => provider.navigateMultiDiffChange(-1)),
        vscode.commands.registerCommand('vscode-gitk.multiDiff.nextChange', () => provider.navigateMultiDiffChange(1))
    );

    // 状态栏: workspace 有 git 仓库时显示 Gitk 及全仓库未提交统计。
    const statusBar = new GitkStatusBar(
        context,
        'vscode-gitk.open',
        () => provider.getWorkingTreeSummary(),
        () => provider.hasRepositories,
        provider.onDidChangeRepositoryState,
        provider.onDidChangeWorkingTreeSummary,
    );
    context.subscriptions.push(statusBar);
    await statusBar.initialize();
}

export function deactivate(): void {}