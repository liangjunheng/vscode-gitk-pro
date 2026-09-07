import * as vscode from 'vscode';
import { GitkViewProvider } from './webview/gitkViewProvider';
import { GitkStatusBar } from './statusBar';
import { GitCommitEditMsgEditor } from './webview/gitCommitEditMsgEditor';

// 插件激活入口
export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

    const multiDiffLayoutConfiguration = vscode.workspace.getConfiguration('vscode-gitk');
    const initialRenderSideBySide = multiDiffLayoutConfiguration.get<boolean>('multiDiffRenderSideBySide', true);
    provider.setMultiDiffRenderSideBySide(initialRenderSideBySide);
    await vscode.commands.executeCommand('setContext', 'gitk:multiDiffRenderSideBySide', initialRenderSideBySide);
    const setMultiDiffRenderSideBySide = (renderSideBySide: boolean): Thenable<void> =>
        vscode.workspace.getConfiguration('vscode-gitk')
            .update('multiDiffRenderSideBySide', renderSideBySide, vscode.ConfigurationTarget.Global);
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-gitk.selectCommit', (hash: string) => provider.selectCommit(hash)),
        vscode.commands.registerCommand('vscode-gitk.multiDiff.previousChange', () => provider.navigateMultiDiffChange(-1)),
        vscode.commands.registerCommand('vscode-gitk.multiDiff.nextChange', () => provider.navigateMultiDiffChange(1)),
        vscode.commands.registerCommand('vscode-gitk.multiDiff.useInlineView', () => setMultiDiffRenderSideBySide(false)),
        vscode.commands.registerCommand('vscode-gitk.multiDiff.useSideBySideView', () => setMultiDiffRenderSideBySide(true)),
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (!event.affectsConfiguration('vscode-gitk.multiDiffRenderSideBySide')) { return; }
            const renderSideBySide = vscode.workspace.getConfiguration('vscode-gitk')
                .get<boolean>('multiDiffRenderSideBySide', true);
            provider.setMultiDiffRenderSideBySide(renderSideBySide);
            await vscode.commands.executeCommand('setContext', 'gitk:multiDiffRenderSideBySide', renderSideBySide);
        })
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