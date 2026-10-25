import * as vscode from 'vscode';
import { GitkViewProvider } from './webview/gitkViewProvider';
import { GitkStatusBar } from './statusBar';
import { GitCommitEditMsgEditor } from './webview/gitCommitEditMsgEditor';

// 插件激活入口
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 空文档提供器: 用于 Added/Deleted 文件的 diff 空白侧
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('fastergit-empty', {
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
        vscode.commands.registerCommand('fastergit.open', async () => {
            await vscode.commands.executeCommand('fastergit.panelView.focus');
        })
    );

    const changedFilesDisplayMode = (): 'tree' | 'flat' =>
        vscode.workspace.getConfiguration('fastergit').get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
    const updateChangedFilesDisplayModeContext = (): Thenable<unknown> =>
        vscode.commands.executeCommand('setContext', 'fastergit:changedFilesDisplayMode', changedFilesDisplayMode());
    const setChangedFilesDisplayMode = (mode: 'tree' | 'flat'): Thenable<void> =>
        vscode.workspace.getConfiguration('fastergit')
            .update('changedFilesDisplayMode', mode, vscode.ConfigurationTarget.Global);
    await updateChangedFilesDisplayModeContext();

    const multiDiffLayoutConfiguration = vscode.workspace.getConfiguration('fastergit');
    const initialRenderSideBySide = multiDiffLayoutConfiguration.get<boolean>('multiDiffRenderSideBySide', true);
    provider.setMultiDiffRenderSideBySide(initialRenderSideBySide);
    await vscode.commands.executeCommand('setContext', 'fastergit:multiDiffRenderSideBySide', initialRenderSideBySide);
    const setMultiDiffRenderSideBySide = (renderSideBySide: boolean): Thenable<void> =>
        vscode.workspace.getConfiguration('fastergit')
            .update('multiDiffRenderSideBySide', renderSideBySide, vscode.ConfigurationTarget.Global);
    context.subscriptions.push(
        vscode.commands.registerCommand('fastergit.selectCommit', (hash: string) => provider.selectCommit(hash)),
        vscode.commands.registerCommand('fastergit.refresh', () => provider.refreshCurrentView()),
        vscode.commands.registerCommand('fastergit.changedFiles.useFlatView', () => setChangedFilesDisplayMode('flat')),
        vscode.commands.registerCommand('fastergit.changedFiles.useTreeView', () => setChangedFilesDisplayMode('tree')),
        vscode.commands.registerCommand('fastergit.multiDiff.previousChange', () => provider.navigateMultiDiffChange(-1)),
        vscode.commands.registerCommand('fastergit.multiDiff.nextChange', () => provider.navigateMultiDiffChange(1)),
        vscode.commands.registerCommand('fastergit.multiDiff.search', () => provider.showMultiDiffSearch()),
        vscode.commands.registerCommand('fastergit.multiDiff.useInlineView', () => setMultiDiffRenderSideBySide(false)),
        vscode.commands.registerCommand('fastergit.multiDiff.useSideBySideView', () => setMultiDiffRenderSideBySide(true)),
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration('fastergit.changedFilesDisplayMode')) {
                await updateChangedFilesDisplayModeContext();
            }
            if (!event.affectsConfiguration('fastergit.multiDiffRenderSideBySide')) { return; }
            const renderSideBySide = vscode.workspace.getConfiguration('fastergit')
                .get<boolean>('multiDiffRenderSideBySide', true);
            provider.setMultiDiffRenderSideBySide(renderSideBySide);
            await vscode.commands.executeCommand('setContext', 'fastergit:multiDiffRenderSideBySide', renderSideBySide);
        })
    );

    // 状态栏: workspace 有 git 仓库时显示 FasterGit 及全仓库未提交统计。
    const statusBar = new GitkStatusBar(
        context,
        'fastergit.open',
        () => provider.getWorkingTreeSummary(),
        () => provider.hasRepositories,
        provider.onDidChangeRepositoryState,
        provider.onDidChangeWorkingTreeSummary,
    );
    context.subscriptions.push(statusBar);
    await statusBar.initialize();
}

export function deactivate(): void {}