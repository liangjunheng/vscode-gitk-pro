import * as vscode from 'vscode';
import {
    runGitCommand,
    runGitSync,
    updateGitSubmodules,
    invalidateGitRefsCache,
    invalidateGitRepositoriesCache,
} from '../git/gitLogProvider';

/**
 * Git 操作执行器: 处理用户触发的 Git 命令 (tag, branch, checkout, merge, rebase, reset 等)
 */
export class GitActionRunner {
    private syncInProgress = false;

    constructor(
        private readonly getRootUri: (repositoryPath?: string) => vscode.Uri | undefined,
        /** 仓库变更后的回调 (通常触发刷新) */
        private readonly onMutated: (
            rootUri: vscode.Uri,
            reloadSelectors?: boolean,
            refreshOnlyWhenCurrentBranchSelected?: boolean,
        ) => Promise<void>,
    ) {}

    async runCommitAction(action: string, hash: string, repositoryPath: string): Promise<void> {
        const rootUri = this.getRootUri(repositoryPath);
        if (!rootUri) { return; }
        if (action === 'copyHash') {
            await vscode.env.clipboard.writeText(hash);
            void vscode.window.showInformationMessage('已复制提交 Hash');
            return;
        }
        let didMutateRepository = false;
        try {
            switch (action) {
                case 'addTag': {
                    const tagName = await vscode.window.showInputBox({ prompt: '输入新标签名称', validateInput: value => value.trim() ? undefined : '标签名称不能为空' });
                    if (!tagName) { return; }
                    await runGitCommand(rootUri, ['tag', '-a', tagName.trim(), hash, '-m', `Tag ${tagName.trim()}`]);
                    didMutateRepository = true;
                    break;
                }
                case 'createBranch': {
                    const branchName = await vscode.window.showInputBox({ prompt: '输入新分支名称', validateInput: value => value.trim() ? undefined : '分支名称不能为空' });
                    if (!branchName) { return; }
                    await runGitCommand(rootUri, ['branch', branchName.trim(), hash]);
                    didMutateRepository = true;
                    break;
                }
                case 'checkout':
                    await runGitCommand(rootUri, ['checkout', hash]);
                    didMutateRepository = true;
                    break;
                case 'cherryPick':
                    await runGitCommand(rootUri, ['cherry-pick', hash]);
                    didMutateRepository = true;
                    break;
                case 'revert':
                    await runGitCommand(rootUri, ['revert', '--no-edit', hash]);
                    didMutateRepository = true;
                    break;
                case 'drop':
                    await vscode.window.showWarningMessage('Drop 需要交互式 rebase，当前扩展不自动改写提交历史。', { modal: true });
                    return;
                case 'merge':
                    await runGitCommand(rootUri, ['merge', '--no-edit', hash]);
                    didMutateRepository = true;
                    break;
                case 'rebase':
                    await runGitCommand(rootUri, ['rebase', hash]);
                    didMutateRepository = true;
                    break;
                case 'reset': {
                    const choice = await vscode.window.showWarningMessage('将当前分支重置到所选提交。', { modal: true }, 'Soft', 'Mixed', 'Hard');
                    if (!choice) { return; }
                    await runGitCommand(rootUri, ['reset', `--${choice.toLowerCase()}`, hash]);
                    didMutateRepository = true;
                    break;
                }
                default:
                    return;
            }
            if (!didMutateRepository) { return; }
            invalidateGitRefsCache(rootUri);
            await this.onMutated(rootUri);
        } catch (error) {
            void vscode.window.showErrorMessage(`Git 操作失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async syncRepository(action: 'fetch' | 'pull' | 'push', repositoryPath: string): Promise<void> {
        const rootUri = this.getRootUri(repositoryPath);
        if (!rootUri) { return; }
        if (this.syncInProgress) {
            void vscode.window.showWarningMessage('已有 Git 同步操作正在进行，请稍候。');
            return;
        }

        this.syncInProgress = true;
        try {
            const operation = action === 'fetch' ? '获取' : action === 'pull' ? '拉取' : '推送';
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Git ${operation}`,
                cancellable: false,
            }, async progress => {
                try {
                    progress.report({ message: '正在执行 Git 命令...' });
                    const result = await runGitSync(rootUri, action, message => progress.report({ message }));
                    if (action === 'pull' && result.submodulesNeedUpdate) {
                        await updateGitSubmodules(rootUri, message => progress.report({ message }));
                    }
                    if (result.submoduleTopologyChanged) {
                        progress.report({ message: '检测到 Submodule 模块新增或删除，正在刷新仓库信息...' });
                        invalidateGitRepositoriesCache();
                    } else {
                        progress.report({ message: '正在刷新提交记录...' });
                    }
                    invalidateGitRefsCache(rootUri);
                    const shouldRefreshHistory = action === 'push' || (action === 'pull' && result.headChanged);
                    await this.onMutated(
                        rootUri,
                        result.submoduleTopologyChanged,
                        shouldRefreshHistory,
                    );
                    void vscode.window.showInformationMessage(`Git ${operation}操作已完成。`);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Git ${operation}操作失败：${reason}`);
                }
            });
        } finally {
            this.syncInProgress = false;
        }
    }
}
