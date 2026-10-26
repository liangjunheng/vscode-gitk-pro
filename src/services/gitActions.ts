import * as path from 'path';
import * as vscode from 'vscode';
import { getPushPlan, runGitSync, updateGitSubmodules, type PushTargetOption } from '../git/gitLogProvider';
import { checkout, cherryPick, createBranch, createTag, deleteLocalTag, deleteRemoteTag, merge, pushTag as pushCommitTag, readCommitTagState, rebase, reset, revertCommit, stageAll, statusSummary, type CommitTagState, type NativePushResult, type RemoteTagRef } from '../git/gitNativeOperations';
import { GitCommitEditMsgEditor } from '../webview/gitCommitEditMsgEditor';
import { confirmPush, pickPushTargets, showPushResult } from './pushDialogs';

/** 推送结果说明: 分支名 → 远程分支名, 提交 hash 单独标注, 两者不互换。 */
function formatPushResultDetail(results: readonly NativePushResult[] | undefined): string {
    if (!results || results.length === 0) { return '没有返回推送目标信息。'; }
    return results.map(result => {
        const target = result.remote && result.remoteBranch
            ? `${result.remote}/${result.remoteBranch}`
            : result.remoteBranch ?? '远程分支';
        const source = result.sourceBranchName ?? '游离 HEAD';
        const commit = result.sourceHash ? `，提交 ${result.sourceHash.slice(0, 8)}` : '';
        return `${source} → ${target}${commit}`;
    }).join('\n\n');
}

async function pickLocalTag(tags: readonly string[], placeHolder: string): Promise<string | undefined> {
    if (tags.length === 0) { return undefined; }
    if (tags.length === 1) { return tags[0]; }
    const picked = await vscode.window.showQuickPick(tags.map(label => ({ label })), { placeHolder });
    return picked?.label;
}

async function pickRemoteTag(tags: readonly RemoteTagRef[], placeHolder: string): Promise<RemoteTagRef | undefined> {
    if (tags.length === 0) { return undefined; }
    if (tags.length === 1) { return tags[0]; }
    const picked = await vscode.window.showQuickPick(
        tags.map(tag => ({ label: tag.name, description: tag.remote, tag })),
        { placeHolder },
    );
    return picked?.tag;
}

/**
 * Git 操作执行器: 处理用户触发的 Git 命令 (tag, branch, checkout, merge, rebase, reset 等)
 */
export class GitActionRunner {
    private syncInProgress = false;
    private readonly pendingCommitTagStates = new Map<string, Promise<CommitTagState>>();

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

    async getCommitTagState(hash: string, repositoryPath: string): Promise<CommitTagState | undefined> {
        const rootUri = this.getRootUri(repositoryPath);
        if (!rootUri) { return undefined; }
        const key = `${repositoryPath}:${hash}`;
        const pending = this.pendingCommitTagStates.get(key);
        if (pending) { return pending; }
        const task = readCommitTagState(rootUri, hash).finally(() => {
            if (this.pendingCommitTagStates.get(key) === task) { this.pendingCommitTagStates.delete(key); }
        });
        this.pendingCommitTagStates.set(key, task);
        return task;
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
                case 'addTag': // 兼容旧 Webview 已排队的消息。
                case 'createTag': {
                    const tagName = await vscode.window.showInputBox({ prompt: '输入新标签名称', validateInput: value => value.trim() ? undefined : '标签名称不能为空' });
                    if (!tagName) { return; }
                    await createTag(rootUri, tagName.trim(), hash, `Tag ${tagName.trim()}`);
                    didMutateRepository = true;
                    break;
                }
                case 'deleteTag': {
                    const state = await readCommitTagState(rootUri, hash);
                    if (state.localTags.length === 0) {
                        void vscode.window.showWarningMessage('所选提交没有可删除的本地 Tag。');
                        return;
                    }
                    const tagName = await pickLocalTag(state.localTags, '选择要删除的本地 Tag');
                    if (!tagName) { return; }
                    const confirmed = await vscode.window.showWarningMessage(
                        `删除本地 Tag “${tagName}”？`, { modal: true }, '删除 Tag');
                    if (confirmed !== '删除 Tag') { return; }
                    await deleteLocalTag(rootUri, tagName);
                    didMutateRepository = true;
                    break;
                }
                case 'deleteRemoteTag': {
                    const state = await readCommitTagState(rootUri, hash);
                    if (state.remoteTags.length === 0) {
                        void vscode.window.showWarningMessage('所选提交没有可删除的远程 Tag。');
                        return;
                    }
                    const tag = await pickRemoteTag(state.remoteTags, '选择要删除的远程 Tag');
                    if (!tag) { return; }
                    const confirmed = await vscode.window.showWarningMessage(
                        `从 ${tag.remote} 删除远程 Tag “${tag.name}”？`, { modal: true }, '删除远程 Tag');
                    if (confirmed !== '删除远程 Tag') { return; }
                    await deleteRemoteTag(rootUri, tag.remote, tag.name);
                    didMutateRepository = true;
                    break;
                }
                case 'pushTag': {
                    const state = await readCommitTagState(rootUri, hash);
                    if (state.pushableTags.length === 0) {
                        void vscode.window.showWarningMessage('所选提交没有可推送的 Tag。');
                        return;
                    }
                    const tag = await pickRemoteTag(state.pushableTags, '选择要推送的 Tag 和远程仓库');
                    if (!tag) { return; }
                    const confirmed = await vscode.window.showWarningMessage(
                        `将本地 Tag “${tag.name}” 推送到 ${tag.remote}？`, { modal: true }, 'Push Tag');
                    if (confirmed !== 'Push Tag') { return; }
                    await pushCommitTag(rootUri, tag.remote, tag.name);
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

    async syncRepository(action: 'fetch' | 'pull' | 'push', repositoryPath: string, selectedRemotes: { fetch: readonly string[]; pull: readonly string[]; push: readonly string[] }): Promise<void> {
        const rootUri = this.getRootUri(repositoryPath);
        if (!rootUri) { return; }
        if (this.syncInProgress) {
            void vscode.window.showWarningMessage('已有 Git 同步操作正在进行，请稍候。');
            return;
        }

        this.syncInProgress = true;
        try {
            const operation = action === 'fetch' ? '获取' : action === 'pull' ? '拉取' : '推送';
            let selectedPushTargets: PushTargetOption[] | undefined;
            if (action === 'push') {
                const plan = await getPushPlan(rootUri);
                if (!plan || plan.targets.length === 0) {
                    void vscode.window.showWarningMessage('当前仓库没有可推送的远程分支。');
                    return;
                }
                const pushRemotes = new Set(selectedRemotes.push);
                const remotePlan = {
                    ...plan,
                    targets: plan.targets.filter(target => pushRemotes.has(target.remote)),
                };
                if (remotePlan.targets.length === 0) {
                    void vscode.window.showWarningMessage('勾选的 Push remote 没有可推送的远程分支。');
                    return;
                }
                selectedPushTargets = await pickPushTargets(remotePlan);
                if (!selectedPushTargets || selectedPushTargets.length === 0) { return; }
                const repositoryLabel = path.basename(rootUri.fsPath) || repositoryPath;
                const confirmed = await confirmPush(
                    selectedPushTargets.map(target => ({ source: plan.source, target })),
                    repositoryLabel,
                    selectedRemotes.push,
                );
                if (!confirmed) { return; }
            }
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Git ${operation}`,
                cancellable: false,
            }, async progress => {
                try {
                    progress.report({ message: '正在执行 Git 命令...' });
                    const result = await runGitSync(
                        rootUri,
                        action,
                        message => progress.report({ message }),
                        selectedPushTargets,
                        selectedRemotes,
                    );
                    let submodulesUpdated = false;
                    if (action === 'pull' && result.submodulesNeedUpdate) {
                        progress.report({ message: '检测到需要更新的子模块，等待确认...' });
                        const choice = await vscode.window.showWarningMessage(
                            `代码拉取完成，但检测到 ${result.submodulePaths.length} 个子模块版本不一致。是否立即更新子模块？`,
                            {
                                modal: true,
                                detail: result.submodulePaths.map(submodulePath => `• ${submodulePath}`).join('\n'),
                            },
                            '更新子模块',
                            '暂不更新',
                        );
                        if (choice === '更新子模块') {
                            await updateGitSubmodules(rootUri, result.submodulePaths, message => progress.report({ message }));
                            submodulesUpdated = true;
                        }
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
                    if (action === 'push') {
                        const detail = formatPushResultDetail(result.pushResults);
                        await showPushResult('Git Push 已完成', detail);
                    } else {
                        const details = [
                            result.summary ?? `Git ${operation}已完成。`,
                            ...(action === 'pull' && result.submodulesNeedUpdate
                                ? [submodulesUpdated
                                    ? `已更新 ${result.submodulePaths.length} 个子模块`
                                    : `有 ${result.submodulePaths.length} 个子模块暂未更新`]
                                : []),
                        ];
                        const message = details.map(detail => detail.replace(/[。；]+$/u, '')).join('；') + '。';
                        void vscode.window.showInformationMessage(message);
                    }
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Git ${operation}失败：${reason}`);
                }
            });
        } finally {
            this.syncInProgress = false;
        }
    }
}
