import * as vscode from 'vscode';
import { runGitSync, updateGitSubmodules } from '../git/gitLogProvider';
import { checkout, cherryPick, createBranch, createTag, merge, rebase, reset, revertCommit, stageAll, statusSummary } from '../git/gitNativeOperations';
import { GitCommitEditMsgEditor } from '../webview/gitCommitEditMsgEditor';

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
        private readonly commitEditMsgEditor: GitCommitEditMsgEditor,
    ) {}

    async openCommitEditor(repositoryPath: string, amend: boolean): Promise<void> {
        const rootUri = this.getRootUri(repositoryPath);
        if (!rootUri) { return; }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: amend ? '修改提交' : '创建提交',
            cancellable: false,
        }, async progress => {
            // 单次 porcelain 只读取提交决策所需状态，不触发 VS Code SCM 全量刷新。
            progress.report({ message: '正在检查更改...' });
            const state = await statusSummary(rootUri);
            if (!state.hasStagedChanges) {
                if (!state.hasUnstagedChanges) {
                    void vscode.window.showInformationMessage('没有可提交的更改。');
                    return;
                }
                progress.report({ message: '等待确认是否暂存全部更改...' });
                const choice = await vscode.window.showWarningMessage(
                    '当前没有已暂存的更改，是否暂存全部未暂存更改？',
                    { modal: true },
                    '是',
                    '否',
                );
                if (choice !== '是') { return; }
                progress.report({ message: '正在暂存更改...' });
                await stageAll(rootUri);
            }
            progress.report({ message: '正在打开 COMMIT_EDITMSG 编辑器...' });
            const session = await this.commitEditMsgEditor.edit(rootUri, amend);
            const completed = session.completed.then(async committed => {
                if (committed) {
                    await this.onMutated(rootUri);
                }
            }).catch(error => {
                vscode.window.setStatusBarMessage(`$(warning) Git Commit 失败：${error instanceof Error ? error.message : String(error)}`, 3000);
            });
            try {
                await session.opened;
            } catch (error) {
                await completed;
                return;
            }
        });
    }

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
                    await createTag(rootUri, tagName.trim(), hash, `Tag ${tagName.trim()}`);
                    didMutateRepository = true;
                    break;
                }
                case 'createBranch': {
                    const branchName = await vscode.window.showInputBox({ prompt: '输入新分支名称', validateInput: value => value.trim() ? undefined : '分支名称不能为空' });
                    if (!branchName) { return; }
                    await createBranch(rootUri, branchName.trim(), hash);
                    didMutateRepository = true;
                    break;
                }
                case 'checkout':
                    await checkout(rootUri, hash, true);
                    didMutateRepository = true;
                    break;
                case 'cherryPick':
                    await cherryPick(rootUri, hash);
                    didMutateRepository = true;
                    break;
                case 'revert':
                    await revertCommit(rootUri, hash);
                    didMutateRepository = true;
                    break;
                case 'drop':
                    await vscode.window.showWarningMessage('Drop 需要交互式 rebase，当前扩展不自动改写提交历史。', { modal: true });
                    return;
                case 'merge':
                    await merge(rootUri, hash);
                    didMutateRepository = true;
                    break;
                case 'rebase':
                    await rebase(rootUri, hash);
                    didMutateRepository = true;
                    break;
                case 'reset': {
                    const choice = await vscode.window.showWarningMessage('将当前分支重置到所选提交。', { modal: true }, 'Soft', 'Mixed', 'Hard');
                    if (!choice) { return; }
                    await reset(rootUri, hash, choice.toLowerCase() as 'soft' | 'mixed' | 'hard');
                    didMutateRepository = true;
                    break;
                }
                default:
                    return;
            }
            if (!didMutateRepository) { return; }
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
                        await updateGitSubmodules(rootUri, result.submodulePaths, message => progress.report({ message }));
                    }
                    if (result.submoduleTopologyChanged) {
                        // 仓库集合变化由调用方转交 GitRepoController 重扫。
                        progress.report({ message: '检测到 Submodule 模块新增或删除，正在刷新仓库信息...' });
                    } else {
                        progress.report({ message: '正在刷新提交记录...' });
                    }
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
