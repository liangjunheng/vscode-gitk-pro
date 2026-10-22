import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type AppState, type ChangeSetMode, type ChangedFile, GitBranchOption, CommitFile, CommitMetadata, DiffPayload, type GitkIntent, type GitRepositoryOption, type GitlinkCommit, WorkingTreeChanges, isWorkingTreeHash } from '../types';
import { defaultPushTarget, getCloudCommits, getCommitFiles, getStashes, getStashFiles, type StashEntry, getCurrentGitHeadHash, getGitAheadBehind, getGitAheadCount, getGitBranches, getGitlinkPathsInCommit, getPushPlan, type PushSourceBranch, type PushTargetOption, readCurrentCommitMessage } from '../git/gitLogProvider';
import { checkoutBranch, checkoutRemoteBranch, commitDetails, fetchRemotes, hasConflicts, indexGitlink, pull, push, rangeCommits, resolveRevision, restoreAll, restoreSubmodule, trackedPaths, type NativeCommitDetails, type NativePushResult } from '../git/gitNativeOperations';
import { MultiDiffPanel } from './multiDiffPanel';
import { FILE_CONTEXT_MENU_ACTIONS } from './fileContextMenu';
import { readMergeOperation, runMergeOperation, type MergeOperation } from '../git/mergeOperation';
import { MergeEditorSessions } from './mergeEditorSessions';
import { CommitPanel, type CommitPanelSnapshot, type CommitCard, type CommitCardStatePatch } from './commitPanel';
import { CommitPanelViewTitleController } from './commitPanelViewTitleController';
import { renderGitkWebviewHtml } from './gitkWebviewDocument';
import { commitWithMessage } from '../git/gitCommitService';
import { DiffReader } from '../git/diffReader';
import { LibGit2Backend } from '../git/libGit2Backend';
import type { StashScope } from '../git/gitBackend';
import { GitCommitEditMsgEditor } from './gitCommitEditMsgEditor';
import { GitActionRunner } from '../services/gitActions';
import { confirmPush, confirmSync, describePushRow, pickPushTarget, pickPushTargets, showPushResult, type PushConfirmRow } from '../services/pushDialogs';
import { RepoSubmoduleWatcher } from '../git/gitRepoSubmoduleWatcher';
import { GitRepoController } from '../git/gitRepoController';
import { RepoHeadBranchWatcher } from '../git/eachRepoHeadBranchWatcher';
import { UncommittedFilesWatcher } from '../git/uncommittedFilesWatcher';
import { SelectedRepoTotalBranchWatcher } from '../git/selectedRepoTotalBranchWatcher';
import { GitBranchesController } from '../git/gitBranchesController';
import { GitCommitController } from '../git/gitCommitController';
import { store, type StoreEffect } from '../state/store';
import { resolveWorkingTreeSelection } from './workingTreeSelection';

type SetiIconDefinitions = Record<string, readonly [string, string]>;

type BranchTip = Readonly<{
    timestamp: number;
    author?: string;
    shortHash: string;
    subject?: string;
}>;

const SETI_ICON_DEFINITION_IDS: Readonly<Record<string, string>> = {
    default: '_default', c: '_c', cHeader: '_c_1', cpp: '_cpp', cppHeader: '_cpp_1', objectiveC: '_c_2', objectiveCpp: '_cpp_2',
    csharp: '_c-sharp', fsharp: '_f-sharp', kotlin: '_kotlin', java: '_java', groovy: '_grails', gradle: '_gradle', rust: '_rust',
    typescript: '_typescript', react: '_react', javascript: '_javascript', python: '_python', go: '_go2', html: '_html_3', css: '_css', sass: '_sass', less: '_less', vue: '_vue', svelte: '_svelte',
    json: '_json', markdown: '_markdown', image: '_image', svg: '_svg', audio: '_audio', video: '_video', pdf: '_pdf', zip: '_zip_1', archive: '_zip', database: '_db',
    shell: '_shell', powershell: '_powershell', windows: '_windows', hex: '_hex', config: '_config', xml: '_xml', yaml: '_yml', csv: '_csv', docker: '_docker', makefile: '_makefile',
    jenkins: '_jenkins', info: '_info', license: '_license', npm: '_npm', yarn: '_yarn', tsconfig: '_tsconfig', git: '_git', dart: '_dart', php: '_php', ruby: '_ruby', swift: '_swift', lua: '_lua',
};

function readInstalledSetiIconDefinitions(iconRoot: vscode.Uri): SetiIconDefinitions {
    if (iconRoot.scheme !== 'file') { return {}; }
    try {
        const theme = JSON.parse(readFileSync(vscode.Uri.joinPath(iconRoot, 'vs-seti-icon-theme.json').fsPath, 'utf8')) as {
            readonly iconDefinitions?: Readonly<Record<string, { readonly fontCharacter?: string; readonly fontColor?: string }>>;
        };
        const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
            || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
        const definitions: SetiIconDefinitions = {};
        for (const [name, baseId] of Object.entries(SETI_ICON_DEFINITION_IDS)) {
            const lightId = `${baseId}_light`;
            const id = light && theme.iconDefinitions?.[lightId] ? lightId : baseId;
            const definition = theme.iconDefinitions?.[id];
            if (!definition?.fontCharacter || !definition.fontColor) { continue; }
            const character = definition.fontCharacter.startsWith('\\')
                ? definition.fontCharacter.slice(1)
                : definition.fontCharacter;
            definitions[name] = [character, definition.fontColor];
        }
        return definitions;
    } catch {
        return {};
    }
}


// 归一化行尾, 消除 core.autocrlf 造成的 CRLF/LF 差异后再比较文本内容。
function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

// 子模块提交摘要属于元数据读取；避免大量 gitlink 同时启动子模块 Git 操作，但不限制普通 Diff 正文的可视批次。
const GITLINK_METADATA_READ_CONCURRENCY = 16;

type GitlinkParentNavigation = {
    readonly commit: CommitMetadata;
    readonly revealPath?: string;
    readonly childHash: string;
    readonly childRepositoryPath: string;
};

function toGitlinkCommit(detail: NativeCommitDetails): GitlinkCommit {
    const message = detail.message.trim();
    return {
        hash: detail.hash,
        shortHash: detail.shortHash,
        subject: message.split(/\r?\n/).find(line => line.trim().length > 0)?.trim(),
        message: message || undefined,
    };
}

function workingTreeChangeCount(changes: WorkingTreeChanges): number {
    return new Set([
        ...changes.staged.map(change => change.path),
        ...changes.changes.map(change => change.path),
    ]).size;
}


type WorkingTreeMutationProjection = {
    readonly changes: WorkingTreeChanges;
    readonly verificationPaths: readonly string[];
};

function projectUnstageChanges(
    before: WorkingTreeChanges,
    paths: readonly string[],
): WorkingTreeMutationProjection {
    const selected = new Set(paths);
    const stagedByPath = new Map(before.staged.map(file => [file.path, file]));
    const unstagedByPath = new Map(before.changes.map(file => [file.path, file]));
    const staged = before.staged.filter(file => !selected.has(file.path));
    const changes = before.changes.filter(file => !selected.has(file.path));
    const verificationPaths: string[] = [];
    for (const filePath of selected) {
        const file = stagedByPath.get(filePath);
        const hasUnstagedHalf = unstagedByPath.has(filePath);
        const canProject = file
            && !hasUnstagedHalf
            && !file.isConflict
            && !file.isGitlink
            && !file.oldPath
            && (file.status === 'M' || file.status === 'A' || file.status === 'D');
        if (!canProject) {
            verificationPaths.push(filePath);
            continue;
        }
        changes.push(new CommitFile({
            ...file,
            isUntracked: file.status === 'A',
            isConflict: false,
            workingTreeKind: undefined,
            diffKey: undefined,
        }));
    }
    staged.sort((left, right) => left.path.localeCompare(right.path));
    changes.sort((left, right) => left.path.localeCompare(right.path));
    return {
        changes: new WorkingTreeChanges({ staged, changes }),
        verificationPaths,
    };
}

function projectStashChanges(
    before: WorkingTreeChanges,
    paths: readonly string[],
    scope: StashScope,
    skippedGitlinks: readonly string[],
): WorkingTreeChanges {
    const skipped = new Set(skippedGitlinks);
    const removed = new Set(paths.filter(filePath => !skipped.has(filePath)));
    return new WorkingTreeChanges({
        staged: scope === 'unstaged'
            ? [...before.staged]
            : before.staged.filter(file => !removed.has(file.path)),
        changes: before.changes.filter(file => !removed.has(file.path)),
    });
}

/** 每个仓库记录的推送目标; 源分支随每次读取的 HEAD 变化, 不缓存。 */
type StoredPushTarget = PushTargetOption;

// Webview 视图提供器: 渲染 gitk 风格的提交图 (div flex 布局, 避免 table 高度塌陷)
export class GitkViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'fastergit.panelView';
    private view?: vscode.WebviewView;
    // 异步控制 / 内部状态 (不存入 Store)
    private refreshAbortController?: AbortController;
    private viewDataRefresh?: Promise<void>;
    private remoteFetchRefresh?: Promise<void>;
    private viewDataRefreshProgress?: { completed: number; total: number };
    private commitFilesAbortController?: AbortController;
    private commitPanelDiffAbortController?: AbortController;
    private repositoryChangesSelectionAbortController?: AbortController;
    // A repository-card click may change the global selection before its final card content is ready.
    // Keep that card's previous presentation stable until a completed commit snapshot arrives.
    private readonly repositoryCardDisplayLocks = new Set<string>();
    private pendingRepositoryChangesDefaultPath?: string;
    private commitFilesGeneration = 0;
    // 等待 Diff 渲染完成后再显示 Changed Files 列表的代次标记。
    private pendingFilesRevealGeneration?: number;
    private refreshGeneration = 0;
    private viewGeneration = 0;
    private initializingViewGeneration = 0;
    private viewDisposables: vscode.Disposable[] = [];
    private readonly onDidChangeDiffAvailabilityEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDiffAvailability = this.onDidChangeDiffAvailabilityEmitter.event;
    private readonly onDidChangeWorkingTreeSummaryEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeWorkingTreeSummary = this.onDidChangeWorkingTreeSummaryEmitter.event;
    private readonly onDidChangeRepositoryStateEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeRepositoryState = this.onDidChangeRepositoryStateEmitter.event;
    get hasRepositories(): boolean { return this.repositories.length > 0; }
    private lastLoadingProgress?: { phase: string; message: string; current: number; total: number };
    private storeUnsubscribe?: () => void;
    private pushStatePending = false;
    private observedStoreState?: Readonly<AppState>;
    private readonly changedFileSummaryCache = new WeakMap<object, CommitFile>();
    private gitWatchDisposables: vscode.Disposable[] = [];
    private readonly multiDiffPanel: MultiDiffPanel;
    private readonly mergeEditorSessions: MergeEditorSessions;
    private readonly mergeOperations = new Map<string, MergeOperation>();
    private readonly mergeOperationBusy = new Set<string>();
    private readonly mergeOperationReads = new Map<string, Promise<void>>();
    private requestedDiffReveal?: { readonly hash: string; readonly repositoryPath?: string; readonly path?: string };
    private pendingGitlinkWorktreeSnapshot?: {
        readonly repositoryPath: string;
        readonly branch: GitBranchOption;
        readonly changes: WorkingTreeChanges;
    };
    private readonly gitlinkParentNavigationStack: GitlinkParentNavigation[] = [];
    private gitlinkNavigationAbortController?: AbortController;
    private restoreDiffPanelOnViewVisible = false;
    private openDiffOnInitialVisible = false;
    private readonly commitPanel: CommitPanel;
    private readonly commitPanelViewTitleController: CommitPanelViewTitleController;
    // 每仓库独立的 amend / committing 状态 (多卡片各自提交)。
    private readonly commitAmendByRepo = new Map<string, boolean>();
    private readonly commitMessageBeforeAmendByRepo = new Map<string, string>();
    private readonly amendCommittedFilesByHead = new Map<string, readonly CommitFile[]>();
    private readonly amendCommittedFilesLoading = new Set<string>();
    private readonly unpushedCommitCountByRepository = new Map<string, number>();
    private readonly behindCommitCountByRepository = new Map<string, number>();
    /** 每个仓库当前分支 HEAD..upstream 的云端提交(最新在前), 与 behind 计数同源同刷新。 */
    private readonly cloudCommitsByRepository = new Map<string, readonly CommitMetadata[]>();
    /** 每个仓库的全部 stash(最新在前)。刷新由 refs/stash 监听、stash 操作和手动刷新触发。 */
    private readonly stashesByRepository = new Map<string, readonly StashEntry[]>();
    private readonly stashLoadingByRepository = new Map<string, number>();
    private stashLoadsInFlight?: Map<string, { dirty: boolean; promise: Promise<void> }>;
    /** Commit 列表是否显示 stash；构造时从 fastergit.showStashes 读取，按钮切换后写回全局设置。 */
    private showStashes = false;
    private readonly repositorySyncKeyByRepository = new Map<string, string>();
    private readonly repositorySyncStateLoadingByHead = new Set<string>();
    private readonly repositorySyncRevisionByRepository = new Map<string, number>();
    private readonly unpushedStateLoadedByHead = new Set<string>();
    private readonly unpushedStateLoadingByHead = new Set<string>();
    private readonly commitGitlinkPathsByHead = new Map<string, readonly string[]>();
    private readonly commitCommittingByRepo = new Set<string>();
    private readonly commitMessageByRepo = new Map<string, string>();
    private readonly initializedCommitMessagesByRepo = new Set<string>();
    private readonly selectedCommitSubmodulesByRepo = new Map<string, readonly string[]>();
    private readonly selectedPushSubmodulesByRepo = new Map<string, readonly string[]>();
    private readonly pullBeforePushByRepo = new Map<string, boolean>();
    /** 每个仓库当前选中的推送目标(远程分支); 推送源始终按 HEAD 现场读取, 不缓存。 */
    private readonly pushTargetByRepository = new Map<string, StoredPushTarget>();
    private readonly lastPushedTargetByRepository = new Map<string, StoredPushTarget>();
    private readonly gitBackend = new LibGit2Backend();
    private readonly diffReader: DiffReader;
    // 用户点击跳转使用独立读取器，不排队等待可视缓存批次；新点击会使上一次优先读取结果失效。
    private readonly priorityDiffReader: DiffReader;
    private priorityDiffLoadGeneration = 0;
    private activePriorityDiffRequest?: { readonly generation: number; readonly paths: readonly string[] };
    // Changed Files 发起的新定位会推进版本；MultiDiff 旧滚动消息只有携带当前版本才允许回写高亮。
    private multiDiffSelectionEpoch = 0;
    private readonly workingTreeDiffCache = new Map<string, readonly DiffPayload[]>();
    private readonly pendingDiffPaths = new Set<string>();
    private diffLoadScheduled = false;
    private diffLoadRunning = false;
    private readonly gitActions: GitActionRunner;
    // 仓库 / 分支 / 提交状态的唯一写入者，Provider 只读不写。
    private readonly repoSubmoduleWatcher = new RepoSubmoduleWatcher();
    private readonly repoController = new GitRepoController(this.repoSubmoduleWatcher);
    private readonly repoHeadBranchWatcher = new RepoHeadBranchWatcher(this.repoController);
    private readonly selectedRepoTotalBranchWatcher = new SelectedRepoTotalBranchWatcher(
        this.repoController,
        this.repoHeadBranchWatcher,
    );
    private readonly branchesController: GitBranchesController;
    private readonly uncommittedFilesWatcher: UncommittedFilesWatcher;
    private readonly commitController: GitCommitController;
    private readonly selectedRepoSubscription: vscode.Disposable;
    private readonly reposLoadingSubscription: vscode.Disposable;
    private readonly selectedBranchesSubscription: vscode.Disposable;
    // selectedBranches getter 每仓库只能表示一个分支；完整多选以事件快照为准。
    private selectedBranchesMap = new Map<GitRepositoryOption, GitBranchOption[]>();
    // 弹窗总列表快照只由对应 controller 的 total-list 回调写入，视图重建时仅重放。
    private totalRepoListSnapshot: readonly GitRepositoryOption[] = [];
    private totalBranchesListSnapshot: readonly GitBranchOption[] = [];
    private selectedRepoDisplaySnapshot?: { label: string; path: string; hasSubmodules: boolean; isSubmodule: boolean };
    private selectedBranchDisplaySnapshot: { label: string; title: string; names: string[]; kind?: GitBranchOption['kind'] } = {
        label: '未选择分支',
        title: '未选择分支',
        names: [],
        kind: undefined,
    };
    private hasStartedRepositoryScan = false;
    // 仓库相关 UI loading 快照只由 onReposLoadingChanged 写入。
    private reposLoadingSnapshot = false;
    // 分支相关 UI loading 快照只由 onBranchesLoadingChanged 写入。
    private branchesLoadingSnapshot = false;
    private readonly workingTreeActionQueue: Array<{
        action: 'stage' | 'unstage' | 'discard' | 'stash' | 'stashApply' | 'stashPop';
        /** 仅 stash: 要创建的 stash 范围。 */
        stashScope?: StashScope;
        /** 仅 stashApply/stashPop: 目标 stash 的提交 hash(序号会随其他 stash 操作移位，hash 才稳定)。 */
        stashHash?: string;
        section: 'conflict' | 'staged' | 'unstaged';
        paths: string[];
        untrackedPaths: ReadonlySet<string>;
        discardUntrackedToTrash: boolean;
        rootUri: vscode.Uri;
        gitlinkPaths: ReadonlySet<string>;
        affectedSubmoduleRepositoryPaths: readonly string[];
    }> = [];
    private processingWorkingTreeActions = false;
    private pendingWorkingTreeDiffPaths?: ReadonlySet<string>;
    // 主动 Git 操作期间，由操作事务统一等待当前虚拟提交的界面投影，避免 watcher 重复发起异步刷新。
    private readonly workingTreeUiMutations = new Set<string>();
    private readonly deferredWorkingTreeChanges = new Map<string, {
        changes: { staged: ChangedFile[]; changes: ChangedFile[] };
        affectedPaths?: readonly string[];
    }>();

    // 提交维度只读自控制器，Provider 不得回写、不做任何提交判定。
    private get commits(): readonly CommitMetadata[] { return this.commitController.searchedCommitList; }
    private get isLoading(): boolean { return store.getState().isLoading; }
    private set isLoading(value: boolean) { store.setState({ isLoading: value }); }
    private get loadingMessage(): string | undefined { return store.getState().loadingMessage; }
    private set loadingMessage(value: string | undefined) { store.setState({ loadingMessage: value }); }
    private get files(): ChangedFile[] { return store.getState().files; }
    private set files(value: ChangedFile[]) { store.setState({ files: value }); }
    private get filesLoading(): boolean { return store.getState().filesLoading; }
    private set filesLoading(value: boolean) { store.setState({ filesLoading: value }); }
    private get currentHash(): string | undefined { return store.getState().currentHash; }
    private get currentChangeSet(): ChangeSetMode { return store.getState().currentChangeSet; }
    private set currentChangeSet(value: ChangeSetMode) { store.setState({ currentChangeSet: value }); }
    private get displayMode(): 'tree' | 'flat' { return store.getState().displayMode; }
    private set displayMode(value: 'tree' | 'flat') { store.setState({ displayMode: value }); }
    private get selectedPath(): string | undefined { return store.getState().selectedPath; }
    private set selectedPath(value: string | undefined) { store.setState({ selectedPath: value }); }
    // 仓库与分支维度同样只读自各自的控制器。
    private get repositories(): readonly GitRepositoryOption[] { return this.repoController.totalRepoList; }
    private get branches(): readonly GitBranchOption[] { return this.branchesController.getBranches(); }
    private get selectedRepositoryPaths(): string[] { return this.repoController.selectedRepoList.map(repository => repository.path); }
    private get hasRepositorySelection(): boolean { return this.repoController.selectedRepoList.length > 0; }
    private get selectedBranches(): string[] {
        return [...this.selectedBranchesMap.values()].flat().map(branch => branch.name);
    }
    private get currentRepositoryPath(): string | undefined { return store.getState().currentRepositoryPath; }
    private updateViewVisible(): void {
        store.setState({ isViewVisible: this.view?.visible === true });
    }

    private sameChangedFileMetadata(left: ChangedFile, right: ChangedFile): boolean {
        if (left === right) { return true; }
        return new CommitFile(left).equals(new CommitFile(right));
    }

    private sameChangedFilesMetadata(left: readonly ChangedFile[], right: readonly ChangedFile[]): boolean {
        return left.length === right.length
            && left.every((file, index) => this.sameChangedFileMetadata(file, right[index]));
    }

    /** Diff 正文和进度只由 MultiDiff 消费；Changed Files 只在文件元信息变化时接收完整快照。 */
    private isDiffContentOnlyStoreChange(previous: Readonly<AppState>, current: Readonly<AppState>): boolean {
        if (previous.filesLoading || current.filesLoading) { return false; }
        const ignored = new Set<keyof AppState>(['files', 'diffLoading', 'diffError', 'diffProgress', 'selectedPath']);
        const unchangedOutsideDiff = (Object.keys(current) as (keyof AppState)[])
            .every(key => ignored.has(key) || previous[key] === current[key]);
        return unchangedOutsideDiff && this.sameChangedFilesMetadata(previous.files, current.files);
    }

    private postSelectedPathToWebview(selectedPath: string | undefined): void {
        void this.view?.webview.postMessage({ type: 'selectedPathChanged', selectedPath });
    }

    /** Store 选择变化走轻量消息，避免每次点击都克隆并发送一万条文件。 */
    private onStoreStateChanged(state: Readonly<AppState>): void {
        const previous = this.observedStoreState;
        this.observedStoreState = state;
        if (!previous) {
            this.schedulePushState();
            return;
        }
        const selectedPathChanged = previous.selectedPath !== state.selectedPath;
        const changedKeys = (Object.keys(state) as (keyof AppState)[])
            .filter(key => previous[key] !== state[key]);
        if (changedKeys.length === 1 && changedKeys[0] === 'selectedPath') {
            this.postSelectedPathToWebview(state.selectedPath);
            return;
        }
        if (this.isDiffContentOnlyStoreChange(previous, state)) {
            if (selectedPathChanged) { this.postSelectedPathToWebview(state.selectedPath); }
            return;
        }
        this.schedulePushState();
    }

    private changedFileSummary(file: ChangedFile): CommitFile {
        if (!('original' in file) && !('modified' in file)) { return file; }
        const cached = this.changedFileSummaryCache.get(file);
        if (cached) { return cached; }
        const summary = new CommitFile({
            path: file.path,
            status: file.status,
            oldPath: file.oldPath,
            oldObjectId: file.oldObjectId,
            newObjectId: file.newObjectId,
            oldMode: file.oldMode,
            newMode: file.newMode,
            isGitlink: file.isGitlink,
            oldGitlinkCommit: file.oldGitlinkCommit,
            newGitlinkCommit: file.newGitlinkCommit,
            gitlinkRangeCommits: file.gitlinkRangeCommits,
            gitlinkScanPending: file.gitlinkScanPending,
            gitlinkWorktreeDirty: file.gitlinkWorktreeDirty,
            gitlinkWorktreeChangeCount: file.gitlinkWorktreeChangeCount,
            gitlinkConflictBaseObjectId: file.gitlinkConflictBaseObjectId,
            gitlinkConflictCurrentObjectId: file.gitlinkConflictCurrentObjectId,
            gitlinkConflictIncomingObjectId: file.gitlinkConflictIncomingObjectId,
            gitlinkConflictBaseCommit: file.gitlinkConflictBaseCommit,
            gitlinkConflictCurrentCommit: file.gitlinkConflictCurrentCommit,
            gitlinkConflictIncomingCommit: file.gitlinkConflictIncomingCommit,
            isBinary: file.isBinary,
            isUntracked: file.isUntracked,
            isConflict: file.isConflict,
            workingTreeKind: file.workingTreeKind,
            diffKey: file.diffKey,
        });
        this.changedFileSummaryCache.set(file, summary);
        return summary;
    }

    // 数据驱动: Store 变更 → 推送状态快照到 Webview
    private schedulePushState(): void {
        if (this.pushStatePending) { return; }
        this.pushStatePending = true;
        queueMicrotask(() => {
            this.pushStatePending = false;
            this.pushStateToWebview();
        });
    }

    private pushStateToWebview(): void {
        if (!this.view) { return; }
        const s = store.getState();
        // Changed Files 只需要文件元信息，绝不能把 Monaco 使用的 original/modified 大文本复制到主 Webview。
        const summarizeFile = (file: ChangedFile, repositoryPath?: string) => {
            const summary = this.changedFileSummary(file);
            if (!summary.isGitlink || !repositoryPath) { return summary; }
            const target = this.repoSubmoduleWatcher.findSubmoduleRepository(repositoryPath, summary.path);
            return target ? { ...summary, gitlinkHasSubmodules: Boolean(target.hasSubmodules) } : summary;
        };
        const files = s.files.map(file => summarizeFile(file, s.currentRepositoryPath));
        this.commitPanelViewTitleController.update(s.commitRepositories);
        // 提交列表 loading 只由 GitCommitController 的加载事件驱动。
        const commitListLoading = this.commitController.isLoading;
        // 与 loadingProgress 共用同一文案来源, 避免搜索时快照里仍是"加载提交历史"。
        const commitListLoadingMessage = commitListLoading ? this.commitLoadingMessage : undefined;
        // Commit 列表与 Changed Files 必须消费同一份已发布的 Store 快照。
        // watcher 缓存可能在工作区事务收尾前先更新；若在这里直接读取，会让虚拟行先置灰、文件列表仍显示旧数据。
        // 搜索非空时, 虚拟行不是真实 commit 不经 searchCommits 过滤, 按 label 是否命中关键词决定是否产出; 未命中则不出现。
        const selectedCommitMetadata = this.commitController.selectedCommit;
        const selectedWorktreeBranch = isWorkingTreeHash(selectedCommitMetadata?.hash)
            ? selectedCommitMetadata.gitBranchOption
            : undefined;
        const currentBranch = selectedWorktreeBranch
            ?? [...this.selectedBranchesMap.values()].flat().find(branch => branch.kind === 'current');
        const workingTreeRepositoryPath = currentBranch?.repoOption.path;
        const searchKeywords = this.commitController.displayedSearchKeywords;
        const matchesSearch = (label: string): boolean =>
            searchKeywords.length === 0
            || searchKeywords.some(keyword => label.toLowerCase().includes(keyword.toLowerCase()));
        const matchingWorkingTreeRows = currentBranch
            ? s.workingTreeRows.filter(row =>
                row.repositoryPath === currentBranch.repoOption.path
                && row.headHash === currentBranch.hash
                && matchesSearch(row.label))
            : [];
        // A direct Gitlink jump prepares the child status asynchronously. Until that new virtual
        // row is ready, retain the previously published Uncommitted Changes row instead of
        // removing it from the commit list for one render pass.
        const workingTreeRows = matchingWorkingTreeRows.length > 0
            ? matchingWorkingTreeRows
            : (s.filesLoading && selectedWorktreeBranch
                ? s.workingTreeRows.filter(row => matchesSearch(row.label))
                : []);
        const workingTreeRow = workingTreeRows[0];
        const selectedRepositoryPaths = this.selectedRepositoryPaths;
        const commits = this.commitController.searchedCommitList.map(commit => ({
            ...commit,
            key: `${commit.gitBranchOption?.repoOption.path ?? ''}:${commit.hash}`,
        }));
        // 基线不在已加载列表里、没能穿插进图的 stash 数量(跨已选仓库汇总), 用于开关按钮的提示。
        const hiddenStashCount = selectedRepositoryPaths.reduce(
            (sum, repositoryPath) => sum + (this.commitController.hiddenStashCounts.get(repositoryPath) ?? 0), 0);
        // 云端提交: 每个已选仓库当前分支 HEAD..upstream 各一组; 数量取 behind(与同步按钮同源), 条目可能因上限少于数量。
        // 搜索结果不展示拓扑, 云端提交也不混入搜索。
        const cloudGroups = searchKeywords.length > 0 ? [] : this.repositories.filter(repository => selectedRepositoryPaths.includes(repository.path)).flatMap(repository => {
            const count = this.behindCommitCountByRepository.get(repository.path) ?? 0;
            if (count <= 0) { return []; }
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repository.path);
            return [{
                repositoryPath: repository.path,
                repositoryLabel: repository.label,
                branchLabel: branch?.label ?? '',
                count,
                commits: (this.cloudCommitsByRepository.get(repository.path) ?? []).map(commit => ({
                    hash: commit.hash,
                    shortHash: commit.shortHash,
                    parents: commit.parents,
                    message: commit.message,
                    body: commit.body,
                    rawMessage: commit.rawMessage,
                    author: commit.author,
                    authorEmail: commit.authorEmail,
                    authorDate: commit.authorDate,
                    authorDateLabel: commit.authorDateLabel,
                    refs: commit.refs,
                })),
            }];
        });
        const selectedCommit = selectedCommitMetadata ? {
            key: `${selectedCommitMetadata.gitBranchOption?.repoOption.path ?? ''}:${selectedCommitMetadata.hash}`,
            hash: selectedCommitMetadata.hash,
            repositoryPath: selectedCommitMetadata.gitBranchOption?.repoOption.path ?? '',
            message: selectedCommitMetadata.message,
            body: selectedCommitMetadata.body ?? '',
            rawMessage: selectedCommitMetadata.rawMessage,
            kind: (isWorkingTreeHash(selectedCommitMetadata.hash) ? selectedCommitMetadata.hash : 'commit') as ChangeSetMode,
        } : null;
        this.view.webview.postMessage({
            type: 'stateUpdate',
            state: {
                commits,
                showCommitLanes: searchKeywords.length === 0,
                cloudGroups,
                showStashes: this.showStashes,
                hiddenStashCount,
                workingTreeRows,
                uncommittedRepositoryCount: this.countUncommittedRepositories(s.commitRepositories),
                repositoryCardDisplayLocks: this.repositoryCardDisplayLocks ? [...this.repositoryCardDisplayLocks] : [],
                repositoryChanges: this.repositories.map(repository => {
                    const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                        .find(candidate => candidate.repoOption.path === repository.path);
                    const snapshot = s.commitRepositories.find(candidate => candidate.repositoryPath === repository.path);
                    return {
                        repositoryPath: repository.path,
                        repositoryLabel: repository.label,
                        repositoryAncestry: (repository.ancestry ?? []).map(ancestor => ({
                            path: ancestor.path,
                            label: ancestor.label,
                        })),
                        hasSubmodules: Boolean(repository.hasSubmodules),
                        isSubmodule: (repository.ancestry?.length ?? 0) > 0,
                        isMainRepository: repository.path === this.repositories.find(candidate => (candidate.ancestry?.length ?? 0) === 0)?.path,
                        headLabel: branch?.label ?? '',
                        // 游离 HEAD 以裸 hash 作为分支名(buildDetachedHeadBranch),具名分支一定是 refs/heads/ 全名(readHeadBranch)。
                        headDetached: branch !== undefined && !branch.name.startsWith('refs/heads/'),
                        behindCount: this.behindCommitCountByRepository.get(repository.path) ?? 0,
                        aheadCount: this.unpushedCommitCountByRepository.get(repository.path) ?? 0,
                        message: this.commitMessageByRepo.get(repository.path) ?? '',
                        committing: this.commitCommittingByRepo.has(repository.path),
                        mergeOperation: this.mergeOperations?.get(repository.path),
                        mergeOperationBusy: this.mergeOperationBusy?.has(repository.path) ?? false,
                        staged: (snapshot?.staged ?? []).map(file => summarizeFile(file, repository.path)),
                        unstaged: (snapshot?.unstaged ?? []).map(file => summarizeFile(file, repository.path)),
                    };
                }),
                stagedCount: workingTreeRow?.stagedCount ?? 0,
                changesCount: workingTreeRow?.changesCount ?? 0,
                hasMoreCommits: this.commitController.canLoadMoreCommits,
                isLoadingMoreCommits: this.commitController.isLoadingMoreCommits,
                commitPageError: this.commitController.commitPageErrorMessage,
                branches: this.branches,
                selectedRepositoryPaths,
                selectedBranches: this.selectedBranches,
                // Keep the trigger label in the same atomic snapshot as the checkbox selection.
                selectedBranchDisplay: this.selectedBranchDisplaySnapshot,
                isMultiRepository: selectedRepositoryPaths.length > 1,
                files,
                filesIdentity: { hash: s.currentHash, repositoryPath: s.currentRepositoryPath },
                stagedFiles: s.stagedFiles,
                unstagedFiles: s.unstagedFiles,
                filesLoading: s.filesLoading,
                refreshProgress: this.viewDataRefreshProgress,
                commitMessage: workingTreeRepositoryPath ? this.commitMessageByRepo.get(workingTreeRepositoryPath) ?? '' : '',
                commitEditorLoading: s.commitEditorLoading,
                diffLoading: s.diffLoading,
                diffError: s.diffError,
                diffProgress: s.diffProgress,
                filesMode: s.displayMode,
                selectedPath: s.selectedPath,
                selectedCommit,
                isLoading: commitListLoading,
                loadingMode: this.commitLoadingMode,
                loadingMessage: commitListLoadingMessage,
            },
        });
        this.repositories.forEach(repository => {
            void this.loadRepositorySyncState(repository.path);
            void this.loadRepositoryStashes(repository.path);
        });
    }

    private get selectedRepositoryPath(): string | undefined {
        return this.selectedRepositoryPaths.length === 1 ? this.selectedRepositoryPaths[0] : undefined;
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        commitEditMsgEditor: GitCommitEditMsgEditor,
    ) {
        const configuration = vscode.workspace.getConfiguration('fastergit');
        this.displayMode = configuration.get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
        this.showStashes = configuration.get<boolean>('showStashes', true);
        for (const [repositoryPath, target] of Object.entries(this.context.workspaceState.get<Record<string, StoredPushTarget>>('lastPushedTargets', {}))) {
            this.lastPushedTargetByRepository.set(repositoryPath, target);
        }
        // 订阅顺序是有意设计：仓库显示必须先于分支/提交刷新，避免下游监听器的同步前置逻辑阻塞 UI 更新。
        this.selectedRepoSubscription = this.repoController.onSelectedRepoListChanged(selected => this.onSelectedRepoListChanged(selected));
        this.reposLoadingSubscription = this.repoController.onReposLoadingChanged(loading => {
            this.reposLoadingSnapshot = loading;
            this.view?.webview.postMessage({ type: 'repoLoadingChanged', loading });
            if (!loading) { void this.refreshPendingGitlinkDiff(); }
        });
        this.branchesController = new GitBranchesController(
            this.repoController,
            this.selectedRepoTotalBranchWatcher,
        );
        this.uncommittedFilesWatcher = new UncommittedFilesWatcher(
            this.repoHeadBranchWatcher,
            this.gitBackend,
        );
        // 分支显示必须先订阅；提交 Controller 的监听器会在回调中启动刷新。
        this.selectedBranchesSubscription = this.branchesController.onSelectedBranchesChanged(branches => this.onSelectedBranchesChanged(branches));
        this.commitController = new GitCommitController(
            this.repoController,
            this.branchesController,
            this.uncommittedFilesWatcher,
            this.gitBackend,
        );
        // Controller 默认关闭；在首次读取提交之前应用用户保存的选择，避免先发布无 stash 的图再闪烁重建。
        this.commitController.setStashesVisible(this.showStashes);
        // Diff 面板顶部卡片变化时回写 selectedPath，驱动 Changed Files 高亮。
        this.mergeEditorSessions = new MergeEditorSessions(async repositoryPath => {
            await this.uncommittedFilesWatcher.refreshHeadBranch(repositoryPath);
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (branch) { await this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(branch); }
            await this.refreshCommitPanel();
        });
        this.multiDiffPanel = new MultiDiffPanel(
            (path, generation, selectionEpoch) => this.syncFileHighlightFromDiffPanel(path, generation, selectionEpoch),
            (paths, generation, priority) => this.requestCurrentDiffs(paths, generation, priority),
            identity => this.handleDiffRendered(identity),
            (path, line, column, side) => void this.openWorkspaceFileAtLine(path, line, column, side),
            (path, hash, key) => void this.selectGitlinkCommit(path, hash, key),
            () => void this.backToParentCommit(),
            (path, content) => void this.saveWorkspaceFile(path, content),
            (action, section, path) => void this.runWorkingTreeAction(action, section, path),
            this.mergeEditorSessions,
        );
        this.commitPanel = new CommitPanel({
            onMergeOperation: (repositoryPath, action) => void this.handleMergeOperation(repositoryPath, action),
            onCommit: (repositoryPath, repositoryPaths, message, amend) => void this.runCommit(repositoryPath, repositoryPaths, message, amend),
            onPush: (repositoryPaths, pullBeforePush) => void this.runCommitPanelPush(repositoryPaths, pullBeforePush),
            onPickPushBranch: repositoryPath => void this.pickCommitPanelPushTarget(repositoryPath),
            onUpdateCardState: (repositoryPath, patch) => this.updateCommitCardState(repositoryPath, patch),
            onToggleDisplayMode: () => this.dispatchIntent({ type: 'toggleFilesMode' }),
            onToggleAmend: (repositoryPath, message) => void this.toggleCommitAmend(repositoryPath, message),
            onHistory: repositoryPath => void this.pickCommitHistoryMessage(repositoryPath),
            onFocusRepository: repositoryPath => this.commitPanel.focus(repositoryPath),
            onSelectFile: (repositoryPath, section, filePath) =>
                void this.openCommitPanelWorkingTreeDiff(repositoryPath, section, filePath),
            onWorkingTreeAction: (repositoryPath, action, section, paths, untrackedPaths) =>
                void this.runCommitPanelWorkingTreeAction(repositoryPath, action, section, paths, untrackedPaths),
        });
        this.commitPanelViewTitleController = new CommitPanelViewTitleController(() => {
            this.syncCommitRepositories();
            this.commitPanel.show(this.buildCommitSnapshot());
        });
        this.diffReader = new DiffReader(this.gitBackend);
        this.priorityDiffReader = new DiffReader(this.gitBackend);
        this.gitActions = new GitActionRunner(
            repositoryPath => this.getRepoRootUri(repositoryPath),
            (_rootUri, reloadSelectors = true, refreshOnlyWhenCurrentBranchSelected?: boolean) => {
                if (refreshOnlyWhenCurrentBranchSelected !== undefined) {
                    const currentBranch = this.branches.find(branch => branch.kind === 'current');
                    if (!refreshOnlyWhenCurrentBranchSelected
                        || !currentBranch
                        || !this.selectedBranches.includes(currentBranch.name)) {
                        return Promise.resolve();
                    }
                }
                return this.refresh(reloadSelectors);
            },
            commitEditMsgEditor,
        );
        // 三个控制器只发通知；推 Webview 与串联下游都由 Provider 承担。
        context.subscriptions.push(
            this.repoController,
            this.repoSubmoduleWatcher,
            this.repoHeadBranchWatcher,
            this.selectedRepoTotalBranchWatcher,
            this.uncommittedFilesWatcher,
            // 保持 selectedRepoSubscription 在构造阶段的订阅顺序；不要移到 Controller 创建之后。
            this.selectedRepoSubscription,
            this.reposLoadingSubscription,
            this.repoHeadBranchWatcher.onEachRepoStashChanged(event => {
                void this.loadRepositoryStashes(event.repositoryPath, true);
            }),
            this.repoHeadBranchWatcher.onEachRepoRemoteRefsChanged(event => {
                // 外部 fetch 只改写 refs/remotes/*, 不会触发 HEAD 事件; 仅刷新对应卡片的 ahead/behind。
                this.invalidateRepositorySyncState([event.repositoryPath]);
                void this.loadRepositorySyncState(event.repositoryPath);
            }),
            this.repoController.ontotalRepoListChanged(repositories => {
                const known = new Set(repositories.map(repository => repository.path));
                for (const cached of [...this.stashesByRepository.keys()]) {
                    if (!known.has(cached)) {
                        this.stashesByRepository.delete(cached);
                        this.stashLoadingByRepository.delete(cached);
                        this.stashLoadsInFlight?.delete(cached);
                        this.commitController.forgetStashes(cached);
                    }
                }
                this.totalRepoListSnapshot = [...repositories];
                this.onDidChangeRepositoryStateEmitter.fire();
                this.view?.webview.postMessage({
                    type: 'totalRepoListChanged',
                    repositories,
                    selectedRepositoryPaths: this.selectedRepositoryPaths,
                });
                // 头按钮显示快照必须随列表刷新：列表项图标每次都按当前 hasSubmodules 重绘，
                // 但快照是选中时一次性写入的；增量扫描期间 hasSubmodules 会由 false 变 true，
                // 这里同步重新发布，保证下拉按钮图标与列表项一致。
                this.refreshSelectedRepoDisplaySnapshot();
                this.syncCommitRepositories();
                if (this.commitPanel.isVisible()) {
                    this.commitPanel.update(this.buildCommitSnapshot());
                }
            }),
            this.branchesController,
            this.branchesController.onTotalBranchesListChanged(branchesMap => {
                const branches = [...branchesMap.values()].flat();
                this.totalBranchesListSnapshot = branches;
                this.view?.webview.postMessage({ type: 'totalBranchesListChanged', branches });
                this.onSelectedBranchesChanged(this.branchesController.getSelectedBranchesByRepository());
            }),
            // 保持 selectedBranchesSubscription 在 GitCommitController 创建前注册，确保分支 UI 先于提交刷新。
            this.selectedBranchesSubscription,
            this.branchesController.onBranchesLoadingChanged(loading => {
                this.branchesLoadingSnapshot = loading;
                this.view?.webview.postMessage({ type: 'branchLoadingChanged', loading });
            }),
            this.commitController,
            this.commitController.onSearchedCommitsChanged(() => this.onSearchedCommitsChanged()),
            this.commitController.onTotalCommitsChanged(() => {
                const pendingPath = this.pendingRepositoryChangesDefaultPath;
                if (pendingPath) {
                    const latest = this.commitController.latestCommitOf(pendingPath);
                    if (latest) {
                        this.pendingRepositoryChangesDefaultPath = undefined;
                        this.commitController.selectCommit(latest);
                        return;
                    }
                }
                this.onSelectedCommitChanged(this.commitController.selectedCommit);
            }),
            this.commitController.onSelectedCommitChanged(commit => this.onSelectedCommitChanged(commit)),
            this.commitController.onWorkingTreeChangesChanged(event => this.onWorkingTreeChangesChanged(event.changes, event.affectedPaths)),
            this.commitController.onUncommittedPresenceChanged(() => this.schedulePushState()),
            // 状态事件维护所有仓库的未提交卡片，并同步提交图当前仓库的虚拟行。
            this.uncommittedFilesWatcher.onEachHeadBranchUncommittedFileChanged(event => {
                this.onRepositoryUncommittedFilesChanged(event.branch, event.changes);
                if (this.commitController.uncommittedRepositoryPath === event.branch.repoOption.path) {
                    this.schedulePushState();
                }
            }),
            this.uncommittedFilesWatcher.onEachHeadBranchUncommittedFileContentChanged(event => {
                this.onWorkingTreeFileContentChanged(event.branch, event.affectedPaths);
            }),
            this.commitController.onCommitsLoadingChanged(loading => {
                this.setLoading(loading, loading ? this.commitLoadingMessage : undefined);
                if (loading) { this.postLoadingProgress('commit', this.commitLoadingMessage, 0, 0); }
                this.schedulePushState();
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                const configuration = vscode.workspace.getConfiguration('fastergit');
                if (event.affectsConfiguration('fastergit.changedFilesDisplayMode')) {
                    // scope 为 application, 生效值只来自 Global, 与 update() 的写入目标一致, 回读值必然等于刚写入值。
                    this.displayMode = configuration.get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
                    if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
                }
                if (event.affectsConfiguration('fastergit.showStashes')) {
                    const visible = configuration.get<boolean>('showStashes', true);
                    if (this.showStashes !== visible) {
                        this.showStashes = visible;
                        this.commitController.setStashesVisible(visible);
                        this.schedulePushState();
                    }
                }
            }),
        );
        context.subscriptions.push(
            this.onDidChangeDiffAvailabilityEmitter,
            this.multiDiffPanel,
            this.mergeEditorSessions,
            this.commitPanel,
            this.commitPanelViewTitleController,
            new vscode.Disposable(() => {
                this.storeUnsubscribe?.();
                this.storeUnsubscribe = undefined;
                this.cancelActiveRequests();
                this.diffReader.dispose();
                this.priorityDiffReader.dispose();
                this.gitBackend.dispose();
                this.viewDisposables.forEach(disposable => disposable.dispose());
                this.viewDisposables = [];
                this.gitWatchDisposables.forEach(disposable => disposable.dispose());
                this.gitWatchDisposables = [];
            }),
        );
    }

    initializeBackground(): void {
        this.initializeGitWatchers();
        void this.refresh(true);
    }

    canShowMultiDiff(): boolean {
        return !!this.currentHash;
    }

    isGitkLoading(): boolean {
        return this.isLoading;
    }

    getWorkingTreeSummary(): {
        repositoryCount: number;
        conflictCount: number;
        stagedCount: number;
        unstagedCount: number;
        untrackedCount: number;
        repositories: Array<{ label: string; conflictCount: number; stagedCount: number; unstagedCount: number; untrackedCount: number }>;
    } {
        const repositories = store.getState().commitRepositories;
        const summaries = repositories.map(repository => ({
            label: repository.repositoryLabel,
            conflictCount: new Set([...repository.staged, ...repository.unstaged]
                .filter(file => file.isConflict)
                .map(file => file.path)).size,
            stagedCount: repository.staged.filter(file => !file.isConflict).length,
            unstagedCount: repository.unstaged.filter(file => !file.isConflict && !file.isUntracked).length,
            untrackedCount: repository.unstaged.filter(file => !file.isConflict && file.isUntracked).length,
        }));
        return {
            repositoryCount: this.countUncommittedRepositories(repositories),
            conflictCount: summaries.reduce((count, repository) => count + repository.conflictCount, 0),
            stagedCount: summaries.reduce((count, repository) => count + repository.stagedCount, 0),
            unstagedCount: summaries.reduce((count, repository) => count + repository.unstagedCount, 0),
            untrackedCount: summaries.reduce((count, repository) => count + repository.untrackedCount, 0),
            repositories: summaries,
        };
    }

    async selectCommit(hash: string, repositoryPath?: string, revealDiff = false, revealPath?: string): Promise<void> {
        const generation = ++this.commitFilesGeneration;
        this.pendingDiffPaths.clear();
        this.pendingFilesRevealGeneration = undefined;
        // 先废弃在途请求的数据: 推进各 generation 使回程结果被丢弃; abort 只做通知不阻塞。
        this.commitFilesAbortController?.abort();
        this.diffReader.stop();
        this.cancelPriorityDiffLoad();
        this.multiDiffPanel.cancelPending();
        store.setState({
            diffLoading: true,
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
        });
        if (generation !== this.commitFilesGeneration) { return; }
        const abortController = new AbortController();
        this.commitFilesAbortController = abortController;
        try {
            await this.setCommitFiles(hash, repositoryPath, generation, abortController.signal, revealDiff, revealPath);
        } catch (error: any) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.commitFilesAbortController === abortController) {
                this.commitFilesAbortController = undefined;
            }
            this.updateViewVisible();
        }
    }

    private getWorkingTreeDiffCacheKey(repositoryPath: string, hash: 'uncommitted', files: readonly CommitFile[]): string {
        const fileState = files.map(file => [
            file.diffKey,
            file.status,
            file.oldPath,
            file.oldObjectId,
            file.newObjectId,
            file.oldMode,
            file.newMode,
            file.isConflict,
            file.isUntracked,
            file.workingTreeKind,
        ].join('\u0000')).join('\u0001');
        return `${repositoryPath}\u0002${hash}\u0002${fileState}`;
    }

    private clearWorkingTreeDiffCache(repositoryPath: string): void {
        const prefix = `${repositoryPath}\u0002`;
        for (const key of this.workingTreeDiffCache.keys()) {
            if (key.startsWith(prefix)) { this.workingTreeDiffCache.delete(key); }
        }
    }

    /** 仅复用本次 Git 操作未影响且元数据未变化的 Diff，避免单文件操作重读整份工作区。 */
    private canReuseWorkingTreeDiff(
        diff: DiffPayload,
        file: CommitFile,
        affectedPaths: ReadonlySet<string>,
    ): boolean {
        const isAffected = affectedPaths.has(file.path)
            || (!!file.oldPath && affectedPaths.has(file.oldPath))
            || affectedPaths.has(diff.path)
            || (!!diff.oldPath && affectedPaths.has(diff.oldPath));
        return !isAffected
            && diff.path === file.path
            && diff.status === file.status
            && diff.oldPath === file.oldPath
            && diff.oldObjectId === file.oldObjectId
            && diff.newObjectId === file.newObjectId
            && diff.oldMode === file.oldMode
            && diff.newMode === file.newMode
            && diff.isGitlink === file.isGitlink
            && diff.isUntracked === file.isUntracked
            && diff.isConflict === file.isConflict
            && diff.workingTreeKind === file.workingTreeKind
            && diff.diffKey === file.diffKey;
    }

    private requestCurrentDiffs(paths: readonly string[], generation: number, priority = false): void {
        if (generation !== store.getState().diffGeneration) { return; }
        if (priority) {
            void this.loadPriorityDiffs(paths, generation);
            return;
        }
        paths.forEach(path => this.pendingDiffPaths.add(path));
        if (this.diffLoadScheduled || this.diffLoadRunning) { return; }
        this.diffLoadScheduled = true;
        queueMicrotask(() => void this.flushRequestedDiffs());
    }

    private cancelPriorityDiffLoad(): void {
        this.priorityDiffLoadGeneration++;
        this.priorityDiffReader.stop();
        const active = this.activePriorityDiffRequest;
        this.activePriorityDiffRequest = undefined;
        if (active) { this.multiDiffPanel.releaseDiffRequests(active.paths); }
    }

    private async loadPriorityDiffs(paths: readonly string[], generation: number): Promise<void> {
        const requestedPaths = [...new Set(paths)];
        this.cancelPriorityDiffLoad();
        // 最新点击立即使上一条优先读取失效；后台可视缓存读取使用另一 DiffReader，不会阻塞本次目标。
        const state = store.getState();
        const repositoryPath = state.currentRepositoryPath;
        const hash = state.currentHash;
        if (generation !== state.diffGeneration || !repositoryPath || !hash) {
            this.multiDiffPanel.releaseDiffRequests(requestedPaths);
            return;
        }
        const filesByKey = new Map(state.files.map(file => [file.diffKey || file.path, file]));
        const filesToRead = requestedPaths
            .map(path => filesByKey.get(path))
            .filter((file): file is ChangedFile => !!file && !('original' in file && 'modified' in file))
            .map(file => new CommitFile({ ...file }));
        if (filesToRead.length === 0) {
            this.multiDiffPanel.releaseDiffRequests(requestedPaths);
            return;
        }
        const priorityGeneration = ++this.priorityDiffLoadGeneration;
        this.activePriorityDiffRequest = { generation: priorityGeneration, paths: requestedPaths };
        let settledByStore = false;
        const rootUri = vscode.Uri.parse(repositoryPath);
        const requestGeneration = this.commitFilesGeneration;
        try {
            const diffs = await this.priorityDiffReader.readDiffs(
                rootUri,
                hash,
                filesToRead,
                isWorkingTreeHash(hash) ? 'uncommitted' : 'commit',
            );
            const current = store.getState();
            if (priorityGeneration !== this.priorityDiffLoadGeneration
                || current.diffGeneration !== generation
                || current.currentHash !== hash
                || current.currentRepositoryPath !== repositoryPath
                || requestGeneration !== this.commitFilesGeneration
                || diffs.length !== filesToRead.length) { return; }
            const loadedByKey = new Map(diffs.map(file => [file.diffKey || file.path, file]));
            const merged = current.files.map(file => loadedByKey.get(file.diffKey || file.path) ?? file);
            const loadedCount = merged.filter(file => 'original' in file && 'modified' in file).length;
            store.setState({
                files: merged,
                diffLoading: false,
                diffError: undefined,
                diffProgress: { completed: loadedCount, total: merged.length },
            });
            settledByStore = true;
            void this.refreshGitlinkDiffs(rootUri, filesToRead, requestGeneration);
        } catch (error) {
            const current = store.getState();
            if (priorityGeneration !== this.priorityDiffLoadGeneration
                || current.diffGeneration !== generation
                || current.currentHash !== hash
                || current.currentRepositoryPath !== repositoryPath) { return; }
            store.setState({ diffLoading: false, diffError: error instanceof Error ? error.message : String(error) });
            settledByStore = true;
        } finally {
            if (this.activePriorityDiffRequest?.generation === priorityGeneration) {
                this.activePriorityDiffRequest = undefined;
                if (!settledByStore) { this.multiDiffPanel.releaseDiffRequests(requestedPaths); }
            }
        }
    }

    private async flushRequestedDiffs(): Promise<void> {
        this.diffLoadScheduled = false;
        if (this.diffLoadRunning) { return; }
        const state = store.getState();
        const repositoryPath = state.currentRepositoryPath;
        const hash = state.currentHash;
        const generation = state.diffGeneration;
        if (!repositoryPath || !hash || this.pendingDiffPaths.size === 0) { return; }
        const requested = new Set(this.pendingDiffPaths);
        this.pendingDiffPaths.clear();
        const filesToRead = state.files.filter(file =>
            requested.has(file.diffKey || file.path)
            && !('original' in file && 'modified' in file),
        ).map(file => new CommitFile({ ...file }));
        if (filesToRead.length === 0) { return; }
        const rootUri = vscode.Uri.parse(repositoryPath);
        const requestGeneration = this.commitFilesGeneration;
        this.diffLoadRunning = true;
        try {
            const diffs = await this.diffReader.readDiffs(
                rootUri,
                hash,
                filesToRead,
                isWorkingTreeHash(hash) ? 'uncommitted' : 'commit',
            );
            const current = store.getState();
            if (current.diffGeneration !== generation
                || current.currentHash !== hash
                || current.currentRepositoryPath !== repositoryPath
                || requestGeneration !== this.commitFilesGeneration
                || diffs.length !== filesToRead.length) { return; }
            const loadedByKey = new Map(diffs.map(file => [file.diffKey || file.path, file]));
            const merged = current.files.map(file => loadedByKey.get(file.diffKey || file.path) ?? file);
            const loadedCount = merged.filter(file => 'original' in file && 'modified' in file).length;
            store.setState({
                files: merged,
                diffLoading: false,
                diffError: undefined,
                diffProgress: { completed: loadedCount, total: merged.length },
            });
            void this.refreshGitlinkDiffs(rootUri, filesToRead, requestGeneration);
        } catch (error) {
            const current = store.getState();
            if (current.diffGeneration !== generation
                || current.currentHash !== hash
                || current.currentRepositoryPath !== repositoryPath) { return; }
            store.setState({ diffLoading: false, diffError: error instanceof Error ? error.message : String(error) });
        } finally {
            this.diffLoadRunning = false;
            if (this.pendingDiffPaths.size > 0) {
                this.diffLoadScheduled = true;
                queueMicrotask(() => void this.flushRequestedDiffs());
            }
        }
    }

    private async selectWorkingTreeChanges(
        changes?: { staged: ChangedFile[]; changes: ChangedFile[] },
        showLoading = true,
        revealDiff = false,
        affectedPaths?: ReadonlySet<string>,
        updateWorkingTreeState = true,
        publishedWorkingTreeRows?: AppState['workingTreeRows'],
        preferredPath?: string,
    ): Promise<void> {
        const selectedBranch = this.commitController.selectedCommit?.gitBranchOption;
        const selectedHash = this.commitController.selectedCommit?.hash;
        // 未处于工作区上下文时不做任何 Diff 工作, 因此不能推进 generation。
        // 否则会把一个正在进行且健康的工作区读取请求无谓作废, 而本次又不产生终态,
        // 导致 diffLoading 永远停在 true, 面板既无卡片也无空态。
        if (!selectedBranch || !isWorkingTreeHash(selectedHash)) { return; }
        const generation = ++this.commitFilesGeneration;
        this.pendingDiffPaths.clear();
        const workingTreeChanges = changes ?? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(selectedBranch);
        if (generation !== this.commitFilesGeneration
            || !isWorkingTreeHash(this.currentHash)
            || this.currentRepositoryPath !== selectedBranch.repoOption.path) {
            return;
        }
        // porcelain 的 unmerged 记录会同时投影到 staged/changes；Changed Files 中按路径去重为独立冲突分组。
        // 优先采用 changes 侧元数据，使 Diff 右侧展示包含冲突标记的当前工作区内容。
        const conflictsByPath = new Map<string, ChangedFile>();
        workingTreeChanges.staged.filter(file => file.isConflict).forEach(file => conflictsByPath.set(file.path, file));
        workingTreeChanges.changes.filter(file => file.isConflict).forEach(file => conflictsByPath.set(file.path, file));
        const conflicts = [...conflictsByPath.values()].map(file => new CommitFile({
            ...file,
            workingTreeKind: 'conflict',
            diffKey: `conflict:${file.path}`,
        }));
        const staged = workingTreeChanges.staged.filter(file => !file.isConflict).map(file => new CommitFile({
            ...file,
            workingTreeKind: 'staged',
            diffKey: `staged:${file.path}`,
        }));
        const unstaged = workingTreeChanges.changes.filter(file => !file.isConflict).map(file => new CommitFile({
            ...file,
            workingTreeKind: file.isUntracked ? 'untracked' : 'unstaged',
            diffKey: `unstaged:${file.path}`,
        }));
        const files = [...conflicts, ...unstaged, ...staged];
        const workingTreeDiffCacheKey = this.getWorkingTreeDiffCacheKey(selectedBranch.repoOption.path, selectedHash, files);
        // Commit 列表虚拟行、Changed Files 分组与 Commit Panel 投影必须作为同一份 UI 快照发布。
        let workingTreeStatePatch: Partial<AppState> | undefined;
        if (updateWorkingTreeState) {
            const commitRepositories = store.getState().commitRepositories;
            const commitRepository = {
                repository: selectedBranch.repoOption,
                repositoryPath: selectedBranch.repoOption.path,
                repositoryLabel: selectedBranch.repoOption.label ?? path.basename(vscode.Uri.parse(selectedBranch.repoOption.path).fsPath),
                staged: [...workingTreeChanges.staged],
                unstaged: [...workingTreeChanges.changes],
            };
            const existingRepositoryIndex = commitRepositories.findIndex(repository => repository.repositoryPath === commitRepository.repositoryPath);
            const nextCommitRepositories = existingRepositoryIndex < 0
                ? [...commitRepositories, commitRepository]
                : commitRepositories.map((repository, index) => index === existingRepositoryIndex ? commitRepository : repository);
            workingTreeStatePatch = {
                workingTreeRows: publishedWorkingTreeRows
                    ?? this.buildWorkingTreeRows(selectedBranch, workingTreeChanges),
                stagedFiles: [...workingTreeChanges.staged],
                unstagedFiles: [...workingTreeChanges.changes],
                commitRepositories: nextCommitRepositories,
            };
        }
        const publishWorkingTreeFiles = (fileStatePatch: Partial<AppState>): void => {
            store.batch(() => {
                if (workingTreeStatePatch) { store.setState(workingTreeStatePatch); }
                store.setState(fileStatePatch);
            });
            if (workingTreeStatePatch && this.commitPanel.isVisible()) {
                this.commitPanel.update(this.buildCommitSnapshot());
            }
        };
        // 工作区文件列表先发布完整元数据；Diff 正文由 MultiDiff 按可视范围按需请求。
        const previousFiles = this.files;
        const previousDiffsByKey = new Map(previousFiles
            .filter((file): file is DiffPayload => file instanceof DiffPayload)
            .map(file => [file.diffKey || file.path, file]));
        const cachedDiffs = this.workingTreeDiffCache.get(workingTreeDiffCacheKey);
        const cachedDiffsByKey = new Map((cachedDiffs ?? []).map(file => [file.diffKey || file.path, file]));
        const affected = affectedPaths ?? new Set<string>();
        const loadedDiffsByKey = new Map<string, DiffPayload>();
        files.forEach(file => {
            const key = file.diffKey || file.path;
            const candidate = previousDiffsByKey.get(key) ?? cachedDiffsByKey.get(key);
            if (candidate && this.canReuseWorkingTreeDiff(candidate, file, affected)) {
                loadedDiffsByKey.set(key, candidate);
            }
        });
        const interimFiles = files.map((file, index) => {
            const loaded = loadedDiffsByKey.get(file.diffKey || file.path);
            return loaded ? new DiffPayload({ ...loaded, ...file, index }) : new CommitFile({ ...file });
        });
        const loadedCount = interimFiles.filter((file): file is DiffPayload => file instanceof DiffPayload).length;
        const fallbackSelection = resolveWorkingTreeSelection(previousFiles, interimFiles, this.selectedPath);
        const interimSelectedFile = interimFiles.find(file => (file.diffKey || file.path) === preferredPath)
            ?? interimFiles.find(file => file.path === preferredPath)
            ?? interimFiles.find(file => (file.diffKey || file.path) === fallbackSelection)
            ?? interimFiles[0];
        const rootUri = vscode.Uri.parse(selectedBranch.repoOption.path);
        this.diffReader.stop();
        this.cancelPriorityDiffLoad();
        publishWorkingTreeFiles({
            files: interimFiles,
            selectedPath: interimSelectedFile?.diffKey || interimSelectedFile?.path,
            filesLoading: false,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: loadedCount, total: files.length },
            diffGeneration: store.getState().diffGeneration + 1,
        });
        this.pendingFilesRevealGeneration = undefined;
        if (showLoading && revealDiff && this.canShowMultiDiff() && this.view?.visible) {
            this.openDiff(interimSelectedFile?.diffKey || interimSelectedFile?.path);
        }
    }

    private isAbortError(error: unknown): boolean {
        const candidate = error as { name?: string; code?: string } | undefined;
        return candidate?.name === 'AbortError' || candidate?.code === 'ABORT_ERR';
    }

    private cancelActiveRequests(): void {
        this.gitlinkNavigationAbortController?.abort();
        this.refreshAbortController?.abort();
        this.commitFilesAbortController?.abort();
        this.refreshAbortController = undefined;
        this.commitFilesAbortController = undefined;
    }

    /** 请求仓库扫描；首轮由控制器自行初始化，其后只做重扫。 */
    private requestRepositoryScan(): void {
        if (!this.hasStartedRepositoryScan) {
            this.hasStartedRepositoryScan = true;
            void this.repoController.initialize();
            return;
        }
        void this.repoController.rescan();
    }

    /** 仓库选择变化后的唯一下游入口：更新显示快照，分支和提交由各自控制器负责加载。 */
    private onSelectedRepoListChanged(selected: readonly GitRepositoryOption[]): void {
        const repository = selected.length === 1 ? selected[0] : undefined;
        this.commitFilesGeneration++;
        this.commitFilesAbortController?.abort();
        this.commitPanelDiffAbortController?.abort();
        this.diffReader.stop();
        this.cancelPriorityDiffLoad();
        if (repository) { void this.diffReader.warmup(vscode.Uri.parse(repository.path)).catch(() => undefined); }
        this.multiDiffPanel.cancelPending();
        this.pendingFilesRevealGeneration = undefined;
        store.setState({
            files: [],
            stagedFiles: [],
            unstagedFiles: [],
            workingTreeRows: [],
            selectedPath: undefined,
            currentHash: undefined,
            currentRepositoryPath: undefined,
            currentChangeSet: 'commit',
            filesLoading: selected.length > 0,
            diffLoading: selected.length > 0,
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
            diffGeneration: store.getState().diffGeneration + 1,
        });
        this.selectedRepoDisplaySnapshot = repository
            ? {
                label: repository.label, path: repository.path,
                hasSubmodules: Boolean(repository.hasSubmodules),
                isSubmodule: repository.ancestry.length > 0,
            }
            : undefined;
        this.view?.webview.postMessage({
            type: 'selectedRepoDisplayChanged',
            repository: this.selectedRepoDisplaySnapshot,
        });
        // 选择事件产生后立即同步完整状态，不能等待提交或分支事件。
        this.pushStateToWebview();
    }

    /** 父仓库和子仓库图标都依赖仓库拓扑；子模块扫描完成后须重新发布已选项。 */
    private refreshSelectedRepoDisplaySnapshot(): void {
        const current = this.repoController.selectedRepoList;
        const repository = current.length === 1 ? current[0] : undefined;
        const next = repository
            ? {
                label: repository.label, path: repository.path,
                hasSubmodules: Boolean(repository.hasSubmodules),
                isSubmodule: repository.ancestry.length > 0,
            }
            : undefined;
        if (this.selectedRepoDisplaySnapshot?.path === next?.path
            && this.selectedRepoDisplaySnapshot?.hasSubmodules === next?.hasSubmodules
            && this.selectedRepoDisplaySnapshot?.isSubmodule === next?.isSubmodule) {
            return;
        }
        this.selectedRepoDisplaySnapshot = next;
        this.view?.webview.postMessage({
            type: 'selectedRepoDisplayChanged',
            repository: next,
        });
    }

    private buildWorkingTreeRows(
        branch: GitBranchOption | undefined,
        changes: { staged: readonly ChangedFile[]; changes: readonly ChangedFile[] },
    ): AppState['workingTreeRows'] {
        if (!branch) { return []; }
        return [{
            hash: 'uncommitted',
            label: 'Uncommitted Changes',
            repositoryPath: branch.repoOption.path,
            headHash: branch.hash,
            enabled: changes.staged.length > 0 || changes.changes.length > 0,
            stagedCount: changes.staged.length,
            changesCount: changes.changes.length,
        }];
    }

    /** 仓库计数复用完整工作区清单，不为非关键的实时性额外启动一次状态探测。 */
    private countUncommittedRepositories(
        repositories: ReadonlyArray<{ staged: readonly unknown[]; unstaged: readonly unknown[] }>,
    ): number {
        return repositories.filter(repository => repository.staged.length > 0 || repository.unstaged.length > 0).length;
    }

    /** 分支选择变化后的唯一下游入口：更新显示快照，提交加载只由 CommitController 事件驱动。 */
    private onSelectedBranchesChanged(branchesMap: ReadonlyMap<GitRepositoryOption, GitBranchOption[]>): void {
        this.selectedBranchesMap = new Map([...branchesMap].map(([repository, branches]) => [repository, [...branches]]));
        const branches = [...this.selectedBranchesMap.values()].flat();
        const currentBranch = branches.find(branch => branch.kind === 'current');
        const publishedRow = store.getState().workingTreeRows[0];
        if (!currentBranch) {
            store.setState({ workingTreeRows: [] });
        } else if (publishedRow?.repositoryPath === currentBranch.repoOption.path) {
            // 同仓库切换 HEAD 时先沿用已发布状态并更新身份。若新旧清单结构相同，Controller 会去重事件；
            // 保留快照可避免非空工作区被永久重置为禁用，后续不同状态仍会由 watcher 精确覆盖。
            store.setState({ workingTreeRows: [{ ...publishedRow, headHash: currentBranch.hash }] });
        } else {
            // 切换仓库后不能展示上一仓库的状态；新仓库完整清单就绪后再覆盖占位。
            store.setState({ workingTreeRows: this.buildWorkingTreeRows(currentBranch, new WorkingTreeChanges()) });
        }
        const names = [...new Set(branches.map(branch => branch.name))];
        const displayBranch = currentBranch ?? branches[0];
        this.selectedBranchDisplaySnapshot = displayBranch && names.length === 1
            ? { label: displayBranch.label, title: displayBranch.name, names, kind: displayBranch.kind }
            : {
                label: names.length === 0 ? '未选择分支' : names.length === 1 ? branches[0].label : `已选择 ${names.length} 个分支`,
                title: names.length === 0 ? '未选择分支' : names.join(', '),
                names,
                kind: displayBranch?.kind,
            };
        // Publish the trigger label together with selectedBranches in one state snapshot;
        // separate messages could otherwise arrive in opposite order and show mismatched UI.
        this.schedulePushState();
    }

    /** 提交列表变化后的唯一下游入口：初始化卡片默认信息并推送提交列表状态。 */
    private onSearchedCommitsChanged(): void {
        this.initializeCommitMessagesFromProjectHistory();
        this.schedulePushState();
    }

    /** 每个仓库仅首次以当前项目中最新已加载的提交信息填充，之后完全由卡片输入状态接管。 */
    private initializeCommitMessagesFromProjectHistory(): void {
        for (const commit of this.commits) {
            if (commit.isStash) { continue; }
            const repositoryPath = commit.gitBranchOption?.repoOption.path;
            // rawMessage 取自 git log %B, 是未经拆分/裁剪的原始提交信息, 原样还原用户当时的输入。
            const message = (commit.rawMessage ?? commit.message).replace(/\s+$/, '');
            if (!repositoryPath || !message || this.initializedCommitMessagesByRepo.has(repositoryPath)) { continue; }
            this.commitMessageByRepo.set(repositoryPath, message);
            this.initializedCommitMessagesByRepo.add(repositoryPath);
        }
    }

    /** 任一仓库未提交变化 (来自 watcher) 时增量更新多仓库 Store, 并刷新 Commit 面板对应卡片。 */
    private onRepositoryUncommittedFilesChanged(branch: GitBranchOption, changes: WorkingTreeChanges): void {
        const repositoryPath = branch.repoOption.path;
        void this.refreshMergeOperation(repositoryPath);
        this.clearWorkingTreeDiffCache(repositoryPath);
        const label = branch.repoOption.label ?? path.basename(vscode.Uri.parse(repositoryPath).fsPath);
        const existing = store.getState().commitRepositories;
        const entry = {
            repository: branch.repoOption,
            repositoryPath,
            repositoryLabel: label,
            staged: [...changes.staged],
            unstaged: [...changes.changes],
        };
        const index = existing.findIndex(repo => repo.repositoryPath === repositoryPath);
        const next = index >= 0
            ? existing.map((repo, i) => (i === index ? entry : repo))
            : [...existing, entry];
        store.setState({ commitRepositories: next });
        this.onDidChangeWorkingTreeSummaryEmitter.fire();
        this.commitPanelViewTitleController.update(next);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    private refreshMergeOperation(repositoryPath: string): Promise<void> {
        if (!this.mergeOperationReads) { return Promise.resolve(); }
        const pending = this.mergeOperationReads.get(repositoryPath);
        if (pending) { return pending; }
        const task = readMergeOperation(vscode.Uri.parse(repositoryPath)).then(operation => {
            if (this.mergeOperations.get(repositoryPath) === operation) { return; }
            if (operation) { this.mergeOperations.set(repositoryPath, operation); }
            else { this.mergeOperations.delete(repositoryPath); }
            this.schedulePushState();
            if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        }).catch(error => console.error('[FasterGit][merge-operation]', error))
            .finally(() => this.mergeOperationReads.delete(repositoryPath));
        this.mergeOperationReads.set(repositoryPath, task);
        return task;
    }

    private async handleMergeOperation(repositoryPath: string, action: 'continue' | 'abort'): Promise<void> {
        if (!this.repositories.some(repository => repository.path === repositoryPath) || this.mergeOperationBusy.has(repositoryPath)) { return; }
        this.mergeOperationBusy.add(repositoryPath);
        try {
            const root = vscode.Uri.parse(repositoryPath);
            const operation = await readMergeOperation(root);
            if (!operation) { throw new Error('此仓库没有可继续或中止的合并操作。'); }
            if (action === 'abort') {
                const answer = await vscode.window.showWarningMessage(`中止 ${operation}？本次冲突解决结果将被丢弃，Git 将尝试恢复操作前状态。`, { modal: true }, '中止操作');
                if (answer !== '中止操作') { return; }
            }
            this.schedulePushState();
            if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
            const repository = this.repositories.find(candidate => candidate.path === repositoryPath);
            const label = repository?.label || path.basename(root.fsPath);
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `FasterGit: ${operation} ${action} (${label})`,
                cancellable: false,
            }, async progress => {
                progress.report({ message: action === 'continue' ? '正在继续 Git 操作…' : '正在中止 Git 操作…' });
                try {
                    await runMergeOperation(root, operation, action);
                } finally {
                    progress.report({ message: '正在刷新仓库状态…' });
                    await this.uncommittedFilesWatcher.refreshHeadBranch(repositoryPath);
                    const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches().find(candidate => candidate.repoOption.path === repositoryPath);
                    if (branch) { await this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(branch); }
                    await this.refreshMergeOperation(repositoryPath);
                    this.schedulePushState();
                    await this.refreshCommitPanel();
                }
            });
            void vscode.window.showInformationMessage(`FasterGit: ${operation} ${action} 完成 (${label})`);
        } catch (error) {
            void vscode.window.showErrorMessage(`FasterGit ${action} 失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.mergeOperationBusy.delete(repositoryPath);
            this.schedulePushState();
            if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        }
    }

    /** 文件内容变化不改变未提交状态，仅替换当前虚拟提交中受影响路径的 Diff 负载。 */
    private onWorkingTreeFileContentChanged(
        branch: GitBranchOption,
        affectedPaths: readonly string[],
    ): void {
        const selectedCommit = this.commitController.selectedCommit;
        if (!isWorkingTreeHash(selectedCommit?.hash)
            || selectedCommit.gitBranchOption?.repoOption.path !== branch.repoOption.path
            || selectedCommit.gitBranchOption.hash !== branch.hash) { return; }
        // Do not let a content-only event invalidate the post-mutation list refresh.
        // Re-read these paths together with the operation's own paths at the end.
        if (this.workingTreeUiMutations.has(branch.repoOption.path)) {
            this.pendingWorkingTreeDiffPaths = new Set([
                ...(this.pendingWorkingTreeDiffPaths ?? []), ...affectedPaths,
            ]);
            return;
        }
        // 内容事件覆盖工作区内容变化与 index 内容变化；DiffReader 会按 workingTreeKind 读取正确来源。
        if (affectedPaths.length > 0) { void this.refreshWorkingTreeDiffs(branch, affectedPaths); }
    }

    /** 内容事件只读取并替换已展示的目标 Diff，不重建文件清单或 Commit Panel。 */
    private async refreshWorkingTreeDiffs(branch: GitBranchOption, affectedPaths: readonly string[]): Promise<void> {
        const paths = new Set(affectedPaths);
        const files = this.files.filter((file): file is DiffPayload =>
            file instanceof DiffPayload && (paths.has(file.path) || (!!file.oldPath && paths.has(file.oldPath))),
        );
        if (files.length === 0) { return; }
        const generation = ++this.commitFilesGeneration;
        this.diffReader.stop();
        this.cancelPriorityDiffLoad();
        // 当前提交身份未变化，仅替换受影响文件的 Diff，不能进入全量加载态。
        store.setState({
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: this.files.length, total: this.files.length },
            diffGeneration: store.getState().diffGeneration + 1,
        });
        const rootUri = vscode.Uri.parse(branch.repoOption.path);
        const workingTreeHash = this.currentHash;
        // 缓存键由清单元数据组成, 无法表达工作区内容(unstaged 的 newObjectId 恒为全 0);
        //   因此每次内容重读都必须回写缓存, 否则切走再切回会拿到本次之前的旧正文。
        const cacheKey = isWorkingTreeHash(workingTreeHash)
            ? this.getWorkingTreeDiffCacheKey(branch.repoOption.path, workingTreeHash, this.files)
            : undefined;
        const refreshed = await this.diffReader.readDiffs(rootUri, 'uncommitted', files, 'uncommitted');
        if (generation !== this.commitFilesGeneration
            || !isWorkingTreeHash(this.currentHash)
            || this.currentRepositoryPath !== branch.repoOption.path
            || this.commitController.selectedCommit?.gitBranchOption?.hash !== branch.hash) { return; }
        this.applyRefreshedDiffs(refreshed);
        if (cacheKey) {
            this.workingTreeDiffCache.set(
                cacheKey,
                this.files.filter((file): file is DiffPayload => file instanceof DiffPayload),
            );
        }
    }

    // 将重读到的 Diff 负载按 diffKey/path 就地替换回 store.files, 保持原有下标与未受影响项不变。
    private applyRefreshedDiffs(refreshed: readonly DiffPayload[]): void {
        const refreshedByKey = new Map(refreshed.map(file => [file.diffKey || file.path, file]));
        const nextFiles = this.files.map((file, index) => {
            const refreshedFile = refreshedByKey.get(file.diffKey || file.path);
            return refreshedFile ? new DiffPayload({ ...refreshedFile, index }) : file;
        });
        store.setState({
            files: nextFiles,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: nextFiles.length, total: nextFiles.length },
        });
    }

    private onWorkingTreeChangesChanged(
        changes: { staged: ChangedFile[]; changes: ChangedFile[] },
        eventAffectedPaths?: readonly string[],
    ): void {
        const repositoryPath = this.commitController.uncommittedRepositoryPath;
        if (repositoryPath && this.workingTreeUiMutations.has(repositoryPath)) {
            const previous = this.deferredWorkingTreeChanges.get(repositoryPath);
            this.deferredWorkingTreeChanges.set(repositoryPath, {
                changes,
                affectedPaths: [...new Set([...(previous?.affectedPaths ?? []), ...(eventAffectedPaths ?? [])])],
            });
            return;
        }
        this.applyWorkingTreeChanges(changes, eventAffectedPaths);
    }

    private applyWorkingTreeChanges(
        changes: { staged: ChangedFile[]; changes: ChangedFile[] },
        eventAffectedPaths?: readonly string[],
    ): Promise<void> {
        // 显式 Git 操作的 pending 路径与 watcher 事件携带的受影响路径取并集,
        // 后者覆盖"状态与内容同时变化"时被编辑文件需连内容重读的场景。
        const pending = this.pendingWorkingTreeDiffPaths;
        this.pendingWorkingTreeDiffPaths = undefined;
        const affectedPaths = pending || eventAffectedPaths
            ? new Set<string>([...(pending ?? []), ...(eventAffectedPaths ?? [])])
            : undefined;
        const currentBranch = this.commitController.selectedBranches.find(branch => branch.kind === 'current');
        const workingTreeRows = this.buildWorkingTreeRows(currentBranch, changes);
        const selectedCommit = this.commitController.selectedCommit;
        const selectedBranch = selectedCommit?.gitBranchOption;
        if (isWorkingTreeHash(this.currentHash)
            && selectedCommit
            && isWorkingTreeHash(selectedCommit.hash)
            && selectedBranch
            && selectedBranch.repoOption.path === currentBranch?.repoOption.path
            && changes.staged.length === 0
            && changes.changes.length === 0) {
            // The virtual row is now disabled. Do not leave it selected: move the
            // foreground back to this repository's newest history entry.
            const latest = this.commitController.latestCommitOf(selectedBranch.repoOption.path);
            if (latest) {
                this.commitController.selectCommit(latest);
                store.setState({ workingTreeRows });
                return Promise.resolve();
            }
        }
        if (!isWorkingTreeHash(this.currentHash)
            || !selectedBranch
            || selectedBranch.repoOption.path !== currentBranch?.repoOption.path) {
            store.setState({ workingTreeRows });
            return Promise.resolve();
        }
        return this.selectWorkingTreeChanges(changes, false, false, affectedPaths, true, workingTreeRows)
            .then(() => this.refreshCommitPanel());
    }

    /** 选中提交状态与文件读取统一由该回调驱动，覆盖首次默认选择和用户选择。 */
    private onSelectedCommitChanged(commit: CommitMetadata | undefined): void {
        const hash = commit?.hash;
        const repositoryPath = commit?.gitBranchOption?.repoOption.path;
        this.reconcileGitlinkParentNavigation(hash, repositoryPath);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        // 提交内容身份由仓库和 commit id 共同组成；虚拟提交固定使用 uncommitted。
        if (hash === this.currentHash && repositoryPath === this.currentRepositoryPath) {
            this.schedulePushState();
            return;
        }
        const isVirtual = isWorkingTreeHash(hash);
        const preparedWorktree = isVirtual
            && this.pendingGitlinkWorktreeSnapshot?.repositoryPath === repositoryPath
            && this.pendingGitlinkWorktreeSnapshot.branch.hash === commit?.gitBranchOption?.hash
            ? this.pendingGitlinkWorktreeSnapshot
            : undefined;
        if (this.pendingGitlinkWorktreeSnapshot && !preparedWorktree) {
            this.pendingGitlinkWorktreeSnapshot = undefined;
        }
        if (preparedWorktree) { this.pendingGitlinkWorktreeSnapshot = undefined; }
        const requestedReveal = this.requestedDiffReveal?.hash === hash
            && this.requestedDiffReveal.repositoryPath === repositoryPath
            ? this.requestedDiffReveal
            : undefined;
        const revealDiff = Boolean(requestedReveal);
        const revealPath = requestedReveal?.path;
        if (requestedReveal) { this.requestedDiffReveal = undefined; }
        store.setState({
            currentHash: hash,
            currentRepositoryPath: repositoryPath,
            currentChangeSet: isVirtual ? hash : 'commit',
            selectedPath: undefined,
            files: [],
            stagedFiles: [],
            unstagedFiles: [],
            filesLoading: Boolean(commit),
            diffLoading: Boolean(commit),
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
        });
        this.schedulePushState();
        const shouldOpenDiff = this.restoreDiffPanelOnViewVisible || this.openDiffOnInitialVisible;
        if (shouldOpenDiff && this.view?.visible && this.currentHash) {
            this.restoreDiffPanelOnViewVisible = false;
            this.openDiffOnInitialVisible = false;
            this.openDiff();
        }
        if (!commit || !hash) { return; }
        if (isVirtual) {
            void this.selectWorkingTreeChanges(
                preparedWorktree?.changes,
                true,
                revealDiff,
                undefined,
                true,
                preparedWorktree ? this.buildWorkingTreeRows(preparedWorktree.branch, preparedWorktree.changes) : undefined,
                revealPath,
            );
        } else {
            void this.selectCommit(hash, repositoryPath, revealDiff, revealPath);
        }
    }

    private setLoading(value: boolean, message?: string): void {
        if (this.isLoading !== value) {
            this.isLoading = value;
            if (!value) { this.loadingMessage = undefined; }
            this.onDidChangeDiffAvailabilityEmitter.fire();
        }
        // 二次刷新沿用 setLoading 时也要带阶段文案，避免退回通用"加载中..."。
        if (value && message) { this.loadingMessage = message; }
        if (!value) { this.lastLoadingProgress = undefined; }
    }

    /**
     * 加载态呈现方式: 已选仓库/分支不变的就地重读用顶部进度条, 选择变化要重建列表时用全屏蒙版。
     * 进度消息必须先于状态快照到达(加载事件先发 loadingProgress 再 schedulePushState),
     *   因此它必须自带模式, 否则 Webview 会先按上一轮的模式闪一下再被纠正。
     */
    private get commitLoadingMode(): 'bar' | 'overlay' {
        return this.commitController.isInPlaceReload ? 'bar' : 'overlay';
    }

    /** 提交列表阶段文案: 搜索与重读必须区分, 否则搜索时仍挂着"加载历史提交列表"。 */
    private get commitLoadingMessage(): string {
        return this.commitController.isSearching ? '正在搜索提交...' : '正在加载历史提交列表...';
    }

    // 统一投递加载进度并记录，供 Webview 后接管时重播。
    private postLoadingProgress(phase: string, message: string, current: number, total: number): void {
        this.lastLoadingProgress = { phase, message, current, total };
        this.loadingMessage = message;
        this.view?.webview.postMessage({
            type: 'loadingProgress',
            phase,
            message,
            current,
            total,
            loadingMode: this.commitLoadingMode,
        });
    }

    private republishLoadingProgress(): void {
        const progress = this.lastLoadingProgress;
        if (!progress) { return; }
        this.view?.webview.postMessage({ type: 'loadingProgress', ...progress });
    }

    private updateMultiDiffVisibility(): void {
        if (!this.view?.visible) {
            this.restoreDiffPanelOnViewVisible = this.multiDiffPanel.isOpen();
            this.multiDiffPanel.hide();
            // 面板隐藏后不会再有渲染完成信号, 立即放行 Changed Files 列表。
            if (this.pendingFilesRevealGeneration !== undefined) {
                this.pendingFilesRevealGeneration = undefined;
                this.filesLoading = false;
            }
            return;
        }
        if (this.restoreDiffPanelOnViewVisible && !this.isLoading && this.currentHash) {
            this.restoreDiffPanelOnViewVisible = false;
            this.openDiff(this.selectedPath);
        }
    }

    /**
     * 面板从隐藏切回可见时在后台获取远程更新。
     * 只响应 hidden -> visible 的转换; 刷新按钮和首次加载仍不隐式 Fetch (见 refreshCurrentViewData)。
     */
    private onViewVisibilityChanged(view: vscode.WebviewView): void {
        const wasVisible = store.getState().isViewVisible;
        this.updateViewVisible();
        this.updateMultiDiffVisibility();
        if (!wasVisible && view.visible) {
            this.startRemoteFetch(this.repositories.map(repository => repository.path));
        }
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        const viewGeneration = ++this.viewGeneration;
        this.view = view;
        this.updateViewVisible();
        if (view.visible) {
            this.openDiffOnInitialVisible = true;
        }
        this.commitPanelViewTitleController.bindView(view, store.getState().commitRepositories);
        const setiIconRoot = this.getSetiIconRoot();
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons'),
                setiIconRoot,
            ],
        };
        view.webview.html = this.getHtml();
        // Store 订阅: 数据驱动推送到 Webview
        this.storeUnsubscribe?.();
        this.observedStoreState = store.getState();
        this.storeUnsubscribe = store.subscribe(state => this.onStoreStateChanged(state));
        this.schedulePushState();
        // 视图级订阅单独管理, onDidDispose 时一并释放, 避免反复创建累积泄漏
        this.viewDisposables.forEach(d => d.dispose());
        this.viewDisposables = [
            view.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            view.onDidChangeVisibility(() => this.onViewVisibilityChanged(view)),
            view.onDidDispose(() => {
                if (this.view === view) {
                    this.commitPanelViewTitleController.unbindView(view);
                    this.view = undefined;
                    this.updateViewVisible();
                    this.storeUnsubscribe?.();
                    this.storeUnsubscribe = undefined;
                    this.observedStoreState = undefined;
                    ++this.viewGeneration;
                    this.cancelActiveRequests();
                    this.viewDisposables.forEach(d => d.dispose());
                    this.viewDisposables = [];
                }
            }),
        ];
        this.initializingViewGeneration = viewGeneration;
        void this.initializeView(viewGeneration);
    }

    private async initializeView(viewGeneration: number): Promise<void> {
        try {
            this.initializeGitWatchers();
            if (this.viewGeneration !== viewGeneration || !this.view) { return; }
            // Store 已包含上次后台准备的选择器与提交数据时，直接复用快照，不重复读取分支和提交历史。
            if (this.hasPreparedInitialData()) {
                this.pushStateToWebview();
                // 首次进入时后台数据已就绪，立即消费一次初始化打开意图，不能留给后续 Git 操作触发。
                this.updateMultiDiffVisibility();
                if (this.openDiffOnInitialVisible && this.view?.visible && this.currentHash) {
                    this.openDiffOnInitialVisible = false;
                    this.openDiff();
                }
            } else if (this.refreshAbortController) {
                // 后台首次加载仍在进行时只复用其进度，禁止 abort 后从头重启。
                this.pushStateToWebview();
                this.republishLoadingProgress();
            } else {
                await this.refresh();
            }
        } finally {
            if (this.initializingViewGeneration === viewGeneration) {
                this.initializingViewGeneration = 0;
            }
        }
    }

    // 仓库/分支/提交均已改由控制器持有，判据一律回读控制器实时状态。
    private hasPreparedInitialData(): boolean {
        return this.repoController.totalRepoList.length > 0
            && this.branchesController.getBranches().length > 0
            && this.commitController.searchedCommitList.length > 0
            && !this.isLoading;
    }

    private initializeGitWatchers(): void {
        if (this.gitWatchDisposables.some(disposable => disposable === this.gitWatcherSentinel)) { return; }
        // 仓库缓存已由 GitRepoController 自己持有，重扫直接走它的 rescan。
        const refreshWorkspaceRepositories = () => {
            this.hasStartedRepositoryScan = false;
            void this.repoSubmoduleWatcher.initialize();
        };
        this.gitWatchDisposables.push(
            this.gitWatcherSentinel,
            vscode.workspace.onDidChangeWorkspaceFolders(refreshWorkspaceRepositories),
        );
    }

    private readonly gitWatcherSentinel = new vscode.Disposable(() => undefined);

    private queueLifecycleRefresh(): void {
        if (this.initializingViewGeneration === this.viewGeneration) { return; }
        void this.refresh();
    }

    private isRefreshCurrent(generation: number): boolean {
        return generation === this.refreshGeneration;
    }

    // 仅仓库集合可能变化时才重新发现仓库与子模块。
    async refresh(reloadSelectors = true): Promise<void> {
        const generation = ++this.refreshGeneration;
        this.refreshAbortController?.abort();
        const abortController = new AbortController();
        this.refreshAbortController = abortController;
        try {
            await this.refreshInternal(generation, abortController.signal, reloadSelectors);
        } catch (error) {
            if (!this.isAbortError(error)) { throw error; }
        } finally {
            if (this.refreshAbortController === abortController) {
                this.refreshAbortController = undefined;
            }
        }
    }


    /** 当前仓库根 URI：优先取选中提交所属仓库，回退到已选仓库。 */
    private getRepoRootUri(repositoryPath = this.currentRepositoryPath): vscode.Uri | undefined {
        const target = repositoryPath ?? this.selectedRepositoryPath;
        return target ? vscode.Uri.parse(target) : undefined;
    }

    /** 生命周期刷新入口：只负责仓库扫描与加载态。 */
    private async refreshInternal(refreshGen: number, signal?: AbortSignal, reloadSelectors = true): Promise<void> {
        if (signal?.aborted) { return; }
        if (!this.hasRepositorySelection) {
            this.postLoadingProgress('start', '初始化环境...', 0, 0);
        }
        if (reloadSelectors) { this.requestRepositoryScan(); }
        if (signal?.aborted || !this.isRefreshCurrent(refreshGen)) { return; }
        if (this.hasRepositorySelection && this.repositories.length === 0) {
            return;
        }
        this.updateViewVisible();
    }

    /**
     * 手动刷新: 重读当前提交列表和全部仓库当前 HEAD 的未提交变更, 并异步重扫仓库拓扑与分支列表,
     * 不干扰选择器生命周期。
     * 全部仓库并发刷新, 仅保证聚焦仓库的任务先创建; 每个结果独立回流界面。
     * 工作区结果通过 watcher 回流 Store, 不改变聚焦仓库、提交选择和卡片折叠状态。
     */
    private refreshCurrentViewData(): Promise<void> {
        if (this.viewDataRefresh) { return this.viewDataRefresh; }
        const focusedRepositoryPath = this.selectedRepositoryPath;
        const refreshRepository = async (repositoryPath: string): Promise<void> => {
            try {
                await this.uncommittedFilesWatcher.refreshHeadBranch(repositoryPath);
                const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                    .find(candidate => candidate.repoOption.path === repositoryPath);
                if (branch) { await this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(branch); }
            } catch (error) {
                console.warn(`无法刷新未提交文件: ${repositoryPath}`, error);
            }
            // 手动刷新同时重读 stash: 文件监听在个别环境可能漏事件, 刷新按钮是兜底。
            await this.loadRepositoryStashes(repositoryPath, true);
        };
        this.viewDataRefresh = Promise.resolve().then(async () => {
            const repositoryPaths = this.repositories.map(repository => repository.path);
            const orderedPaths = focusedRepositoryPath
                ? [focusedRepositoryPath, ...repositoryPaths.filter(repositoryPath => repositoryPath !== focusedRepositoryPath)]
                : repositoryPaths;
            const progress = { completed: 0, total: orderedPaths.length + 1 };
            this.viewDataRefreshProgress = progress;
            this.schedulePushState();
            const track = (task: Promise<void>): Promise<void> => task.finally(() => {
                progress.completed++;
                this.schedulePushState();
            });
            // Keep all local status reads and history refresh in the same critical batch so the
            // refresh button never competes with remote fetches or repository discovery for disk IO.
            const tasks = orderedPaths.map(repositoryPath => track(refreshRepository(repositoryPath)));
            tasks.push(track(this.commitController.forceRefreshCurrentSelection(true)));
            const results = await Promise.allSettled(tasks);
            // Refresh topology after the local batch; remote fetch remains an explicit Git action.
            this.requestRepositoryScan();
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') { throw failure.reason; }
        }).finally(() => {
            this.viewDataRefresh = undefined;
            this.viewDataRefreshProgress = undefined;
            this.schedulePushState();
        });
        return this.viewDataRefresh;
    }

    private async fetchRepositories(repositoryPaths: readonly string[]): Promise<void> {
        await Promise.all(repositoryPaths.map(async repositoryPath => {
            try {
                await fetchRemotes(vscode.Uri.parse(repositoryPath));
            } catch (error) {
                console.warn(`无法获取远程更新: ${repositoryPath}`, error);
            }
        }));
    }

    /** 后台 Fetch 单飞: 上一轮未结束时忽略新的可见性切换。结果由 refs/remotes 监听回流 ahead/behind。 */
    private startRemoteFetch(repositoryPaths: readonly string[]): void {
        if (this.remoteFetchRefresh || repositoryPaths.length === 0) { return; }
        const task = this.fetchRepositories(repositoryPaths).catch(error => {
            console.warn('远程更新检查失败', error);
        }).finally(() => {
            if (this.remoteFetchRefresh === task) { this.remoteFetchRefresh = undefined; }
        });
        this.remoteFetchRefresh = task;
    }

    private onMessage(message: unknown): void {
        const tagStateRequest = message as { type?: unknown; requestId?: unknown; hash?: unknown; repositoryPath?: unknown };
        if (tagStateRequest?.type === 'requestCommitTagState') {
            const { requestId, hash, repositoryPath } = tagStateRequest;
            if (typeof requestId !== 'number' || typeof hash !== 'string' || typeof repositoryPath !== 'string'
                || !this.repositories.some(repository => repository.path === repositoryPath)) { return; }
            void this.gitActions.getCommitTagState(hash, repositoryPath).then(state => {
                this.view?.webview.postMessage({
                    type: 'commitTagState', requestId, hash, repositoryPath,
                    localTagCount: state?.localTags.length ?? 0,
                    remoteTagCount: state?.remoteTags.length ?? 0,
                    pushableTagCount: state?.pushableTags.length ?? 0,
                    remoteError: state?.remoteErrors.map(error => `${error.remote}: ${error.message}`).join('\n') ?? '',
                });
            }).catch(error => {
                this.view?.webview.postMessage({
                    type: 'commitTagState', requestId, hash, repositoryPath,
                    localTagCount: 0, remoteTagCount: 0, pushableTagCount: 0,
                    remoteError: error instanceof Error ? error.message : String(error),
                });
            });
            return;
        }
        const input = message as GitkIntent;
        if (input?.type === 'repositoryChangesFile' || input?.type === 'repositoryChangesFileAction' || input?.type === 'repositoryChangesAction') {
            void this.handleRepositoryChangesIntent(input);
            return;
        }
        if (input?.type === 'commitFileAction') {
            void this.handleCommitFileAction(input);
            return;
        }
        if (!this.isGitkIntent(message)) { return; }
        this.dispatchIntent(message);
    }

    private async handleRepositoryChangesIntent(input: Extract<GitkIntent, { type: 'repositoryChangesFile' | 'repositoryChangesFileAction' | 'repositoryChangesAction' }>): Promise<void> {
        if (typeof input.repositoryPath !== 'string'
            || !this.repositories.some(repository => repository.path === input.repositoryPath)) { return; }
        try {
            if (input.type === 'repositoryChangesAction' && (input.action === 'continue' || input.action === 'abort')) {
                await this.handleMergeOperation(input.repositoryPath, input.action);
                return;
            }
            if (input.type === 'repositoryChangesAction' && input.action === 'terminal') {
                const rootUri = vscode.Uri.parse(input.repositoryPath);
                const terminalName = path.basename(rootUri.fsPath) || 'FasterGit';
                vscode.window.createTerminal({ name: `FasterGit: ${terminalName}`, cwd: rootUri }).show();
                return;
            }
            if (input.type === 'repositoryChangesAction' && input.action === 'blur') {
                this.repositoryChangesSelectionAbortController?.abort();
                this.gitlinkNavigationAbortController?.abort();
                // 折叠卡片即明确放弃该仓库的分支上下文; 下次展开从当前 HEAD 重建。
                this.branchesController.clearRepositorySelection(input.repositoryPath);
                const selected = this.repoController.selectedRepoList;
                if (selected.length === 1 && selected[0].path === input.repositoryPath) {
                    this.repoController.selectRepositories([]);
                }
                return;
            }
            if (input.type === 'repositoryChangesAction' && input.action === 'focus') {
                this.repositoryChangesSelectionAbortController?.abort();
                (this.repositoryCardDisplayLocks ?? new Set<string>()).add(input.repositoryPath);
                this.schedulePushState();
                await this.selectRepositoryChangesDefault(input.repositoryPath);
                return;
            }
            if (input.type === 'repositoryChangesFile') {
                if (typeof input.path !== 'string' || !['conflict', 'staged', 'unstaged'].includes(input.section)) { return; }
                this.repositoryCardDisplayLocks?.delete(input.repositoryPath);
                this.schedulePushState();
                await this.openCommitPanelWorkingTreeDiff(input.repositoryPath, input.section, input.path);
                return;
            }
            if (input.type === 'repositoryChangesFileAction') {
                const targetPaths = this.resolveFileActionPaths(input.path, input.paths);
                if (!['conflict', 'staged', 'unstaged'].includes(input.section)
                    || !FILE_CONTEXT_MENU_ACTIONS.includes(input.action)
                    || !targetPaths) { return; }
                const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                    .find(candidate => candidate.repoOption.path === input.repositoryPath);
                if (!branch) { void vscode.window.showWarningMessage('仓库状态已更新，请重新打开文件菜单。'); return; }
                const snapshot = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch);
                const candidates = input.section === 'staged' ? snapshot.staged : snapshot.changes;
                // The menu acts on the clicked file, or on the whole multi-selection the webview sends; stale paths are dropped.
                const files: typeof candidates = [];
                for (const targetPath of targetPaths) {
                    const match = candidates.find(candidate => candidate.path === targetPath
                        && (input.section === 'conflict' ? candidate.isConflict : !candidate.isConflict));
                    if (match) { files.push(match); }
                }
                if (files.length === 0) { void vscode.window.showWarningMessage('仓库文件已更新，请重新打开文件菜单。'); return; }
                const rootUri = vscode.Uri.parse(input.repositoryPath);
                const uriOf = (filePath: string): vscode.Uri => vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
                if (input.action === 'copyRelativePath') {
                    await vscode.env.clipboard.writeText(files.map(file => file.path).join('\n'));
                } else if (input.action === 'copyPath') {
                    await vscode.env.clipboard.writeText(files.map(file => uriOf(file.path).fsPath).join('\n'));
                } else if (input.action === 'copy' || input.action === 'revealInOS' || input.action === 'revealInExplorer') {
                    // These address a single resource; the webview disables them for a multi-selection, so use the clicked file.
                    const file = files.find(candidate => candidate.path === input.path) ?? files[0];
                    const fileUri = uriOf(file.path);
                    if (input.action === 'copy') {
                        await this.copyFileResource(fileUri);
                    } else if (file.status !== 'D' && !file.isGitlink) {
                        await vscode.commands.executeCommand(input.action === 'revealInOS' ? 'revealFileInOS' : 'revealInExplorer', fileUri);
                    }
                } else {
                    for (const file of files) {
                        const fileUri = uriOf(file.path);
                        if (input.action === 'openBefore') {
                            // A worktree file's "before" is HEAD; an added or untracked file has none.
                            if (file.status !== 'A' && !file.isUntracked && !file.isGitlink) await this.openGitRevisionFile(fileUri, 'HEAD');
                        } else if (input.action === 'openAfter') {
                            // A worktree change's "after" is what it leaves behind: the index copy for a staged file (it differs from the
                            // disk when only part of the file is staged), the file on disk for merge and unstaged files.
                            if (file.status !== 'D' && !file.isGitlink) {
                                if (input.section === 'staged') await this.openGitRevisionFile(fileUri, '');
                                else await this.openRepositoryChangesFile(fileUri, file.path);
                            }
                        } else if (file.status !== 'D' && !file.isGitlink) {
                            await this.openRepositoryChangesFile(fileUri, file.path);
                        }
                    }
                }
                return;
            }
            if (input.type === 'repositoryChangesAction' && input.action === 'discardStaged') {
                if (input.section !== 'staged' || !Array.isArray(input.paths) || !input.paths.every(file => typeof file === 'string')) { return; }
                const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                    .find(candidate => candidate.repoOption.path === input.repositoryPath);
                if (!branch) { return; }
                const snapshot = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch);
                const paths = [...new Set(input.paths)].filter(path => snapshot.staged.some(file => file.path === path));
                await this.discardRepositoryStagedChanges(input.repositoryPath, paths,
                    new Set(snapshot.staged.filter(file => file.status === 'A' || file.isUntracked).map(file => file.path)));
                return;
            }
            if (input.action === 'worktree') {
                this.repositoryCardDisplayLocks?.delete(input.repositoryPath);
                this.schedulePushState();
                await this.selectRepositoryChangesWorktree(input.repositoryPath);
                return;
            }
            if (input.action === 'branch') { await this.pickRepositoryChangesBranch(input.repositoryPath); return; }
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === input.repositoryPath);
            if (!branch) { return; }
            if (input.action === 'syncRefresh') {
                await this.runCommitPanelPush([input.repositoryPath], true, false, true);
                return;
            }
            if (input.action === 'stash') {
                if (input.section !== 'staged' && input.section !== 'unstaged') { return; }
                await this.runStashAction(input.repositoryPath, input.section);
                return;
            }
            if (!['stage', 'unstage', 'discard'].includes(input.action)
                || !['conflict', 'staged', 'unstaged'].includes(input.section)
                || !Array.isArray(input.paths) || !input.paths.every(file => typeof file === 'string')) { return; }
            const snapshot = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch);
            const candidates = input.section === 'staged' ? snapshot.staged : snapshot.changes;
            const available = candidates.filter(file => input.section === 'conflict' ? file.isConflict : !file.isConflict);
            const paths = [...new Set(input.paths)].filter(file => available.some(candidate => candidate.path === file));
            await this.runCommitPanelWorkingTreeAction(input.repositoryPath,
                input.action as 'stage' | 'unstage' | 'discard', input.section, paths,
                available.filter(file => file.isUntracked).map(file => file.path));
        } catch (error) {
            void vscode.window.showErrorMessage('仓库变更操作失败：' + (error instanceof Error ? error.message : String(error)));
        }
    }

    /** A file action targets the clicked file, or the multi-selection the webview sends with it; every path must be a safe repository-relative path. */
    private resolveFileActionPaths(filePath: string, paths: readonly string[] | undefined): string[] | undefined {
        const requested = Array.isArray(paths) && paths.length > 0 ? paths : [filePath];
        if (!requested.includes(filePath)
            || !requested.every(candidate => typeof candidate === 'string' && this.isRepositoryFilePath(candidate))) { return undefined; }
        return [...new Set(requested)];
    }

    private isRepositoryFilePath(filePath: string): boolean {
        return filePath.length > 0
            && !path.isAbsolute(filePath)
            && !filePath.includes('\\')
            && !filePath.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..');
    }

    private async discardRepositoryStagedChanges(
        repositoryPath: string,
        paths: readonly string[],
        addedPaths: ReadonlySet<string>,
    ): Promise<void> {
        if (paths.length === 0) { return; }
        const discardSelection = await this.confirmDiscardWorkingTreeChanges(paths, addedPaths);
        if (!discardSelection) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        await this.gitBackend.unstage(rootUri, discardSelection.paths);
        const trackedPaths = discardSelection.paths.filter(filePath => !addedPaths.has(filePath));
        for (const filePath of discardSelection.paths) {
            if (addedPaths.has(filePath)) {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(rootUri, filePath), {
                    recursive: true, useTrash: discardSelection.discardUntrackedToTrash,
                });
            }
        }
        if (trackedPaths.length > 0) { await this.gitBackend.discardWorktree(rootUri, trackedPaths); }
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(branch => branch.repoOption.path === repositoryPath);
        if (branch) { await this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(branch); }
    }

    private async handleCommitFileAction(input: Extract<GitkIntent, { type: 'commitFileAction' }>): Promise<void> {
        const targetPaths = this.resolveFileActionPaths(input.path, input.paths);
        if (input.hash !== this.currentHash
            || input.repositoryPath !== this.currentRepositoryPath
            || !FILE_CONTEXT_MENU_ACTIONS.includes(input.action)
            || !targetPaths) {
            void vscode.window.showWarningMessage('提交或文件已更新，请重新打开文件菜单。');
            return;
        }
        // Keep the list order of the commit so copied paths read like the file list.
        const files = this.files.filter(candidate => targetPaths.includes(candidate.path));
        if (files.length === 0) { void vscode.window.showWarningMessage('提交文件已更新，请重新打开文件菜单。'); return; }
        try {
            const rootUri = vscode.Uri.parse(input.repositoryPath);
            const uriOf = (filePath: string): vscode.Uri => vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
            if (input.action === 'copyRelativePath') {
                await vscode.env.clipboard.writeText(files.map(file => file.path).join('\n'));
            } else if (input.action === 'copyPath') {
                await vscode.env.clipboard.writeText(files.map(file => uriOf(file.path).fsPath).join('\n'));
            } else if (input.action === 'copy' || input.action === 'revealInOS' || input.action === 'revealInExplorer') {
                // These address a single resource; the webview disables them for a multi-selection, so use the clicked file.
                const file = files.find(candidate => candidate.path === input.path) ?? files[0];
                const fileUri = uriOf(file.path);
                if (input.action === 'copy') {
                    await this.copyFileResource(fileUri);
                } else if (file.status !== 'D' && !file.isGitlink) {
                    await vscode.commands.executeCommand(input.action === 'revealInOS' ? 'revealFileInOS' : 'revealInExplorer', fileUri);
                }
            } else {
                for (const file of files) {
                    if (input.action === 'openBefore') {
                        if (file.status !== 'A' && !file.isGitlink) await this.openCommitFileBefore(rootUri, input.hash, file);
                    } else if (input.action === 'openAfter') {
                        if (file.status !== 'D' && !file.isGitlink) await this.openCommitFileAfter(rootUri, input.hash, file);
                    } else if (file.status !== 'D' && !file.isGitlink) {
                        // Open the file on disk, exactly like a worktree file; a commit-content document would show as unsaved.
                        await this.openRepositoryChangesFile(uriOf(file.path), file.path);
                    }
                }
            }
        } catch (error) {
            void vscode.window.showErrorMessage('提交变更文件操作失败：' + (error instanceof Error ? error.message : String(error)));
        }
    }

    private async copyFileResource(fileUri: vscode.Uri): Promise<void> {
        try {
            await vscode.commands.executeCommand('filesExplorer.copy', fileUri);
        } catch {
            await vscode.env.clipboard.writeText(fileUri.fsPath);
            void vscode.window.showWarningMessage('当前环境不支持复制文件资源，已改为复制文件路径。');
        }
    }

    /** A normal commit's "before" is the file as its first parent had it; a renamed file is read from its old path. */
    private async openCommitFileBefore(rootUri: vscode.Uri, hash: string, file: ChangedFile): Promise<void> {
        const beforePath = file.oldPath || file.path;
        const object = `${hash}^:${beforePath}`;
        const contents = await this.gitBackend.readObjects(rootUri, [object]);
        if (contents.get(object) === undefined) {
            void vscode.window.showWarningMessage(`该提交没有修改前的版本：${beforePath}`);
            return;
        }
        const parent = await resolveRevision(rootUri, `${hash}^`);
        if (!parent) {
            void vscode.window.showWarningMessage(`该提交没有父提交：${beforePath}`);
            return;
        }
        await this.openGitRevisionFile(vscode.Uri.joinPath(rootUri, ...beforePath.split('/')), parent);
    }

    /** A normal commit's "after" is the file as that commit wrote it, shown read-only; it is not compared with the disk file. */
    private async openCommitFileAfter(rootUri: vscode.Uri, hash: string, file: ChangedFile): Promise<void> {
        const object = `${hash}:${file.path}`;
        const contents = await this.gitBackend.readObjects(rootUri, [object]);
        if (contents.get(object) === undefined) {
            void vscode.window.showWarningMessage(`该提交没有修改后的版本：${file.path}`);
            return;
        }
        await this.openGitRevisionFile(vscode.Uri.joinPath(rootUri, ...file.path.split('/')), hash);
    }

    private async openGitRevisionFile(fileUri: vscode.Uri, ref: string): Promise<void> {
        // Match VS Code Git's Source Control "Open File (HEAD)" URI contract: the git scheme with a JSON query.
        const gitUri = fileUri.with({ scheme: 'git', query: JSON.stringify({ path: fileUri.fsPath, ref }) });
        await vscode.commands.executeCommand('vscode.open', gitUri, { preview: false });
    }

    private async openRepositoryChangesFile(fileUri: vscode.Uri, filePath: string): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false,
                preview: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`无法打开文件 ${filePath}: ${message}`);
        }
    }

    private async selectRepositoryChangesWorktree(repositoryPath: string): Promise<void> {
        this.repositoryChangesSelectionAbortController?.abort();
        const abortController = new AbortController();
        this.repositoryChangesSelectionAbortController = abortController;
        try {
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (!branch) { throw new Error('目标仓库 HEAD 尚未就绪'); }
            const selectedBranch = await this.selectCommitPanelRepository(branch, abortController.signal);
            if (!selectedBranch || abortController.signal.aborted) { return; }
            const changes = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(selectedBranch);
            if (abortController.signal.aborted) { return; }
            this.pendingGitlinkWorktreeSnapshot = { repositoryPath, branch: selectedBranch, changes };
            const changed = this.commitController.selectCommit(new CommitMetadata({ hash: 'uncommitted', gitBranchOption: selectedBranch }));
            if (!changed) {
                this.pendingGitlinkWorktreeSnapshot = undefined;
                await this.selectWorkingTreeChanges(changes, false, false);
            }
        } finally {
            if (this.repositoryChangesSelectionAbortController === abortController) { this.repositoryChangesSelectionAbortController = undefined; }
        }
    }

    /** 展开仓库卡片时优先展示工作区变更; 干净仓库则回退到该仓库最新提交。 */
    private async selectRepositoryChangesDefault(repositoryPath: string): Promise<void> {
        const repository = this.repositories.find(candidate => candidate.path === repositoryPath);
        if (!repository) { return; }
        this.pendingRepositoryChangesDefaultPath = undefined;
        this.gitlinkNavigationAbortController?.abort();
        const abortController = new AbortController();
        this.repositoryChangesSelectionAbortController = abortController;
        try {
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (!branch) { return; }
            const selectedBranch = await this.selectCommitPanelRepository(branch, abortController.signal);
            if (!selectedBranch || abortController.signal.aborted) { return; }
            const changes = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(selectedBranch);
            if (abortController.signal.aborted) { return; }
            const hasChanges = changes.staged.length > 0 || changes.changes.length > 0;
            if (hasChanges) {
                this.pendingGitlinkWorktreeSnapshot = { repositoryPath, branch: selectedBranch, changes };
                const changed = this.commitController.selectCommit(new CommitMetadata({ hash: 'uncommitted', gitBranchOption: selectedBranch }));
                // Uncommitted Changes is this card's final selection: release the lock so its Commit controls
                // reach the webview in the same push as the selection.
                this.repositoryCardDisplayLocks?.delete(repositoryPath);
                this.schedulePushState();
                if (!changed) {
                    this.pendingGitlinkWorktreeSnapshot = undefined;
                    await this.selectWorkingTreeChanges(changes, false, false);
                }
                return;
            }
            const latest = this.commitController.latestCommitOf(repositoryPath);
            if (latest) {
                this.pendingGitlinkWorktreeSnapshot = undefined;
                this.commitController.selectCommit(latest);
                return;
            }
            // History may still be loading; select the empty worktree temporarily, then replace it
            // from onTotalCommitsChanged when this repository's first page arrives.
            this.pendingRepositoryChangesDefaultPath = repositoryPath;
            this.pendingGitlinkWorktreeSnapshot = { repositoryPath, branch: selectedBranch, changes };
            const changed = this.commitController.selectCommit(new CommitMetadata({ hash: 'uncommitted', gitBranchOption: selectedBranch }));
            if (!changed) {
                this.pendingGitlinkWorktreeSnapshot = undefined;
                await this.selectWorkingTreeChanges(changes, false, false);
            }
        } finally {
            if (this.repositoryChangesSelectionAbortController === abortController) { this.repositoryChangesSelectionAbortController = undefined; }
        }
    }

    private async pickRepositoryChangesBranch(repositoryPath: string): Promise<void> {
        const repository = this.repositories.find(candidate => candidate.path === repositoryPath);
        if (!repository || this.commitCommittingByRepo.has(repositoryPath)) { return; }
        const rootUri = vscode.Uri.parse(repositoryPath);
        const branches = await getGitBranches(rootUri);
        // Current/local can name the same ref. Detached HEAD is a SHA, not a local checkout target.
        const local = new Map<string, GitBranchOption>();
        const remote = new Map<string, GitBranchOption>();
        for (const branch of branches) {
            if (branch.name.startsWith('refs/heads/')
                && (!local.has(branch.name) || branch.kind === 'current')) { local.set(branch.name, branch); }
            if (branch.name.startsWith('refs/remotes/') && !branch.name.endsWith('/HEAD')) { remote.set(branch.name, branch); }
        }
        if (local.size === 0 && remote.size === 0) {
            void vscode.window.showInformationMessage('该仓库没有可切换的分支。');
            return;
        }
        const items: Array<vscode.QuickPickItem & { branch?: GitBranchOption }> = [];
        const branchTipByHash = new Map<string, BranchTip>();
        const branchHashes = [...new Set([...local.values(), ...remote.values()].map(branch => branch.hash))];
        try {
            const details = await commitDetails(rootUri, branchHashes);
            for (const detail of details) {
                const parsed = Date.parse(detail.authorDate ?? '');
                branchTipByHash.set(detail.hash, {
                    timestamp: Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000),
                    author: detail.author,
                    shortHash: detail.shortHash || detail.hash.slice(0, 8),
                    subject: (detail.subject ?? detail.message ?? '').split(/\r?\n/, 1)[0].trim(),
                });
            }
        } catch {
            // 提交信息只是显示增强; 读取失败时仍保留分支切换能力, 并回退到现有时间和短 hash。
        }
        const tipTimestamp = (branch: GitBranchOption): number =>
            branchTipByHash.get(branch.hash)?.timestamp ?? branch.tipTimestamp ?? 0;
        const byLatestTip = (left: GitBranchOption, right: GitBranchOption) =>
            tipTimestamp(right) - tipTimestamp(left) || left.label.localeCompare(right.label);
        const formatTipDate = (branch: GitBranchOption): string | undefined => {
            const timestamp = tipTimestamp(branch);
            if (timestamp <= 0) { return undefined; }
            const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
            if (elapsedSeconds < 60) { return elapsedSeconds < 10 ? '现在' : elapsedSeconds + ' 秒前'; }
            const elapsedMinutes = Math.floor(elapsedSeconds / 60);
            if (elapsedMinutes < 60) { return elapsedMinutes + ' 分钟前'; }
            const elapsedHours = Math.floor(elapsedMinutes / 60);
            if (elapsedHours < 24) { return elapsedHours + ' 小时前'; }
            const elapsedDays = Math.floor(elapsedHours / 24);
            if (elapsedDays < 7) { return elapsedDays + ' 天前'; }
            if (elapsedDays < 30) { return Math.floor(elapsedDays / 7) + ' 周前'; }
            if (elapsedDays < 365) { return Math.floor(elapsedDays / 30) + ' 个月前'; }
            return Math.floor(elapsedDays / 365) + ' 年前';
        };
        const formatDescription = (branch: GitBranchOption): string | undefined => {
            const sync = branch.kind === 'current'
                ? (() => {
                    const behind = Math.max(0, this.behindCommitCountByRepository.get(repositoryPath) ?? 0);
                    const ahead = Math.max(0, this.unpushedCommitCountByRepository.get(repositoryPath) ?? 0);
                    return behind !== 0 || ahead !== 0 ? behind + '↓ ' + ahead + '↑' : undefined;
                })()
                : undefined;
            const description = [sync, formatTipDate(branch)]
                .filter((value): value is string => Boolean(value));
            return description.length > 0 ? description.join(' $(circle-small-filled) ') : undefined;
        };
        const formatDetail = (branch: GitBranchOption): string => {
            const tip = branchTipByHash.get(branch.hash);
            return [tip?.author, tip?.shortHash ?? branch.hash.slice(0, 8), tip?.subject]
                .filter((value): value is string => Boolean(value))
                .join(' $(circle-small-filled) ');
        };
        if (local.size > 0) {
            items.push({ label: '【本地分支】' + local.size + ' 个', kind: vscode.QuickPickItemKind.Separator });
            items.push(...[...local.values()].sort((left, right) =>
                Number(right.kind === 'current') - Number(left.kind === 'current') || byLatestTip(left, right)).map(branch => ({
                label: '$(git-branch) ' + branch.label,
                description: formatDescription(branch),
                detail: formatDetail(branch),
                branch,
            })));
        }
        const byRemote = new Map<string, GitBranchOption[]>();
        for (const branch of remote.values()) {
            const remoteName = branch.name.slice('refs/remotes/'.length).split('/')[0];
            const group = byRemote.get(remoteName) ?? [];
            group.push(branch);
            byRemote.set(remoteName, group);
        }
        const latestTip = (branches: readonly GitBranchOption[]): number =>
            branches.reduce((latest, branch) => Math.max(latest, tipTimestamp(branch)), 0);
        for (const [remoteName, remoteBranches] of [...byRemote].sort(([leftName, leftBranches], [rightName, rightBranches]) =>
            latestTip(rightBranches) - latestTip(leftBranches) || leftName.localeCompare(rightName))) {
            items.push({ label: '【远程分支 / ' + remoteName + '】' + remoteBranches.length + ' 个', kind: vscode.QuickPickItemKind.Separator });
            items.push(...remoteBranches.sort(byLatestTip).map(branch => ({
                label: '$(cloud) ' + branch.label,
                description: formatDescription(branch),
                detail: formatDetail(branch),
                branch,
            })));
        }
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要签出的分支或标记',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked?.branch || picked.branch.kind === 'current') { return; }
        // checkoutBranch uses libgit2 safe checkout: conflicting local edits cause an error, not a discard.
        if (picked.branch.name.startsWith('refs/remotes/')) {
            const remoteName = picked.branch.name.slice('refs/remotes/'.length);
            const tracked = [...local.values()].find(branch => branch.upstreamName === remoteName
                || branch.upstreamName === picked.branch.name);
            if (tracked) {
                if (tracked.kind === 'current') { return; }
                await checkoutBranch(rootUri, tracked.name.slice('refs/heads/'.length));
            } else {
                const suggested = remoteName.slice(remoteName.indexOf('/') + 1);
                const localName = await vscode.window.showInputBox({
                    title: repository.label + '：创建本地跟踪分支',
                    prompt: '从 ' + remoteName + ' 创建并切换到本地分支',
                    value: suggested,
                    validateInput: value => !value.trim() || value.startsWith('-')
                        ? '请输入有效的本地分支名称'
                        : local.has('refs/heads/' + value) ? '本地分支已存在，请使用其他名称' : undefined,
                });
                if (localName === undefined) { return; }
                if (!localName.trim() || localName.startsWith('-') || local.has('refs/heads/' + localName)) {
                    throw new Error('本地跟踪分支名称为空、无效或已存在');
                }
                await checkoutRemoteBranch(rootUri, picked.branch.name, localName);
            }
        } else {
            await checkoutBranch(rootUri, picked.branch.name.slice('refs/heads/'.length));
        }
        await this.uncommittedFilesWatcher.refreshHeadBranch(repositoryPath);
        const current = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(branch => branch.repoOption.path === repositoryPath);
        if (current) { await this.uncommittedFilesWatcher.refreshUncommittedFilesByHeadBranch(current); }
        this.selectedRepoTotalBranchWatcher.refreshSelectedRepositories();
        this.schedulePushState();
    }

    private isGitkIntent(message: unknown): message is GitkIntent {
        return !!message && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string';
    }

    // MVI: Intent 先由 Store 归约状态，再由 Provider 执行声明式副作用。
    private dispatchIntent(msg: GitkIntent): void {
        for (const effect of store.dispatch(msg)) {
            this.runEffect(effect);
        }
    }

    private runEffect(effect: StoreEffect): void {
        switch (effect.type) {
            case 'webviewReady':
                this.view?.webview.postMessage({
                    type: 'totalRepoListChanged',
                    repositories: this.totalRepoListSnapshot,
                    selectedRepositoryPaths: this.selectedRepositoryPaths,
                });
                this.view?.webview.postMessage({ type: 'totalBranchesListChanged', branches: this.totalBranchesListSnapshot });
                this.view?.webview.postMessage({
                    type: 'selectedRepoDisplayChanged',
                    repository: this.selectedRepoDisplaySnapshot,
                });
                this.view?.webview.postMessage({
                    type: 'selectedBranchDisplayChanged',
                    display: this.selectedBranchDisplaySnapshot,
                });
                this.view?.webview.postMessage({ type: 'repoLoadingChanged', loading: this.reposLoadingSnapshot });
                this.view?.webview.postMessage({ type: 'branchLoadingChanged', loading: this.branchesLoadingSnapshot });
                this.pushStateToWebview();
                break;
            case 'refresh':
                void this.refreshCurrentViewData().catch(error => {
                    void vscode.window.showErrorMessage('刷新仓库数据失败：' + (error instanceof Error ? error.message : String(error)));
                });
                break;
            case 'selectRepositories': {
                if (!Array.isArray(effect.paths)) {
                    break;
                }
                const paths = new Set(effect.paths.filter((path): path is string => typeof path === 'string'));
                const selected = this.repositories.filter(repository => paths.has(repository.path));
                if (selected.length !== paths.size) {
                    break;
                }
                this.repoController.selectRepositories(selected);
                break;
            }
            case 'selectBranches': {
                if (!Array.isArray(effect.names)) {
                    break;
                }
                const names = new Set(effect.names.filter((name): name is string => typeof name === 'string'));
                this.branchesController.selectBranches(
                    this.branchesController.getBranches().filter(branch => names.has(branch.name)),
                );
                break;
            }
            case 'loadMoreCommits':
                void this.commitController.loadMoreCommits();
                break;
            case 'gitSync': {
                const repositoryPath = this.selectedRepositoryPath;
                if (repositoryPath && (effect.action === 'fetch' || effect.action === 'pull' || effect.action === 'push')) {
                    void this.gitActions.syncRepository(effect.action, repositoryPath);
                }
                break;
            }
            case 'openRepositoryTerminal': {
                const repositoryPath = this.selectedRepositoryPath;
                const rootUri = repositoryPath ? vscode.Uri.parse(repositoryPath) : undefined;
                if (!rootUri) {
                    void vscode.window.showWarningMessage('请先选择一个仓库。');
                    break;
                }
                const terminalName = path.basename(rootUri.fsPath) || 'FasterGit';
                vscode.window.createTerminal({ name: `FasterGit: ${terminalName}`, cwd: rootUri }).show();
                break;
            }
            case 'commitAction':
                if (typeof effect.action === 'string' && typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    if (effect.action === 'stashApply' || effect.action === 'stashPop' || effect.action === 'stashDrop') {
                        void this.runStashCommitAction(effect.action, effect.hash, effect.repositoryPath);
                    } else if (effect.action === 'copyHash' || !this.isStashHash(effect.hash, effect.repositoryPath)) {
                        // stash 提交不是历史提交: checkout / revert / reset 等对它没有意义，过期的菜单消息也不执行；只放行复制 hash。
                        this.gitActions.runCommitAction(effect.action, effect.hash, effect.repositoryPath);
                    }
                }
                break;
            case 'selectCommit':
                if (isWorkingTreeHash(effect.hash)) {
                    const branch = this.branchesController.getSelectedCurrentBranch();
                    if (!branch || !this.commitController.uncommittedRepositoryPath) { break; }
                    this.requestedDiffReveal = { hash: effect.hash, repositoryPath: branch.repoOption.path };
                    const changed = this.commitController.selectCommit(new CommitMetadata({ hash: effect.hash, gitBranchOption: branch }));
                    // 工作区虚拟行的底层数据是动态的: 若 identity 未变化(selectCommit 去重 return false)但当前尚未加载出该行文件,
                    //   必须显式重新加载, 否则"此前加载失败/被门禁 bail 过"的虚拟行会因去重被永久挡死、点击无反应。
                    if (!changed
                        && this.currentHash === effect.hash
                        && this.currentRepositoryPath === branch.repoOption.path) {
                        void this.selectWorkingTreeChanges(undefined, true, true).then(() => this.refreshCommitPanel());
                    }
                } else if (typeof effect.hash === 'string' && typeof effect.repositoryPath === 'string') {
                    const commit = this.findCommit(effect.hash, effect.repositoryPath);
                    if (commit) {
                        this.requestedDiffReveal = { hash: effect.hash, repositoryPath: effect.repositoryPath };
                        const changed = this.commitController.selectCommit(commit);
                        if (!changed
                            && this.currentHash === effect.hash
                            && this.currentRepositoryPath === effect.repositoryPath) {
                            this.requestedDiffReveal = undefined;
                            this.openDiff(this.selectedPath);
                        }
                    }
                }
                break;
            case 'selectFile':
                if (typeof effect.path === 'string') {
                    this.selectChangedFile(effect.path);
                }
                break;
            case 'copyFilePath':
                if (typeof effect.path === 'string') {
                    const rootUri = effect.absolute === true ? this.getRepoRootUri() : undefined;
                    const value = rootUri
                        ? vscode.Uri.joinPath(rootUri, ...effect.path.split('/')).fsPath
                        : effect.path;
                    void vscode.env.clipboard.writeText(value);
                }
                break;
            case 'workingTreeAction':
                void this.runWorkingTreeAction(effect.action, effect.section, effect.path, undefined, effect.paths);
                break;
            case 'toggleStashes': {
                const visible = typeof effect.visible === 'boolean' ? effect.visible : !this.showStashes;
                this.showStashes = visible;
                this.commitController.setStashesVisible(visible);
                this.schedulePushState();
                // application + Global: 跟随用户/profile，而不是某个仓库；下次打开视图或重启 VS Code 时直接恢复。
                void vscode.workspace.getConfiguration('fastergit').update(
                    'showStashes',
                    visible,
                    vscode.ConfigurationTarget.Global,
                );
                break;
            }
            case 'workingTreeCommit':
                if (typeof effect.action === 'string'
                    && typeof effect.repositoryPath === 'string'
                    && typeof effect.message === 'string') {
                    void this.runWorkingTreeCommit(effect.action, effect.repositoryPath, effect.message);
                }
                break;
            case 'updateCommitMessage':
                if (typeof effect.repositoryPath === 'string' && typeof effect.message === 'string') {
                    this.updateWorkingTreeCommitMessage(effect.repositoryPath, effect.message);
                }
                break;
            case 'openCommitEditor':
                void this.runOpenCommitEditor(effect.repositoryPath, effect.amend);
                break;
            case 'openCommitPanel':
                // 打开面板前先同步仓库和工作区快照，避免复用过期的空卡片。
                this.syncCommitRepositories();
                this.commitPanel.show(this.buildCommitSnapshot(), this.selectedRepositoryPath);
                this.repoController.totalRepoList.forEach(repository => {
                    if (repository.hasSubmodules) {
                        void this.loadUnpushedCommitState(repository.path);
                        void this.loadDefaultPushTarget(repository.path);
                    }
                });
                break;
            case 'toggleFilesDisplayModeSetting': {
                const configuration = vscode.workspace.getConfiguration('fastergit');
                const currentDisplayMode = configuration.get<'tree' | 'flat'>('changedFilesDisplayMode', 'flat');
                void configuration.update(
                    'changedFilesDisplayMode',
                    currentDisplayMode === 'tree' ? 'flat' : 'tree',
                    vscode.ConfigurationTarget.Global,
                );
                break;
            }
            case 'search': {
                // 搜索与去重一律由提交控制器裁决，Provider 不再自行读提交。
                if (typeof effect.keywords !== 'string') { break; }
                const keywords = effect.keywords.trim().split(/\s+/).filter(k => k.length > 0);
                void this.commitController.search(keywords);
                break;
            }
        }
    }

    private findCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        return this.commitController.findCommit(hash, repositoryPath)
            ?? this.findCloudCommit(hash, repositoryPath)
            ?? this.findStashCommit(hash, repositoryPath);
    }

    /** stash 提交不在任何提交列表里；像云端提交一样合成一个挂在当前分支上的 CommitMetadata，才能被选中。 */
    private findStashCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        const stash = this.stashesByRepository.get(repositoryPath)?.find(entry => entry.hash === hash);
        if (!stash) { return undefined; }
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(candidate => candidate.repoOption.path === repositoryPath)
            ?? this.branchesController.getCurrentBranch(this.repositories.find(repository => repository.path === repositoryPath)!);
        return new CommitMetadata({ ...stash, gitBranchOption: branch });
    }

    private isStashHash(hash: string, repositoryPath: string): boolean {
        return this.stashesByRepository.get(repositoryPath)?.some(entry => entry.hash === hash) === true;
    }

    /** Coalesce overlapping refreshes, but re-read if invalidated during I/O. */
    private async loadRepositoryStashes(repositoryPath: string, force = false): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        if (!force && this.stashesByRepository.has(repositoryPath)) { return; }
        const loads = this.stashLoadsInFlight ??= new Map();
        const pending = loads.get(repositoryPath);
        if (pending) {
            pending.dirty ||= force;
            return pending.promise;
        }
        const request = { dirty: false, promise: Promise.resolve() };
        loads.set(repositoryPath, request);
        request.promise = (async () => {
            do {
                // Collapse same-turn watcher/explicit requests before starting I/O.
                await Promise.resolve();
                request.dirty = false;
                const generation = (this.stashLoadingByRepository.get(repositoryPath) ?? 0) + 1;
                this.stashLoadingByRepository.set(repositoryPath, generation);
                const stashes = await getStashes(rootUri);
                if (loads.get(repositoryPath) !== request
                    || this.stashLoadingByRepository.get(repositoryPath) !== generation) { return; }
                if (request.dirty) { continue; }
                const previous = this.stashesByRepository.get(repositoryPath);
                this.stashesByRepository.set(repositoryPath, stashes);
                const unchanged = previous !== undefined
                    && previous.length === stashes.length
                    && previous.every((entry, index) => entry.hash === stashes[index].hash && entry.stashIndex === stashes[index].stashIndex);
                if (unchanged) { return; }
                this.commitController.setStashes(repositoryPath, stashes);
                this.schedulePushState();
            } while (request.dirty);
        })().finally(() => {
            if (loads.get(repositoryPath) === request) { loads.delete(repositoryPath); }
        });
        return request.promise;
    }

    /**
     * 云端提交(HEAD..upstream)不在本地提交列表里, 但它的对象已随 fetch 进入本地对象库,
     * 变更文件与 Diff 都按 hash 读取, 因此可以像普通提交一样被选中。
     */
    private findCloudCommit(hash: string, repositoryPath: string): CommitMetadata | undefined {
        const cloud = this.cloudCommitsByRepository.get(repositoryPath)?.find(commit => commit.hash === hash);
        if (!cloud) { return undefined; }
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(candidate => candidate.repoOption.path === repositoryPath)
            ?? this.branchesController.getCurrentBranch(this.repositories.find(repository => repository.path === repositoryPath)!);
        return new CommitMetadata({ ...cloud, gitBranchOption: branch });
    }

    private async runOpenCommitEditor(repositoryPath: string, amend: boolean): Promise<void> {
        try {
            this.commitAmendByRepo.set(repositoryPath, amend);
            this.syncCommitRepositories();
            // 打开时展示所有仓库卡片, 并定位到触发提交的那个仓库。
            this.commitPanel.show(this.buildCommitSnapshot(), repositoryPath);
            this.repoController.totalRepoList.forEach(repository => {
                if (repository.hasSubmodules) { void this.loadDefaultPushTarget(repository.path); }
            });
        } finally {
            store.setState({ commitEditorLoading: false });
        }
    }

    /** Commit Panel 文件点击统一切到对应仓库的虚拟提交，再由同一 MultiDiff 入口激活并定位。 */
    private async openCommitPanelWorkingTreeDiff(
        repositoryPath: string,
        section: 'conflict' | 'staged' | 'unstaged',
        filePath: string,
    ): Promise<void> {
        this.commitPanelDiffAbortController?.abort();
        const abortController = new AbortController();
        this.commitPanelDiffAbortController = abortController;
        try {
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (!branch) { return; }
            const revealPath = `${section}:${filePath}`;
            // Commit 面板的 conflict/staged/unstaged 分组统一对应合并后的 'uncommitted' 虚拟行。
            const targetHash = 'uncommitted' as const;
            const isCurrentWorkingTree = this.currentHash === targetHash
                && this.currentRepositoryPath === repositoryPath;
            if (isCurrentWorkingTree) {
                // Repository Changes can publish the conflict row before the selected worktree snapshot has rebuilt MultiDiff.
                const hasTarget = this.files.some(file => (file.diffKey || file.path) === revealPath);
                if (!hasTarget) {
                    const changes = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch);
                    if (abortController.signal.aborted) { return; }
                    await this.selectWorkingTreeChanges(changes, false, false, undefined, false, undefined, revealPath);
                    if (abortController.signal.aborted) { return; }
                }
                if (this.currentHash === targetHash && this.currentRepositoryPath === repositoryPath
                    && this.files.some(file => (file.diffKey || file.path) === revealPath)) {
                    this.selectChangedFile(revealPath);
                }
                return;
            }
            if (!isCurrentWorkingTree) {
                const selectedBranch = await this.selectCommitPanelRepository(branch, abortController.signal);
                if (!selectedBranch || abortController.signal.aborted) { return; }
                const nextGeneration = this.commitFilesGeneration + 1;
                const changed = this.commitController.selectCommit(new CommitMetadata({ hash: targetHash, gitBranchOption: selectedBranch }));
                const selectionIsLoading = this.currentHash === targetHash
                    && this.currentRepositoryPath === repositoryPath
                    && store.getState().diffLoading;
                if (changed || selectionIsLoading) {
                    const generation = changed ? nextGeneration : this.commitFilesGeneration;
                    const loaded = await this.waitForWorkingTreeSelection(repositoryPath, targetHash, generation, abortController.signal);
                    if (!loaded || abortController.signal.aborted) { return; }
                }
            }
            if (this.currentHash !== targetHash
                || this.currentRepositoryPath !== repositoryPath
                || store.getState().diffLoading
                || !this.files.some(file => (file.diffKey || file.path) === revealPath)) { return; }
            this.selectChangedFile(revealPath);
        } finally {
            if (this.commitPanelDiffAbortController === abortController) {
                this.commitPanelDiffAbortController = undefined;
            }
        }
    }

    private selectCommitPanelRepository(branch: GitBranchOption, signal: AbortSignal): Promise<GitBranchOption | undefined> {
        if (signal.aborted) { return Promise.resolve(undefined); }
        const repositoryPath = branch.repoOption.path;
        const isTargetRepositorySelected = (): boolean => {
            const selectedRepositories = this.repoController.selectedRepoList;
            return selectedRepositories.length === 1 && selectedRepositories[0].path === repositoryPath;
        };
        const current = this.branchesController.getCurrentBranch(branch.repoOption);
        if (isTargetRepositorySelected() && current) { return Promise.resolve(current); }
        return new Promise(resolve => {
            const subscriptions: vscode.Disposable[] = [];
            const finish = (result?: GitBranchOption): void => {
                subscriptions.forEach(subscription => subscription.dispose());
                signal.removeEventListener('abort', cancel);
                resolve(result);
            };
            const tryFinish = (): void => {
                const currentBranch = this.branchesController.getCurrentBranch(branch.repoOption);
                if (currentBranch && isTargetRepositorySelected()) { finish(currentBranch); }
            };
            const cancel = (): void => finish();
            subscriptions.push(this.branchesController.onSelectedBranchesChanged(() => tryFinish()));
            subscriptions.push(this.branchesController.onTotalBranchesListChanged(() => tryFinish()));
            signal.addEventListener('abort', cancel, { once: true });
            this.repoController.selectRepositories([branch.repoOption]);
            tryFinish();
        });
    }

    private waitForWorkingTreeSelection(repositoryPath: string, targetHash: 'uncommitted', generation: number, signal: AbortSignal): Promise<boolean> {
        return new Promise(resolve => {
            const complete = (): boolean => this.commitFilesGeneration >= generation
                && this.currentHash === targetHash
                && this.currentRepositoryPath === repositoryPath
                && !store.getState().diffLoading;
            if (complete()) { resolve(true); return; }
            const finish = (loaded: boolean): void => {
                unsubscribe();
                signal.removeEventListener('abort', cancel);
                resolve(loaded);
            };
            const cancel = (): void => finish(false);
            const unsubscribe = store.subscribeSelector(
                state => `${state.currentRepositoryPath ?? ''}\u0000${state.currentHash ?? ''}\u0000${state.diffGeneration}\u0000${state.diffLoading}`,
                () => {
                    if (complete()) { finish(true); }
                },
            );
            signal.addEventListener('abort', cancel, { once: true });
        });
    }

    /** 以完整仓库拓扑构造 Commit editor 卡片；HEAD 与工作区状态仅补充卡片内容。 */
    private syncCommitRepositories(): void {
        const currentBranchesByPath = new Map(this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .map(branch => [branch.repoOption.path, branch]));
        const repositories = this.repoController.totalRepoList.map(repository => {
            const repositoryPath = repository.path;
            const branch = currentBranchesByPath.get(repositoryPath);
            // CommitPanel 始终消费 watcher 的全仓库 HEAD 快照；Changed Files 的 stagedFiles/unstagedFiles 只是当前选中虚拟行投影。
            const changes = branch
                ? this.uncommittedFilesWatcher.getCachedUncommittedFilesByHeadBranch(branch)
                    ?? { staged: [], changes: [] }
                : { staged: [], changes: [] };
            return {
                repository,
                repositoryPath,
                repositoryLabel: repository.label,
                staged: [...changes.staged],
                unstaged: [...changes.changes],
            };
        });
        store.setState({ commitRepositories: repositories });
    }

    /** 卡片交互状态由 Provider 保存，后续 UI 只能从快照重建。 */
    private updateCommitCardState(repositoryPath: string, patch: CommitCardStatePatch): void {
        if (patch.message !== undefined) { this.commitMessageByRepo.set(repositoryPath, patch.message); }
        if (patch.selectedCommitSubmoduleRepositoryPaths !== undefined) {
            this.selectedCommitSubmodulesByRepo.set(repositoryPath, [...patch.selectedCommitSubmoduleRepositoryPaths]);
        }
        if (patch.selectedPushSubmoduleRepositoryPaths !== undefined) {
            this.selectedPushSubmodulesByRepo.set(repositoryPath, [...patch.selectedPushSubmoduleRepositoryPaths]);
        }
        if (patch.pullBeforePush !== undefined) { this.pullBeforePushByRepo.set(repositoryPath, patch.pullBeforePush); }
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    /** 从扩展层多仓库 Store 组装卡片; 模板为重开销, 展开时懒加载。 */
    private buildCommitSnapshot(): CommitPanelSnapshot {
        const currentBranchesByPath = new Map(this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .map(branch => [branch.repoOption.path, branch]));
        const repositoriesByPath = new Map(this.repoController.totalRepoList
            .map(repository => [repository.path, repository]));
        // 先同步完整仓库列表，再生成卡片，保证 changes 与 CommitPanel 使用同一份仓库快照。
        const cards = store.getState().commitRepositories.map(repo => {
            const repository = repositoriesByPath.get(repo.repositoryPath) ?? repo.repository;
            const amend = this.commitAmendByRepo.get(repo.repositoryPath) === true;
            const headKey = `${repo.repositoryPath}\u0000${currentBranchesByPath.get(repo.repositoryPath)?.hash ?? ''}`;
            const committedFiles = amend ? this.amendCommittedFilesByHead.get(headKey) ?? [] : [];
            const conflictsByPath = new Map<string, ChangedFile>();
            repo.staged.filter(file => file.isConflict).forEach(file => conflictsByPath.set(file.path, file));
            // 冲突差异应优先展示工作区投影，以便看到冲突标记并直接编辑。
            repo.unstaged.filter(file => file.isConflict).forEach(file => conflictsByPath.set(file.path, file));
            const toCommitPanelFile = (file: ChangedFile) => ({
                path: file.path,
                status: file.status,
                isUntracked: file.isUntracked,
                isSubmodule: file.isGitlink || file.oldMode === '160000' || file.newMode === '160000',
            });
            return {
                repositoryPath: repo.repositoryPath,
                repositoryLabel: repository.label,
                repositoryHasSubmodules: Boolean(repository.hasSubmodules),
                repositoryParentPath: repository.ancestry.at(-1)?.path,
                repositoryAncestry: repository.ancestry,
                message: this.commitMessageByRepo.get(repo.repositoryPath) ?? '',
                selectedCommitSubmoduleRepositoryPaths: this.selectedCommitSubmodulesByRepo.get(repo.repositoryPath) ?? [],
                selectedPushSubmoduleRepositoryPaths: this.selectedPushSubmodulesByRepo.get(repo.repositoryPath) ?? [],
                pullBeforePush: this.pullBeforePushByRepo.get(repo.repositoryPath) ?? true,
                pushTargetLabel: (this.lastPushedTargetByRepository.get(repo.repositoryPath)
                    ?? this.pushTargetByRepository.get(repo.repositoryPath))?.remoteName,
                amend,
                committedFiles: committedFiles.map(file => ({ path: file.path, status: file.status, isUntracked: file.isUntracked, isSubmodule: file.isGitlink || file.oldMode === '160000' || file.newMode === '160000' })),
                committedFilesLoading: amend && this.amendCommittedFilesLoading.has(headKey),
                latestCommitSubmodulePaths: this.commitGitlinkPathsByHead.get(headKey) ?? [],
                hasUnpushedCommits: (this.unpushedCommitCountByRepository.get(repo.repositoryPath) ?? 0) > 0,
                unpushedCommitCount: this.unpushedCommitCountByRepository.get(repo.repositoryPath) ?? 0,
                changedSubmoduleRepositoryPaths: [...repo.staged, ...repo.unstaged]
                    .filter(file => file.isGitlink || file.oldMode === '160000' || file.newMode === '160000')
                    .map(file => path.resolve(vscode.Uri.parse(repo.repositoryPath).fsPath, file.path))
                    .map(repositoryPath => this.repoController.totalRepoList.find(repository =>
                        path.normalize(vscode.Uri.parse(repository.path).fsPath).toLowerCase() === path.normalize(repositoryPath).toLowerCase(),
                    )?.path)
                    .filter((repositoryPath): repositoryPath is string => Boolean(repositoryPath)),
                conflictFiles: [...conflictsByPath.values()].map(toCommitPanelFile),
                mergeOperation: this.mergeOperations?.get(repo.repositoryPath),
                mergeOperationBusy: this.mergeOperationBusy?.has(repo.repositoryPath) ?? false,
                stagedFiles: repo.staged.filter(file => !file.isConflict).map(toCommitPanelFile),
                unstagedFiles: repo.unstaged.filter(file => !file.isConflict).map(toCommitPanelFile),
                committing: this.commitCommittingByRepo.has(repo.repositoryPath),
            } satisfies CommitCard;
        });
        return { cards, displayMode: store.getState().displayMode };
    }

    /** 刷新提交面板内容 (add/restore 或工作区变化后): 先同步多仓库 Store 再重建卡片。 */
    private async refreshCommitPanel(): Promise<void> {
        if (!this.commitPanel.isVisible()) { return; }
        this.syncCommitRepositories();
        this.commitPanel.update(this.buildCommitSnapshot());
        this.repoController.totalRepoList.forEach(repository => {
            if (repository.hasSubmodules) {
                void this.loadUnpushedCommitState(repository.path);
            }
        });
    }

    private async loadUnpushedCommitState(repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
        if (!rootUri || !branch) { return; }
        const headKey = `${repositoryPath}\u0000${branch.hash}`;
        if (this.unpushedStateLoadedByHead.has(headKey) || this.unpushedStateLoadingByHead.has(headKey)) { return; }
        this.unpushedStateLoadingByHead.add(headKey);
        try {
            const [ahead, gitlinkPaths] = await Promise.all([
                getGitAheadCount(rootUri),
                getGitlinkPathsInCommit(rootUri, branch.hash),
            ]);
            const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (currentBranch?.hash === branch.hash) {
                this.unpushedCommitCountByRepository.set(repositoryPath, ahead);
                this.commitGitlinkPathsByHead.set(headKey, gitlinkPaths);
                this.unpushedStateLoadedByHead.add(headKey);
            }
        } finally {
            this.unpushedStateLoadingByHead.delete(headKey);
        }
        await this.refreshCommitPanel();
    }

    /** 缺省 revision 视为 0, 读取与比较必须走同一入口, 否则 undefined !== 0 会让旧结果判定永远不一致。 */
    private repositorySyncRevision(repositoryPath: string): number {
        return this.repositorySyncRevisionByRepository.get(repositoryPath) ?? 0;
    }

    private async loadRepositorySyncState(repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
        if (!rootUri || !branch) { return; }
        const branchKey = `${branch.name}\u0000${branch.hash}`;
        if (this.repositorySyncKeyByRepository.get(repositoryPath) === branchKey) { return; }
        const revision = this.repositorySyncRevision(repositoryPath);
        const headKey = `${repositoryPath}\u0000${branchKey}`;
        if (this.repositorySyncStateLoadingByHead.has(headKey)) { return; }
        this.repositorySyncStateLoadingByHead.add(headKey);
        try {
            const [syncState, cloudCommits] = await Promise.all([getGitAheadBehind(rootUri), getCloudCommits(rootUri)]);
            const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            if (currentBranch?.name !== branch.name || currentBranch.hash !== branch.hash
                || this.repositorySyncRevision(repositoryPath) !== revision) { return; }
            this.unpushedCommitCountByRepository.set(repositoryPath, syncState.ahead);
            this.behindCommitCountByRepository.set(repositoryPath, syncState.behind);
            this.cloudCommitsByRepository.set(repositoryPath, cloudCommits);
            this.repositorySyncKeyByRepository.set(repositoryPath, branchKey);
            this.schedulePushState();
            if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        } finally {
            this.repositorySyncStateLoadingByHead.delete(headKey);
            if (this.repositorySyncRevision(repositoryPath) !== revision) {
                // 拉取与旧查询并发时, 旧查询不能回写; 等它释放 loading 锁后重读最新远程跟踪 ref。
                void this.loadRepositorySyncState(repositoryPath);
            }
        }
    }

    private async loadAmendCommittedFiles(repositoryPath: string): Promise<void> {
        const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
        if (!branch) { return; }
        const key = `${repositoryPath}\u0000${branch.hash}`;
        if (this.amendCommittedFilesByHead.has(key) || this.amendCommittedFilesLoading.has(key)) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        this.amendCommittedFilesLoading.add(key);
        await this.refreshCommitPanel();
        try {
            const files = await getCommitFiles(rootUri, branch.hash);
            const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(currentBranch => currentBranch.repoOption.path === repositoryPath);
            if (this.commitAmendByRepo.get(repositoryPath) === true && currentBranch?.hash === branch.hash) {
                this.amendCommittedFilesByHead.set(key, files);
            }
        } finally {
            this.amendCommittedFilesLoading.delete(key);
            await this.refreshCommitPanel();
        }
    }

    private async toggleCommitAmend(repositoryPath: string, message: string): Promise<void> {
        // 由宿主权威状态翻转该仓库的 amend, 不接收 webview 传来的目标值。
        const amend = !(this.commitAmendByRepo.get(repositoryPath) === true);
        if (amend) {
            this.commitMessageBeforeAmendByRepo.set(repositoryPath, message);
        }
        this.commitAmendByRepo.set(repositoryPath, amend);
        if (amend) {
            void this.loadAmendCommittedFiles(repositoryPath);
        } else {
            await this.refreshCommitPanel();
        }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const nextMessage = amend
            ? await readCurrentCommitMessage(rootUri)
            : this.commitMessageBeforeAmendByRepo.get(repositoryPath) ?? '';
        this.commitMessageByRepo.set(repositoryPath, nextMessage);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        if (!amend) {
            this.commitMessageBeforeAmendByRepo.delete(repositoryPath);
        }
    }

    /**
     * 历史提交信息选择器: 直接取当前项目已加载的提交历史(totalCommitList), 既不再执行 git log,
     * 也不受搜索关键词影响; 填入的是 rawMessage(git log %B) 原始完整信息, 不做拼接裁剪, 原样还原用户输入。
     */
    private async pickCommitHistoryMessage(repositoryPath: string): Promise<void> {
        // 同一条信息只保留首次出现(列表按时间倒序, 即最新一条)。
        const history = new Map<string, { shortHash: string; subject: string; message: string }>();
        for (const commit of this.commitController.totalCommitList) {
            if (commit.isStash || commit.gitBranchOption?.repoOption.path !== repositoryPath) { continue; }
            const message = (commit.rawMessage ?? commit.message).replace(/\s+$/, '');
            if (!message || history.has(message)) { continue; }
            history.set(message, { shortHash: commit.shortHash, subject: commit.message.trim(), message });
        }
        if (history.size === 0) {
            void vscode.window.showInformationMessage('当前项目没有已加载的历史提交信息。');
            return;
        }
        const items = [...history.values()].map(entry => ({
            label: entry.subject,
            description: entry.shortHash,
            // detail 只支持单行, 把正文中的换行折叠成可见分隔符, 便于挑出带多行正文的提交; 不影响实际填入的 message。
            detail: entry.message.split('\n').slice(1).filter(line => line.trim()).join(' ⏎ '),
            message: entry.message,
        }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择当前项目的历史提交信息填入' });
        if (picked) {
            this.updateWorkingTreeCommitMessage(repositoryPath, picked.message);
            this.view?.webview.postMessage({ type: 'repositoryCommitMessage', repositoryPath, message: picked.message });
        }
    }

    private async loadDefaultPushTarget(repositoryPath: string): Promise<void> {
        if (this.pushTargetByRepository.has(repositoryPath)) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const plan = await getPushPlan(rootUri);
        const target = plan ? defaultPushTarget(plan) : undefined;
        if (!target) { return; }
        this.pushTargetByRepository.set(repositoryPath, target);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    private async pickCommitPanelPushTarget(repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const plan = await getPushPlan(rootUri);
        if (!plan || plan.targets.length === 0) {
            void vscode.window.showInformationMessage('当前仓库没有可推送的远程分支。');
            return;
        }
        const defaultTarget = this.pushTargetByRepository.get(repositoryPath)
            ?? defaultPushTarget(plan);
        const picked = await pickPushTarget(plan, defaultTarget);
        if (!picked) { return; }
        this.pushTargetByRepository.set(repositoryPath, picked);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
    }

    /** 推送/拉取之后丢弃这些仓库缓存的 ahead/behind 与未推送提交状态, 下次发布时重新读取。 */
    private invalidateRepositorySyncState(repositoryPaths: Iterable<string>): void {
        for (const repositoryPath of repositoryPaths) {
            this.repositorySyncRevisionByRepository.set(repositoryPath, this.repositorySyncRevision(repositoryPath) + 1);
            this.unpushedCommitCountByRepository.delete(repositoryPath);
            this.behindCommitCountByRepository.delete(repositoryPath);
            this.cloudCommitsByRepository.delete(repositoryPath);
            this.repositorySyncKeyByRepository.delete(repositoryPath);
            for (const headKey of this.unpushedStateLoadedByHead) {
                if (headKey.startsWith(`${repositoryPath}\u0000`)) {
                    this.unpushedStateLoadedByHead.delete(headKey);
                    this.commitGitlinkPathsByHead.delete(headKey);
                }
            }
        }
        // 拉取可能只更新远程跟踪 ref, HEAD 不变, 因而不会触发 HEAD/分支事件。
        // 缓存失效后主动发布一次, 让 pushStateToWebview 重新读取 ahead/behind。
        this.schedulePushState();
    }

    /** 拉取改写 HEAD 但不会触发 HEAD 文件监听: 显式重读 HEAD 与工作区; 单个仓库失败不影响其余仓库。 */
    private async refreshRepositoryHeads(repositoryPaths: Iterable<string>): Promise<void> {
        const results = await Promise.allSettled([...repositoryPaths].map(async repositoryPath =>
            this.uncommittedFilesWatcher.refreshHeadBranch(repositoryPath)));
        for (const result of results) {
            if (result.status === 'rejected') { console.warn('无法刷新拉取后的仓库状态', result.reason); }
        }
    }
    private async runCommitPanelPush(
        repositoryPaths: readonly string[],
        pullBeforePush: boolean,
        focusCommitPanel = true,
        preferCurrentUpstream = false,
    ): Promise<void> {
        const rootRepositoryPath = repositoryPaths.at(-1);
        if (!rootRepositoryPath) { return; }
        const rootUri = this.getRepoRootUri(rootRepositoryPath);
        if (!rootUri) { return; }
        const rootPlan = await getPushPlan(rootUri);
        if (!rootPlan || rootPlan.targets.length === 0) {
            void vscode.window.showInformationMessage('当前仓库没有可推送的远程分支。');
            return;
        }
        const upstreamTarget = defaultPushTarget(rootPlan);
        // 卡片同步与 pull-before-push 始终回到当前分支绑定的 upstream; 普通 Push 沿用上次目标。
        const cachedTarget = this.lastPushedTargetByRepository.get(rootRepositoryPath)
            ?? this.pushTargetByRepository.get(rootRepositoryPath);
        const defaultTarget = preferCurrentUpstream || pullBeforePush
            ? upstreamTarget
            : cachedTarget ?? upstreamTarget;
        const selectedTargets = await pickPushTargets(rootPlan, defaultTarget ? [defaultTarget] : []);
        if (!selectedTargets || selectedTargets.length === 0) { return; }
        this.pushTargetByRepository.set(rootRepositoryPath, selectedTargets.at(-1) ?? selectedTargets[0]);
        if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
        const orderedRepositoryPaths = [...new Set(repositoryPaths)]
            .map((repositoryPath, index) => ({
                repositoryPath,
                index,
                depth: this.repoSubmoduleWatcher.getRepositoryAncestry(repositoryPath).length,
            }))
            .sort((left, right) => right.depth - left.depth || left.index - right.index)
            .map(item => item.repositoryPath);
        // 每个仓库各自的源(本地分支+HEAD)与目标远程分支; 子模块目标来自卡片上已选的分支。
        const plansByRepository = new Map<string, { readonly source: PushSourceBranch; readonly targets: readonly PushTargetOption[] }>([
            [rootRepositoryPath, { source: rootPlan.source, targets: selectedTargets }],
        ]);
        for (const repositoryPath of orderedRepositoryPaths) {
            if (repositoryPath === rootRepositoryPath) { continue; }
            const target = this.pushTargetByRepository.get(repositoryPath);
            const repositoryUri = this.getRepoRootUri(repositoryPath);
            const plan = repositoryUri ? await getPushPlan(repositoryUri) : undefined;
            if (!target || !plan) {
                void vscode.window.showWarningMessage(`仓库未选择可推送的远程分支：${repositoryPath}`);
                return;
            }
            plansByRepository.set(repositoryPath, { source: plan.source, targets: [target] });
        }
        const multiRepository = plansByRepository.size > 1;
        const repositoryLabelOf = (repositoryPath: string): string | undefined =>
            multiRepository ? path.basename(vscode.Uri.parse(repositoryPath).fsPath) : undefined;
        // 同步 = 先拉取、再推送。只拉取当前分支绑定的 upstream: 它必须被勾选, 且推送源是具名分支(游离 HEAD 没有 upstream)。
        const pullTargetByRepository = new Map<string, PushTargetOption>();
        if (pullBeforePush) {
            for (const [repositoryPath, plan] of plansByRepository) {
                const upstream = plan.source.branchName ? plan.targets.find(target => target.isUpstream) : undefined;
                if (upstream) { pullTargetByRepository.set(repositoryPath, upstream); }
            }
        }
        const confirmRows: PushConfirmRow[] = [...plansByRepository.entries()].flatMap(([repositoryPath, plan]) =>
            plan.targets.map(target => ({
                source: plan.source,
                target,
                repositoryLabel: repositoryLabelOf(repositoryPath),
            })));
        let syncing = false;
        if (pullBeforePush) {
            const choice = await confirmSync(confirmRows, [...pullTargetByRepository].map(([repositoryPath, target]) => {
                const label = repositoryLabelOf(repositoryPath);
                return `${label ? `${label}：` : ''}${target.remoteName}`;
            }));
            if (!choice) { return; }
            syncing = choice === 'sync';
            // 仅推送: 跳过拉取, 后面的进度、结果与重读都按普通推送执行。
            if (!syncing) { pullTargetByRepository.clear(); }
        } else if (!await confirmPush(confirmRows)) {
            return;
        }
        const operationName = syncing ? 'Git Sync' : 'Git Push';
        const pushResults: Array<{ repositoryPath: string; row: PushConfirmRow; result: NativePushResult }> = [];
        const pullNotes: string[] = [];
        let stashConflict = false;
        const pushedTargetByRepository = new Map<string, PushTargetOption>();
        // 拉取会改写 HEAD, 或在变基冲突时留下中间状态: 一旦开始拉取, 无论之后成败都要重读这些仓库。
        const pulledRepositoryPaths = new Set<string>();
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${syncing ? '同步' : '推送'} ${rootPlan.source.branchName ?? rootPlan.source.hash.slice(0, 8)}`,
                cancellable: false,
            }, async progress => {
                for (const repositoryPath of orderedRepositoryPaths) {
                    const repositoryUri = this.getRepoRootUri(repositoryPath);
                    if (!repositoryUri) { continue; }
                    const plan = plansByRepository.get(repositoryPath);
                    if (!plan || plan.targets.length === 0) {
                        throw new Error(`仓库未选择可推送的远程分支：${repositoryPath}`);
                    }
                    const repositoryLabel = repositoryLabelOf(repositoryPath);
                    let source = plan.source;
                    const pullTarget = pullTargetByRepository.get(repositoryPath);
                    if (pullTarget) {
                        progress.report({ message: `正在拉取：${repositoryLabel ? `${repositoryLabel}：` : ''}${pullTarget.remoteName}` });
                        pulledRepositoryPaths.add(repositoryPath);
                        // 本地未提交改动会让 pull.rebase 直接拒绝, 同步按钮在脏工作区上也必须可用。
                        await pull(repositoryUri, pullTarget.remote, pullTarget.branch, undefined, { autostash: true });
                        const pulledHash = await getCurrentGitHeadHash(repositoryUri);
                        // 变基/快进后 HEAD 已变: 推送与结果展示必须用拉取后的提交, 不能沿用确认前读到的 hash。
                        source = { branchName: plan.source.branchName, hash: pulledHash ?? plan.source.hash };
                        const change = !pulledHash
                            ? '已拉取'
                            : pulledHash === plan.source.hash
                                ? '已是最新'
                                : `本地提交 ${plan.source.hash.slice(0, 8)} → ${pulledHash.slice(0, 8)}`;
                        pullNotes.push(`${repositoryLabel ? `${repositoryLabel}：` : ''}拉取 ${pullTarget.remoteName}：${change}`);
                        // autostash 还原本地改动时若与拉取内容冲突, git 仍以 0 退出: 冲突留在工作区, 改动保留在 stash 里。
                        // 已提交的 HEAD 不受影响, 推送照常进行, 但必须明确告知用户去处理。
                        if (await hasConflicts(repositoryUri).catch(() => false)) {
                            stashConflict = true;
                            pullNotes.push(`⚠ ${repositoryLabel ? `${repositoryLabel}：` : ''}本地未提交改动与拉取内容冲突，已留在工作区，原改动保留在 stash 中`);
                        }
                    }
                    for (const target of plan.targets) {
                        const row: PushConfirmRow = { source, target, repositoryLabel };
                        progress.report({ message: `正在推送：${describePushRow(row)}` });
                        const pushResult = await push(repositoryUri, {
                            remote: target.remote,
                            remoteBranch: target.branch,
                            sourceBranchName: source.branchName,
                            sourceHash: source.hash,
                        });
                        pushResults.push({ repositoryPath, row, result: pushResult });
                        pushedTargetByRepository.set(repositoryPath, target);
                    }
                }
            });
            pushedTargetByRepository.forEach((target, repositoryPath) => {
                this.lastPushedTargetByRepository.set(repositoryPath, target);
            });
            await this.context.workspaceState.update('lastPushedTargets', Object.fromEntries(this.lastPushedTargetByRepository));
            if (this.commitPanel.isVisible()) { this.commitPanel.update(this.buildCommitSnapshot()); }
            this.invalidateRepositorySyncState(orderedRepositoryPaths);
            await this.refreshRepositoryHeads(pulledRepositoryPaths);
            await this.commitController.forceRefreshCurrentSelection();
            const detail = [
                ...pullNotes,
                ...pushResults.map(({ row, result }) => {
                    const commit = result.sourceHash ? `，提交 ${result.sourceHash.slice(0, 8)}` : '';
                    return `${describePushRow(row).replace(/（提交 [^)]+）$/u, '')}${commit}`;
                }),
            ].join('\n\n');
            await showPushResult(`${operationName} 已完成${stashConflict ? '，但本地改动有冲突' : ''}`, detail || '没有返回推送目标信息。');
        } catch (error) {
            if (pulledRepositoryPaths.size > 0) {
                // 拉取已经(或试图)改写这些仓库: 推送失败也要让界面反映真实状态, 刷新失败不覆盖原始错误。
                try {
                    this.invalidateRepositorySyncState(pulledRepositoryPaths);
                    await this.refreshRepositoryHeads(pulledRepositoryPaths);
                    await this.commitController.forceRefreshCurrentSelection();
                } catch (refreshError) {
                    console.warn('同步失败后刷新仓库状态失败', refreshError);
                }
            }
            const reason = error instanceof Error ? error.message : String(error);
            await showPushResult(`${operationName} 失败`, reason);
        }
        // 操作由 Commit 面板触发, 显示权归触发者: 结束后把面板带回编辑器区前台。
        if (focusCommitPanel) {
            this.commitPanel.focus(rootRepositoryPath);
        }
    }

    private async runCommit(
        repositoryPath: string,
        repositoryPaths: readonly string[],
        message: string,
        amend: boolean,
        focusCommitPanel = true,
        selectLatestCommit = false,
    ): Promise<boolean> {
        const rootAncestry = new Set([repositoryPath, ...this.repoSubmoduleWatcher.getRepositorySubtree(repositoryPath).map(repository => repository.path)]);
        const orderedRepositoryPaths = [...new Set(repositoryPaths)]
            .filter(path => rootAncestry.has(path))
            .map((path, index) => ({ path, index, depth: this.repoSubmoduleWatcher.getRepositoryAncestry(path).length }))
            .sort((left, right) => right.depth - left.depth || left.index - right.index)
            .map(item => item.path);
        if (!orderedRepositoryPaths.includes(repositoryPath)) { orderedRepositoryPaths.push(repositoryPath); }
        if (orderedRepositoryPaths.some(path => this.commitCommittingByRepo.has(path))) { return false; }
        let conflictedRepositories: string[];
        try {
            conflictedRepositories = (await Promise.all(orderedRepositoryPaths.map(async currentPath => {
                const rootUri = this.getRepoRootUri(currentPath);
                if (!rootUri) { return undefined; }
                return await hasConflicts(rootUri) ? currentPath : undefined;
            }))).filter((currentPath): currentPath is string => Boolean(currentPath));
        } catch (error) {
            void vscode.window.showErrorMessage(`检查合并冲突失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        if (conflictedRepositories.length > 0) {
            const labels = conflictedRepositories.map(currentPath =>
                this.repoController.totalRepoList.find(repository => repository.path === currentPath)?.label ?? vscode.Uri.parse(currentPath).fsPath,
            );
            void vscode.window.showWarningMessage(`请先解决所有合并冲突：${labels.join('、')}`);
            return false;
        }
        orderedRepositoryPaths.forEach(path => this.commitCommittingByRepo.add(path));
        this.schedulePushState();
        await this.refreshCommitPanel();
        const committedRepositoryPaths: string[] = [];
        let committed = false;
        try {
            for (const currentPath of orderedRepositoryPaths) {
                const currentBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                    .find(branch => branch.repoOption.path === currentPath);
                const changes = currentBranch
                    ? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(currentBranch)
                    : undefined;
                if (!changes || changes.staged.length === 0) { continue; }
                const rootUri = this.getRepoRootUri(currentPath);
                if (!rootUri) { continue; }
                await commitWithMessage(rootUri, message, currentPath === repositoryPath ? amend : false);
                committed = true;
                committedRepositoryPaths.push(currentPath);
                if (currentPath !== repositoryPath) {
                    const ancestry = this.repoSubmoduleWatcher.getRepositoryAncestry(currentPath);
                    const parent = ancestry.at(-1);
                    if (parent && orderedRepositoryPaths.includes(parent.path)) {
                        const childUri = vscode.Uri.parse(currentPath);
                        const parentUri = vscode.Uri.parse(parent.path);
                        const gitlinkPath = path.relative(parentUri.fsPath, childUri.fsPath).split(path.sep).join('/');
                        await this.gitBackend.stage(parentUri, [gitlinkPath]);
                    }
                }
            }
            if (!committed) { void vscode.window.showInformationMessage('没有已暂存的变更，无需提交'); }
            this.commitAmendByRepo.delete(repositoryPath);
            // commit 不改写 .git/HEAD, HEAD 文件监听器不会触发; 必须显式重读并等待新 HEAD 的
            // 工作区状态就绪, 再刷新提交列表, 保证遮罩结束时 staged/unstaged 与新 commit 同步。
            await Promise.all(committedRepositoryPaths
                .map(committedPath => this.uncommittedFilesWatcher.refreshHeadBranch(committedPath)));
            await this.commitController.forceRefreshCurrentSelection();
            if (committed && selectLatestCommit) {
                this.selectLatestCommitForRepository(repositoryPath);
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`Git Commit 失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            orderedRepositoryPaths.forEach(path => this.commitCommittingByRepo.delete(path));
            this.schedulePushState();
            await this.refreshCommitPanel();
            // 操作由 Commit 面板触发, 显示权归触发者: 结束后把面板带回编辑器区前台。
            if (focusCommitPanel) {
                this.commitPanel.focus(repositoryPath);
            }
        }
        return committed;
    }

    private async runWorkingTreeCommit(
        action: string,
        repositoryPath: string,
        message: string,
    ): Promise<void> {
        if (!message.trim()) {
            void vscode.window.showWarningMessage('提交信息不能为空');
            return;
        }
        const normalizedAction = action === 'amend' || action === 'push' || action === 'sync'
            ? action
            : 'commit';
        const committed = await this.runCommit(
            repositoryPath,
            [repositoryPath],
            message,
            normalizedAction === 'amend',
            false,
            true,
        );
        if (!committed) {
            return;
        }
        if (normalizedAction === 'push' || normalizedAction === 'sync') {
            await this.runCommitPanelPush(
                [repositoryPath],
                normalizedAction === 'sync',
                false,
            );
        }
    }

    private selectLatestCommitForRepository(repositoryPath: string): void {
        const latest = this.commitController.latestCommitOf(repositoryPath);
        if (latest) {
            this.commitController.selectCommit(latest);
        }
    }

    private updateWorkingTreeCommitMessage(repositoryPath: string, message: string): void {
        this.commitMessageByRepo.set(repositoryPath, message);
        if (this.commitPanel.isVisible()) {
            this.commitPanel.update(this.buildCommitSnapshot());
        }
        this.schedulePushState();
    }

    private async runCommitPanelWorkingTreeAction(
        repositoryPath: string,
        action: 'stage' | 'unstage' | 'discard' | 'stash',
        section: 'conflict' | 'staged' | 'unstaged',
        paths: readonly string[],
        untrackedPaths: readonly string[],
    ): Promise<void> {
        if (action === 'stash') {
            // stash 范围由分组决定，不使用界面上传来的路径；以最新快照为准。
            if (section !== 'conflict') { await this.runStashAction(repositoryPath, section); }
            return;
        }
        if (paths.length === 0 || (section === 'conflict' && action !== 'stage')) { return; }
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const untrackedPathSet = new Set(untrackedPaths);
        const discardSelection = action === 'discard'
            ? await this.confirmDiscardWorkingTreeChanges(paths, untrackedPathSet)
            : { paths: [...paths], discardUntrackedToTrash: false };
        if (!discardSelection) { return; }
        const gitlinkPaths = new Set<string>();
        const affectedSubmoduleRepositoryPaths = new Set<string>();
        if (action === 'discard') {
            const gitlinkSubmodules = discardSelection.paths.flatMap(filePath => {
                const submodule = this.repoSubmoduleWatcher.findSubmoduleRepository(repositoryPath, filePath);
                return submodule ? [{ filePath, submodule }] : [];
            });
            let recurseNestedSubmodules = false;
            if (gitlinkSubmodules.some(({ submodule }) => this.repoSubmoduleWatcher.getRepositorySubtree(submodule.path).length > 1)) {
                const choice = await vscode.window.showWarningMessage(
                    '检测到子模块包含嵌套子模块。是否同时递归撤销子模块的子模块修改？',
                    { modal: true },
                    '递归撤销',
                    '仅撤销直接子模块',
                );
                if (!choice) { return; }
                recurseNestedSubmodules = choice === '递归撤销';
            }
            for (const { filePath, submodule } of gitlinkSubmodules) {
                gitlinkPaths.add(filePath);
                const affectedRepositories = recurseNestedSubmodules
                    ? this.repoSubmoduleWatcher.getRepositorySubtree(submodule.path)
                    : [submodule];
                affectedRepositories.forEach(repository => affectedSubmoduleRepositoryPaths.add(repository.path));
            }
        }
        this.workingTreeActionQueue.push({
            action,
            section,
            paths: discardSelection.paths,
            untrackedPaths: untrackedPathSet,
            discardUntrackedToTrash: discardSelection.discardUntrackedToTrash,
            rootUri,
            gitlinkPaths,
            affectedSubmoduleRepositoryPaths: [...affectedSubmoduleRepositoryPaths],
        });
        void this.processWorkingTreeActionQueue();
    }

    private async runWorkingTreeAction(
        action: unknown,
        section: unknown,
        filePath?: unknown,
        repositoryPath?: string,
        selectedPaths?: unknown,
    ): Promise<void> {
        if ((action !== 'stage' && action !== 'unstage' && action !== 'discard' && action !== 'stash')
            || (section !== 'conflict' && section !== 'staged' && section !== 'unstaged')
            || (section === 'conflict' && action !== 'stage')
            || (filePath !== undefined && typeof filePath !== 'string')
            || (selectedPaths !== undefined
                && (!Array.isArray(selectedPaths) || selectedPaths.some(path => typeof path !== 'string')))) { return; }
        // Changed Files 区不带 repositoryPath, 用虚拟提交仓库; Commit 卡片显式指定其仓库。
        const targetRepositoryPath = repositoryPath ?? this.commitController.uncommittedRepositoryPath;
        if (!targetRepositoryPath) { return; }
        const rootUri = this.getRepoRootUri(targetRepositoryPath);
        if (!rootUri) { return; }
        if (action === 'stash') {
            if (section === 'conflict') { return; }
            await this.runStashAction(targetRepositoryPath, section);
            return;
        }
        // 当前选中仓库用共用的 Store 清单; 其余 Commit 卡片仓库向 watcher 取各自清单。
        const useStore = targetRepositoryPath === this.commitController.uncommittedRepositoryPath;
        const branch = this.branches.find(b => b.kind === 'current' && b.repoOption.path === targetRepositoryPath);
        const changes = useStore
            ? { staged: store.getState().stagedFiles, changes: store.getState().unstagedFiles }
            : branch?.kind === 'current'
                ? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch).catch(() => ({ staged: [], changes: [] }))
                : { staged: [], changes: [] };
        const unstagedFiles = changes.changes;
        const sectionFiles = section === 'staged'
            ? changes.staged.filter(file => !file.isConflict)
            : section === 'conflict'
                ? unstagedFiles.filter(file => file.isConflict)
                : unstagedFiles.filter(file => !file.isConflict);
        const availablePaths = new Set(sectionFiles.map(file => file.path));
        const paths = Array.isArray(selectedPaths)
            ? [...new Set(selectedPaths.filter((path): path is string => availablePaths.has(path)))]
            : typeof filePath === 'string'
                ? [filePath]
                : sectionFiles.map(file => file.path);
        if (paths.length === 0) { return; }
        const untrackedPaths = new Set(unstagedFiles.filter(file => file.isUntracked).map(file => file.path));
        const gitlinkPaths = new Set<string>();
        const affectedSubmoduleRepositoryPaths = new Set<string>();
        if (action === 'discard') {
            for (const filePath of paths) {
                const submodule = this.repoSubmoduleWatcher.findSubmoduleRepository(targetRepositoryPath, filePath);
                if (submodule) {
                    gitlinkPaths.add(filePath);
                    this.repoSubmoduleWatcher.getRepositorySubtree(submodule.path)
                        .forEach(repository => affectedSubmoduleRepositoryPaths.add(repository.path));
                }
            }
        }
        const discardSelection = action === 'discard'
            ? await this.confirmDiscardWorkingTreeChanges(paths, untrackedPaths)
            : { paths: [...paths], discardUntrackedToTrash: false };
        if (!discardSelection) { return; }
        this.workingTreeActionQueue.push({
            action,
            section,
            paths: discardSelection.paths,
            untrackedPaths,
            discardUntrackedToTrash: discardSelection.discardUntrackedToTrash,
            rootUri,
            gitlinkPaths,
            affectedSubmoduleRepositoryPaths: [...affectedSubmoduleRepositoryPaths],
        });
        void this.processWorkingTreeActionQueue();
    }

    /**
     * stash 行右键菜单: apply / pop / drop。
     * - apply、pop 会改写工作区和索引，进入工作区操作队列(与暂存、还原串行，并复用变更监听的刷新协调)；
     * - drop 只删除条目、不碰工作区，确认后直接执行。
     * stash 用提交 hash 定位: 弹窗期间别处可能已增删 stash，序号不可靠。
     */
    private async runStashCommitAction(action: 'stashApply' | 'stashPop' | 'stashDrop', hash: string, repositoryPath: string): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const stash = this.stashesByRepository.get(repositoryPath)?.find(entry => entry.hash === hash);
        if (!stash) {
            void vscode.window.showWarningMessage('该 Stash 已不存在，列表已刷新。');
            await this.loadRepositoryStashes(repositoryPath, true);
            return;
        }
        if (action === 'stashDrop') {
            const confirmLabel = '删除';
            const choice = await vscode.window.showWarningMessage(
                `删除 ${stash.stashRef}「${stash.message}」？`,
                { modal: true, detail: `条目删除后，其提交对象在 Git 垃圾回收前仍可凭 hash 找回：${hash}` },
                confirmLabel,
            );
            if (choice !== confirmLabel) { return; }
            try {
                await this.gitBackend.stashDrop(rootUri, hash);
            } catch (error) {
                void vscode.window.showErrorMessage(`Git 操作失败: ${error instanceof Error ? error.message : String(error)}`);
            }
            // 失败也重读: 常见原因是条目已被别处删除，缓存需要对齐。
            await this.loadRepositoryStashes(repositoryPath, true);
            if (!this.isStashHash(hash, repositoryPath)) { this.leaveRemovedStash(repositoryPath, stash); }
            return;
        }
        let paths: string[];
        try {
            const files = await getStashFiles(rootUri, hash);
            // 重命名要同时刷新旧路径，否则旧路径的状态会停留在界面上。
            paths = [...new Set(files.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))];
        } catch (error) {
            void vscode.window.showErrorMessage(`Git 操作失败: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        this.workingTreeActionQueue.push({
            action,
            stashHash: hash,
            section: 'unstaged',
            paths,
            untrackedPaths: new Set<string>(),
            discardUntrackedToTrash: false,
            rootUri,
            gitlinkPaths: new Set<string>(),
            affectedSubmoduleRepositoryPaths: [],
        });
        void this.processWorkingTreeActionQueue();
    }

    /**
     * 当前选中的 stash 被删除(pop / drop)后，选中项要离开它：
     * 控制器会保留列表之外的已选项，不处理的话变更文件区会一直显示一个已不存在的 stash。
     * 优先回到它的基线提交，其次是仓库最新提交。
     */
    private leaveRemovedStash(repositoryPath: string, stash: StashEntry): void {
        if (this.currentHash !== stash.hash || this.currentRepositoryPath !== repositoryPath) { return; }
        const base = stash.parents[0];
        const fallback = (base ? this.commitController.findCommit(base, repositoryPath) : undefined)
            ?? this.commitController.latestCommitOf(repositoryPath);
        if (fallback) { this.commitController.selectCommit(fallback); }
    }

    /**
     * 分组头的 stash 按钮直接映射到原生 libgit2 语义，不做跨分组确认：
     * - Unstaged: KEEP_INDEX | INCLUDE_UNTRACKED（等价于 stash -k -u）。
     * - Staged: 仅保存 index（等价于 stash -S）。
     */
    private async runStashAction(repositoryPath: string, section: 'staged' | 'unstaged'): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) { return; }
        const read = async (): Promise<{ staged: string[]; unstaged: string[]; hasConflict: boolean } | undefined> => {
            const useStore = repositoryPath === this.commitController.uncommittedRepositoryPath;
            const branch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                .find(candidate => candidate.repoOption.path === repositoryPath);
            const changes = useStore
                ? { staged: store.getState().stagedFiles, changes: store.getState().unstagedFiles }
                : branch ? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch).catch(() => undefined) : undefined;
            if (!changes) { return undefined; }
            const staged = changes.staged.filter(file => !file.isConflict).map(file => file.path);
            const unstaged = changes.changes.filter(file => !file.isConflict).map(file => file.path);
            const hasConflict = changes.staged.concat(changes.changes).some(file => file.isConflict);
            return { staged, unstaged, hasConflict };
        };
        const current = await read();
        if (!current) { void vscode.window.showWarningMessage('仓库状态尚未就绪，请稍后再试。'); return; }
        if (current.hasConflict) {
            void vscode.window.showWarningMessage('存在未解决的合并冲突，请先解决冲突后再 stash。');
            return;
        }
        const paths = section === 'staged' ? current.staged : current.unstaged;
        if (paths.length === 0) { return; }
        this.workingTreeActionQueue.push({
            action: 'stash',
            stashScope: section,
            section,
            paths: [...new Set(paths)],
            untrackedPaths: new Set<string>(),
            discardUntrackedToTrash: false,
            rootUri,
            gitlinkPaths: new Set<string>(),
            affectedSubmoduleRepositoryPaths: [],
        });
        void this.processWorkingTreeActionQueue();
    }

    private async confirmDiscardWorkingTreeChanges(
        paths: readonly string[],
        untrackedPaths: ReadonlySet<string>,
    ): Promise<{ paths: string[]; discardUntrackedToTrash: boolean } | undefined> {
        const tracked = paths.filter(filePath => !untrackedPaths.has(filePath));
        const untracked = paths.filter(filePath => untrackedPaths.has(filePath));
        if (untracked.length === 0) {
            const files = store.getState().unstagedFiles.filter(file => tracked.includes(file.path));
            const allDeleted = files.every(file => file.status === 'D');
            const message = allDeleted
                ? tracked.length === 1
                    ? `是否确实要还原“${path.basename(tracked[0])}”?`
                    : `是否确定要还原全部 ${tracked.length} 个文件?`
                : tracked.length === 1
                    ? `是否确实要放弃“${path.basename(tracked[0])}”中的更改?`
                    : `是否确实要放弃 ${tracked.length} 个文件中的全部更改?\n\n此操作不可撤消!\n如果继续操作，你当前的工作集将永久丢失。`;
            const primaryAction = allDeleted
                ? tracked.length === 1 ? '还原文件' : `还原所有 ${tracked.length} 文件`
                : tracked.length === 1 ? '放弃文件' : `放弃所有 ${tracked.length} 个文件`;
            const choice = await vscode.window.showWarningMessage(message, { modal: true }, primaryAction);
            return choice === primaryAction
                ? { paths: [...tracked], discardUntrackedToTrash: false }
                : undefined;
        }

        const discardToTrash = vscode.workspace.getConfiguration('fastergit').get<boolean>('discardUntrackedChangesToTrash', true)
            && !vscode.env.remoteName
            && !(process.platform === 'linux' && !!process.env.SNAP);
        const warning = discardToTrash
            ? ''
            : untracked.length === 1
                ? '\n\n此操作不可撤消!\n如果继续操作，此文件将永久丢失。'
                : '\n\n此操作不可撤消!\n如果继续操作，这些文件将永久丢失。';
        const untrackedMessage = untracked.length === 1
            ? `是否确实要删除以下未跟踪的文件： '${path.basename(untracked[0])}'？${warning}`
            : `是否确实要删除 ${untracked.length} 个未跟踪的文件? ${warning}`;
        const detail = discardToTrash
            ? untracked.length === 1 ? '您可以从回收站还原此文件。' : '您可以从回收站还原这些文件。'
            : '';
        if (tracked.length === 0) {
            const primaryAction = discardToTrash
                ? '移动到回收站'
                : untracked.length === 1 ? '删除文件' : `删除所有 ${untracked.length} 个文件`;
            const choice = await vscode.window.showWarningMessage(
                untrackedMessage,
                { detail, modal: true },
                primaryAction,
            );
            return choice === primaryAction
                ? { paths: [...untracked], discardUntrackedToTrash: discardToTrash }
                : undefined;
        }

        const trackedMessage = tracked.length === 1
            ? `\n\n是否确实要放弃“${path.basename(tracked[0])}”中的更改?`
            : `\n\n是否确实要放弃 ${tracked.length} 文件中的所有更改？`;
        const trackedAction = tracked.length === 1
            ? '放弃 1 个已跟踪的文件'
            : `放弃所有 ${tracked.length} 个跟踪的文件`;
        const allAction = `放弃所有 ${paths.length} 个文件`;
        const choice = await vscode.window.showWarningMessage(
            `${untrackedMessage} ${detail}${trackedMessage}\n\n此操作不可撤消!\n如果继续操作，你当前的工作集将永久丢失。`,
            { modal: true },
            trackedAction,
            allAction,
        );
        if (choice === trackedAction) {
            return { paths: tracked, discardUntrackedToTrash: false };
        }
        return choice === allAction
            ? { paths: [...paths], discardUntrackedToTrash: discardToTrash }
            : undefined;
    }

    private async getCurrentlyTrackedPaths(rootUri: vscode.Uri, paths: readonly string[]): Promise<string[]> {
        if (paths.length === 0) { return []; }
        return trackedPaths(rootUri, paths);
    }

    private async processWorkingTreeActionQueue(): Promise<void> {
        if (this.processingWorkingTreeActions) { return; }
        this.processingWorkingTreeActions = true;
        let failed = false;
        try {
            do {
                while (this.workingTreeActionQueue.length > 0) {
                    const operation = this.workingTreeActionQueue.shift()!;
                    const currentBranches = this.uncommittedFilesWatcher.listCurrentHeadBranches();
                    const rootRepositoryPath = operation.rootUri.toString();
                    const mutationBranches = [rootRepositoryPath, ...operation.affectedSubmoduleRepositoryPaths]
                        .flatMap(repositoryPath => currentBranches.filter(branch => branch.repoOption.path === repositoryPath));
                    const rootBranch = mutationBranches.find(branch => branch.repoOption.path === rootRepositoryPath);
                    const beforeChanges = rootBranch
                        ? this.uncommittedFilesWatcher.getCachedUncommittedFilesByHeadBranch(rootBranch)
                        : undefined;
                    mutationBranches.forEach(branch => this.uncommittedFilesWatcher.beginWorkingTreeMutation(branch));
                    this.workingTreeUiMutations.add(rootRepositoryPath);
                    this.deferredWorkingTreeChanges.delete(rootRepositoryPath);
                    let mutationEnded = false;
                    let projectedChanges: WorkingTreeChanges | undefined;
                    let verificationPaths: readonly string[] = [];
                    const endMutation = async (progress?: vscode.Progress<{ message?: string }>): Promise<void> => {
                        await Promise.all(mutationBranches.map(branch => {
                            const isRootRepository = branch.repoOption.path === rootRepositoryPath;
                            if (isRootRepository && projectedChanges) {
                                return this.uncommittedFilesWatcher.completeWorkingTreeMutation(
                                    branch,
                                    projectedChanges,
                                    operation.paths,
                                    verificationPaths,
                                );
                            }
                            return this.uncommittedFilesWatcher.endWorkingTreeMutation(
                                branch,
                                isRootRepository ? operation.paths : [],
                                !isRootRepository,
                            );
                        }));
                        mutationEnded = true;
                        const deferred = this.deferredWorkingTreeChanges.get(rootRepositoryPath);
                        this.deferredWorkingTreeChanges.delete(rootRepositoryPath);
                        // A subsequent watcher event must be free to supersede this read.
                        this.workingTreeUiMutations.delete(rootRepositoryPath);
                        // Status may be structurally equal (same paths in both sections) even
                        // though stage/discard changed their contents. In that case the watcher
                        // emits no list event; always reconcile the selected view from its
                        // post-mutation snapshot instead of leaving the old file cards onscreen.
                        const currentChanges = rootBranch
                            ? this.uncommittedFilesWatcher.getCachedUncommittedFilesByHeadBranch(rootBranch)
                            : undefined;
                        const changes = currentChanges ?? deferred?.changes;
                        if (changes) {
                            progress?.report({ message: '正在刷新变更文件和差异视图...' });
                            await this.applyWorkingTreeChanges(changes, [
                                ...new Set([...operation.paths, ...(deferred?.affectedPaths ?? [])]),
                            ]);
                        }
                    };
                    try {
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: operation.action === 'stage'
                                ? '添加文件'
                                : operation.action === 'unstage' ? '取消暂存'
                                    : operation.action === 'stash' ? '暂存到 Stash'
                                        : operation.action === 'stashApply' ? '应用 Stash'
                                            : operation.action === 'stashPop' ? '弹出 Stash' : '还原更改',
                            cancellable: false,
                        }, async progress => {
                            const total = operation.paths.length;
                            const actionMessage = operation.action === 'discard'
                                ? '正在还原文件'
                                : operation.action === 'stage'
                                    ? '正在添加或更新文件'
                                    : operation.action === 'stash' ? '正在创建 Stash'
                                        : operation.action === 'stashApply' ? '正在应用 Stash'
                                            : operation.action === 'stashPop' ? '正在弹出 Stash' : '正在取消暂存';
                            progress.report({ message: `${actionMessage}（${total} 个文件）...` });
                            if (operation.action === 'discard') {
                                const targetCommitByRepository = new Map<string, string>();
                                const affectedRepositories = operation.affectedSubmoduleRepositoryPaths
                                    .map(repositoryPath => ({
                                        repositoryPath,
                                        ancestry: this.repoSubmoduleWatcher.getRepositoryAncestry(repositoryPath),
                                    }))
                                    .sort((left, right) => left.ancestry.length - right.ancestry.length);
                                for (const { repositoryPath, ancestry } of affectedRepositories) {
                                    const parent = ancestry.at(-2);
                                    if (!parent) { continue; }
                                    const childUri = vscode.Uri.parse(repositoryPath);
                                    const parentUri = vscode.Uri.parse(parent.path);
                                    const gitlinkPath = path.relative(parentUri.fsPath, childUri.fsPath).split(path.sep).join('/');
                                    const targetCommit = await indexGitlink(parentUri, gitlinkPath);
                                    if (targetCommit) { targetCommitByRepository.set(repositoryPath, targetCommit); }
                                }
                                // 状态快照可能在确认弹窗期间过期; 以当前 index 的实际跟踪状态为准,
                                // 避免把后来变成未跟踪的文件传给 `git restore`。
                                const currentlyTrackedPaths = new Set(await this.getCurrentlyTrackedPaths(operation.rootUri, operation.paths));
                                const trackedPaths = operation.paths.filter(filePath =>
                                    currentlyTrackedPaths.has(filePath) && !operation.untrackedPaths.has(filePath));
                                for (const filePath of operation.paths) {
                                    if (operation.untrackedPaths.has(filePath)) {
                                        await vscode.workspace.fs.delete(
                                            vscode.Uri.joinPath(operation.rootUri, filePath),
                                            { recursive: true, useTrash: operation.discardUntrackedToTrash },
                                        );
                                    }
                                }
                                if (trackedPaths.length > 0) {
                                    await this.gitBackend.discardWorktree(operation.rootUri, trackedPaths);
                                }
                                // 子模块撤销范围已由弹窗确定；逐仓库恢复并回到父仓库 gitlink 指定的提交。
                                for (const repositoryPath of operation.affectedSubmoduleRepositoryPaths) {
                                    const repositoryUri = vscode.Uri.parse(repositoryPath);
                                    await restoreAll(repositoryUri);
                                    const targetCommit = targetCommitByRepository.get(repositoryPath);
                                    if (targetCommit) { await restoreSubmodule(repositoryUri, targetCommit); }
                                }
                            } else if (operation.action === 'stash') {
                                const scope = operation.stashScope;
                                if (!scope) { throw new Error('缺少 stash 范围'); }
                                let result;
                                try {
                                    result = await this.gitBackend.stash(operation.rootUri, scope);
                                } catch (error) {
                                    // staged stash can create refs/stash and then fail while
                                    // applying the staged patch in reverse. Reload before surfacing
                                    // the libgit2 error so the visible list matches repository state.
                                    await this.loadRepositoryStashes(operation.rootUri.toString(), true);
                                    throw error;
                                }
                                if (beforeChanges) {
                                    projectedChanges = projectStashChanges(
                                        beforeChanges,
                                        operation.paths,
                                        scope,
                                        result.skippedGitlinks,
                                    );
                                }
                                if (result.skippedGitlinks.length > 0) {
                                    void vscode.window.showWarningMessage(
                                        `子模块变更不会被 stash，已保留在工作区：${result.skippedGitlinks.join('、')}`);
                                }
                                // refs/stash 监听通常会触发刷新; 这里主动读一次, 避免依赖文件系统事件的延迟。
                                await this.loadRepositoryStashes(operation.rootUri.toString(), true);
                            } else if (operation.action === 'stashApply' || operation.action === 'stashPop') {
                                if (!operation.stashHash) { throw new Error('缺少 stash 标识'); }
                                const repositoryPath = operation.rootUri.toString();
                                const target = this.stashesByRepository.get(repositoryPath)?.find(entry => entry.hash === operation.stashHash);
                                const result = operation.action === 'stashPop'
                                    ? await this.gitBackend.stashPop(operation.rootUri, operation.stashHash)
                                    : await this.gitBackend.stashApply(operation.rootUri, operation.stashHash);
                                if (result.conflicts) {
                                    void vscode.window.showWarningMessage(
                                        '应用 Stash 后存在冲突，冲突文件已留在工作区。'
                                        + (operation.action === 'stashPop' ? 'Stash 条目已保留，解决冲突后可手动删除。' : ''));
                                }
                                await this.loadRepositoryStashes(repositoryPath, true);
                                if (result.dropped && target) { this.leaveRemovedStash(repositoryPath, target); }
                            } else if (operation.action === 'stage') {
                                await this.gitBackend.stage(operation.rootUri, operation.paths);
                            } else {
                                await this.gitBackend.unstage(operation.rootUri, operation.paths);
                                if (beforeChanges) {
                                    const projection = projectUnstageChanges(beforeChanges, operation.paths);
                                    projectedChanges = projection.changes;
                                    verificationPaths = projection.verificationPaths;
                                }
                            }
                            progress.report({ message: '正在同步 Git 工作区状态...' });
                            await endMutation(progress);
                        });
                    } finally {
                        this.workingTreeUiMutations.delete(rootRepositoryPath);
                        this.deferredWorkingTreeChanges.delete(rootRepositoryPath);
                        if (!mutationEnded) {
                            await Promise.all(mutationBranches.map(branch => {
                                const isRootRepository = branch.repoOption.path === operation.rootUri.toString();
                                return this.uncommittedFilesWatcher.endWorkingTreeMutation(
                                    branch,
                                    isRootRepository ? operation.paths : [],
                                    !isRootRepository,
                                );
                            }));
                        }
                    }
                }
            } while (this.workingTreeActionQueue.length > 0);
        } catch (error) {
            failed = true;
            void vscode.window.showErrorMessage(`Git 操作失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.processingWorkingTreeActions = false;
            if (failed) { this.commitController.requestUncommittedPresenceCheck(); }
        }
    }

    private async readGitlinkCommitSubjects(rootUri: vscode.Uri, files: CommitFile[]): Promise<void> {
        const gitlinkFiles = files.filter(file => file.isGitlink);
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
            while (true) {
                const index = nextIndex++;
                if (index >= gitlinkFiles.length) { return; }
                const file = gitlinkFiles[index];
                const submodulePath = path.resolve(rootUri.fsPath, file.path);
                const submoduleUri = vscode.Uri.file(submodulePath);
                file.gitlinkScanPending = false;
                const isRealObjectId = (hash: string | undefined): hash is string => Boolean(hash) && !/^0+$/.test(hash);
                const childBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                    .find(branch => branch.repoOption.path === submoduleUri.toString());
                // A parent unstaged Gitlink does not by itself mean the child
                // worktree is dirty: the child HEAD may simply have moved.
                // A watcher can briefly hold an empty bootstrap snapshot, so
                // never let that snapshot erase the parent Gitlink dirty hint.
                if (file.workingTreeKind) {
                    try {
                        const watcherChanges = childBranch
                            ? await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(childBranch)
                            : undefined;
                        const watcherCount = watcherChanges ? workingTreeChangeCount(watcherChanges) : 0;
                        if (watcherCount > 0) {
                            file.gitlinkWorktreeChangeCount = watcherCount;
                            file.gitlinkWorktreeDirty = true;
                        } else if (file.gitlinkWorktreeDirty) {
                            const directChanges = await this.gitBackend.getWorkingTreeStatus(submoduleUri);
                            file.gitlinkWorktreeChangeCount = workingTreeChangeCount(directChanges);
                            file.gitlinkWorktreeDirty = file.gitlinkWorktreeChangeCount > 0;
                        }
                    } catch {
                        // The navigation card stays usable if the child status
                        // refresh races a HEAD change; retain the backend hint.
                    }
                }
                // `git diff` 的工作区端 gitlink OID 是零占位；真实新端只能由子模块工作区 HEAD 提供。
                if (file.workingTreeKind === 'unstaged' && !isRealObjectId(file.newObjectId)) {
                    file.newObjectId = await resolveRevision(submoduleUri, 'HEAD');
                }
                const hashes = [file.oldObjectId, file.newObjectId, file.gitlinkConflictBaseObjectId, file.gitlinkConflictCurrentObjectId, file.gitlinkConflictIncomingObjectId].filter(isRealObjectId);
                if (hashes.length === 0) { continue; }
                try {
                    const details = await commitDetails(submoduleUri, hashes);
                    const commits = new Map(details.map(detail => [detail.hash, toGitlinkCommit(detail)]));
                    file.oldGitlinkCommit = file.oldObjectId ? commits.get(file.oldObjectId) : undefined;
                    file.newGitlinkCommit = file.newObjectId ? commits.get(file.newObjectId) : undefined;
                    file.gitlinkConflictBaseCommit = file.gitlinkConflictBaseObjectId ? commits.get(file.gitlinkConflictBaseObjectId) : undefined;
                    file.gitlinkConflictCurrentCommit = file.gitlinkConflictCurrentObjectId ? commits.get(file.gitlinkConflictCurrentObjectId) : undefined;
                    file.gitlinkConflictIncomingCommit = file.gitlinkConflictIncomingObjectId ? commits.get(file.gitlinkConflictIncomingObjectId) : undefined;
                    if (file.status !== 'A' && file.status !== 'D'
                        && isRealObjectId(file.oldObjectId) && isRealObjectId(file.newObjectId)) {
                        const detailsInRange = await rangeCommits(submoduleUri, file.oldObjectId, file.newObjectId);
                        // `old..new` contains only commits introduced after the old gitlink OID.
                        file.gitlinkRangeCommits = detailsInRange.map(toGitlinkCommit);
                    }
                } catch {
                    // SHA 仍由父仓库 gitlink 保存；子模块本地缺少对象或两端非线性时仅不显示范围消息。
                }
            }
        };
        const workerCount = Math.min(GITLINK_METADATA_READ_CONCURRENCY, gitlinkFiles.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    private async refreshGitlinkDiffs(
        rootUri: vscode.Uri,
        files: readonly CommitFile[],
        generation: number,
        workingTreeDiffCacheKey?: string,
    ): Promise<void> {
        const gitlinkFiles = files.filter(file => file.isGitlink);
        if (gitlinkFiles.length === 0) { return; }
        await this.readGitlinkCommitSubjects(rootUri, gitlinkFiles as CommitFile[]);
        if (generation !== this.commitFilesGeneration
            || this.currentRepositoryPath !== rootUri.toString()
            || !this.files.some(file => file.isGitlink)) { return; }
        const currentFiles = store.getState().files;
        const currentDiffs = currentFiles.filter((file): file is DiffPayload => 'original' in file && 'modified' in file);
        const updatedDiffs = this.diffReader.updateGitlinkPayloads(currentDiffs, gitlinkFiles);
        const updatedByKey = new Map(updatedDiffs.map(file => [file.diffKey || file.path, file]));
        const updated = currentFiles.map(file => updatedByKey.get(file.diffKey || file.path) ?? file);
        if (workingTreeDiffCacheKey) {
            this.workingTreeDiffCache.set(workingTreeDiffCacheKey, updated.filter((file): file is DiffPayload => 'original' in file && 'modified' in file));
        }
        const loadedCount = updated.filter(file => 'original' in file && 'modified' in file).length;
        store.setState({
            files: updated,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: loadedCount, total: updated.length },
        });
    }

    private async refreshPendingGitlinkDiff(): Promise<void> {
        if (!this.currentHash || !this.selectedRepositoryPath) { return; }
        const hasPending = store.getState().files.some(file => file.isGitlink && file.gitlinkScanPending);
        if (!hasPending) { return; }
        if (isWorkingTreeHash(this.currentHash)) {
            await this.selectWorkingTreeChanges(undefined, false);
            return;
        }
        await this.selectCommit(this.currentHash, this.selectedRepositoryPath);
    }

    private async setCommitFiles(
        hash: string,
        repositoryPath: string | undefined,
        generation: number,
        signal?: AbortSignal,
        revealDiff = false,
        revealPath?: string,
    ): Promise<void> {
        const rootUri = this.getRepoRootUri(repositoryPath);
        if (!rootUri) {
            if (generation === this.commitFilesGeneration) {
                store.setState({
                    filesLoading: false,
                    diffLoading: false,
                    diffError: '无法确定当前提交所属的 Git 仓库。',
                });
            }
            return;
        }
        const publishDiffProgress = (current: number, total: number): void => {
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            store.setState({ diffProgress: { completed: current, total } });
            this.view?.webview.postMessage({
                type: 'filesLoadingProgress',
                hash, repositoryPath, current, total,
                message: '正在加载变更文件...',
            });
        };
        const reportProgress = (current: number, total: number): void => {
            publishDiffProgress(current, total);
        };
        try {
            // 提交文件元数据先到达；Diff 正文由 MultiDiff 按可视范围按需请求。
            const files = repositoryPath && this.isStashHash(hash, repositoryPath)
                ? await getStashFiles(rootUri, hash, signal)
                : await getCommitFiles(rootUri, hash, signal, reportProgress);
            if (signal?.aborted || generation !== this.commitFilesGeneration) { return; }
            const metadata = files.map(file => new CommitFile({ ...file }));
            const selectedFile = metadata.find(file => (file.diffKey || file.path) === revealPath)
                ?? metadata.find(file => file.path === revealPath)
                ?? metadata[0];
            const selectedPath = selectedFile?.diffKey || selectedFile?.path;
            this.pendingFilesRevealGeneration = undefined;
            store.setState({
                files: metadata,
                filesLoading: false,
                diffLoading: false,
                diffError: undefined,
                diffProgress: { completed: 0, total: metadata.length },
                selectedPath,
            });
            // A completed historical snapshot is the only acknowledgement that may replace
            // the presentation held during a card-click selection transition.
            if (!isWorkingTreeHash(hash) && repositoryPath) {
                this.repositoryCardDisplayLocks?.delete(repositoryPath);
            }
            if (metadata.length === 0) { return; }
            if (revealDiff && this.canShowMultiDiff() && this.view?.visible) {
                this.openDiff(selectedPath);
            }
        } catch (error: any) {
            if (!this.isAbortError(error) && generation === this.commitFilesGeneration) {
                this.view?.webview.postMessage({ type: 'filesError', hash, repositoryPath, message: error instanceof Error ? error.message : String(error) });
                this.pendingFilesRevealGeneration = undefined;
                store.batch(() => {
                    this.filesLoading = false;
                    store.setState({
                        diffLoading: false,
                        diffError: error instanceof Error ? error.message : String(error),
                    });
                });
            }
        }
    }

    // 仅当前提交的 Diff 面板完成首屏渲染后，才放行 Changed Files 列表。
    private handleDiffRendered(identity?: string): void {
        if (this.pendingFilesRevealGeneration === undefined) { return; }
        const currentIdentity = `${this.currentRepositoryPath ?? ''}\u0000${this.currentHash ?? ''}`;
        if (identity !== undefined && identity !== currentIdentity) { return; }
        if (this.pendingFilesRevealGeneration !== this.commitFilesGeneration) {
            this.pendingFilesRevealGeneration = undefined;
            return;
        }
        this.pendingFilesRevealGeneration = undefined;
        this.filesLoading = false;
    }

    /** Open exactly the direct child Gitlink target; nested modules remain visible at their own level. */
    private async selectGitlinkCommit(filePath: string, hash: string, key?: string): Promise<void> {
        const normalizedFilePath = filePath.replace(/[\\\\/]+$/, '');
        const parentRepositoryPath = this.currentRepositoryPath;
        const parentCommit = this.commitController.selectedCommit;
        if (!parentRepositoryPath || !parentCommit || !hash) { return; }
        const submodule = this.repoSubmoduleWatcher.findSubmoduleRepository(parentRepositoryPath, normalizedFilePath);
        if (!submodule) {
            void vscode.window.showWarningMessage(`无法跳转子模块提交：${filePath} 尚未初始化或仓库扫描尚未完成。`);
            return;
        }
        const repositoryPath = submodule.path;
        const selectedParentFile = this.files.find(file => (file.diffKey || file.path) === (key ?? this.selectedPath)
            && file.path === normalizedFilePath)
            ?? this.files.find(file => file.path === normalizedFilePath);
        const navigationToken = new AbortController();
        this.gitlinkNavigationAbortController?.abort();
        this.gitlinkNavigationAbortController = navigationToken;
        // Submodules are commonly detached. A worktree target must use the watcher-owned
        // current branch (whose hash is the real detached HEAD), never a synthetic 'uncommitted' branch.
        let watcherBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
            .find(candidate => candidate.repoOption.path === repositoryPath);
        let preparedChanges: WorkingTreeChanges | undefined;
        let targetHash = hash;
        try {
            // A SHA is an explicit commit request. Only the worktree button may
            // inspect live status; a dirty checkout must never redirect a SHA.
            if (isWorkingTreeHash(hash)) {
                if (!isWorkingTreeHash(parentCommit.hash)) { return; }
                if (!watcherBranch) {
                    await this.uncommittedFilesWatcher.refreshHeadBranch(repositoryPath);
                    if (navigationToken.signal.aborted) { return; }
                    watcherBranch = this.uncommittedFilesWatcher.listCurrentHeadBranches()
                        .find(candidate => candidate.repoOption.path === repositoryPath);
                }
                if (!watcherBranch) { throw new Error('目标子模块 HEAD 尚未就绪'); }
                preparedChanges = await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(watcherBranch);
                if (navigationToken.signal.aborted) { return; }
                const hasChanges = preparedChanges.staged.length > 0 || preparedChanges.changes.length > 0;
                targetHash = hasChanges ? 'uncommitted' : watcherBranch.hash;
            }
            if (navigationToken.signal.aborted) { return; }
            const branch = watcherBranch
                ?? this.branchesController.getCurrentBranch(submodule)
                ?? new GitBranchOption({ repoOption: submodule, name: targetHash, label: targetHash.slice(0, 7), hash: targetHash, kind: 'local' });
            const commit = this.findCommit(targetHash, repositoryPath) ?? new CommitMetadata({ hash: targetHash, gitBranchOption: branch });
            await this.selectGitlinkRepositoryCommit(commit, undefined, () => {
                this.gitlinkParentNavigationStack.push({
                    commit: parentCommit,
                    revealPath: selectedParentFile?.diffKey || selectedParentFile?.path || normalizedFilePath,
                    childHash: targetHash,
                    childRepositoryPath: repositoryPath,
                });
            }, navigationToken, preparedChanges);
        } catch (error) {
            if (!navigationToken.signal.aborted) {
                void vscode.window.showErrorMessage('Gitlink 跳转失败：' + (error instanceof Error ? error.message : String(error)));
            }
        } finally {
            if (this.gitlinkNavigationAbortController === navigationToken) { this.gitlinkNavigationAbortController = undefined; }
        }
    }

    private async selectGitlinkRepositoryCommit(
        commit: CommitMetadata,
        revealPath: string | undefined,
        updateStack: () => void,
        navigationToken?: AbortController,
        preparedChanges?: WorkingTreeChanges,
    ): Promise<void> {
        const targetBranch = commit.gitBranchOption;
        if (!targetBranch) { return; }
        if (!navigationToken) { this.gitlinkNavigationAbortController?.abort(); }
        const controller = navigationToken ?? new AbortController();
        if (controller.signal.aborted) { return; }
        this.gitlinkNavigationAbortController = controller;
        const repositoryPath = targetBranch.repoOption.path;
        try {
            const branch = await this.selectCommitPanelRepository(targetBranch, controller.signal);
            if (!branch || controller.signal.aborted) { return; }
            if (isWorkingTreeHash(commit.hash)) {
                const changes = preparedChanges && branch.hash === targetBranch.hash
                    ? preparedChanges
                    : await this.uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(branch);
                if (controller.signal.aborted) { return; }
                this.pendingGitlinkWorktreeSnapshot = { repositoryPath, branch, changes };
            } else {
                // A previously prepared worktree snapshot belongs only to the
                // synthetic Uncommitted Changes target. Never let it be reused
                // when the user explicitly selected a commit SHA.
                this.pendingGitlinkWorktreeSnapshot = undefined;
            }
            updateStack();
            this.syncGitlinkParentNavigation();
            this.requestedDiffReveal = { hash: commit.hash, repositoryPath, path: revealPath };
            const target = this.findCommit(commit.hash, repositoryPath) ?? new CommitMetadata({ ...commit, gitBranchOption: branch });
            const changed = this.commitController.selectCommit(target);
            if (!changed && this.currentHash === commit.hash && this.currentRepositoryPath === repositoryPath) {
                this.requestedDiffReveal = undefined;
                if (isWorkingTreeHash(commit.hash) && this.pendingGitlinkWorktreeSnapshot) {
                    const prepared = this.pendingGitlinkWorktreeSnapshot;
                    this.pendingGitlinkWorktreeSnapshot = undefined;
                    await this.selectWorkingTreeChanges(prepared.changes, false, false, undefined, true, undefined, revealPath);
                }
                this.openDiff(this.resolveSelectedChangedFile(revealPath));
            }
            if (!controller.signal.aborted) {
                this.view?.webview.postMessage({ type: 'revealRepositoryChanges', repositoryPath });
                this.schedulePushState();
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                void vscode.window.showErrorMessage('Gitlink 跳转失败：' + (error instanceof Error ? error.message : String(error)));
            }
        } finally {
            if (this.gitlinkNavigationAbortController === controller) { this.gitlinkNavigationAbortController = undefined; }
        }
    }
    private syncGitlinkParentNavigation(): void {
        const navigation = this.gitlinkParentNavigationStack[this.gitlinkParentNavigationStack.length - 1];
        this.multiDiffPanel.setParentCommitNavigation(navigation ? {
            hash: navigation.commit.hash,
            title: navigation.commit.message,
        } : undefined);
    }

    private reconcileGitlinkParentNavigation(hash?: string, repositoryPath?: string): void {
        // Repository selection briefly emits undefined/default commits before the exact target.
        if (this.gitlinkNavigationAbortController && !this.gitlinkNavigationAbortController.signal.aborted) { return; }
        const navigation = this.gitlinkParentNavigationStack[this.gitlinkParentNavigationStack.length - 1];
        if (!navigation || (navigation.childHash === hash && navigation.childRepositoryPath === repositoryPath)) { return; }
        this.gitlinkParentNavigationStack.length = 0;
        this.syncGitlinkParentNavigation();
    }

    private async backToParentCommit(): Promise<void> {
        const navigation = this.gitlinkParentNavigationStack.at(-1);
        if (!navigation) { return; }
        await this.selectGitlinkRepositoryCommit(navigation.commit, navigation.revealPath, () => {
            if (this.gitlinkParentNavigationStack.at(-1) === navigation) { this.gitlinkParentNavigationStack.pop(); }
        });
    }

    private resolveSelectedChangedFile(preferredPath?: string): string | undefined {
        const selectedPath = preferredPath ?? this.selectedPath;
        const resolvedPath = selectedPath && this.files.some(file => (file.diffKey || file.path) === selectedPath)
            ? selectedPath
            : (this.files[0]?.diffKey || this.files[0]?.path);
        this.selectedPath = resolvedPath;
        return resolvedPath;
    }

    // 面板已是活动标签时只做轻量定位; 未激活/未创建则由 openDiff 先激活标签再定位。
    private selectChangedFile(filePath: string): void {
        if (!this.canShowMultiDiff() || !this.view?.visible) { return; }
        const selectedFile = this.files.find(file => (file.diffKey || file.path) === filePath)
            ?? this.files.find(file => file.path === filePath);
        if (!selectedFile) { return; }
        const selectedPath = selectedFile.diffKey || selectedFile.path;
        const selectionEpoch = ++this.multiDiffSelectionEpoch;
        // Changed Files 点击本身就是权威选择，必须先写入 Store。
        // 否则定位期间任意 Diff 加载快照仍携带旧 selectedPath，会把列表高亮和 MultiDiff 又拉回旧文件。
        if (this.selectedPath !== selectedPath) { this.selectedPath = selectedPath; }
        if (this.multiDiffPanel.revealFile(selectedPath, selectionEpoch)) { return; }
        this.openDiff(selectedPath, selectionEpoch);
    }

    navigateMultiDiffChange(direction: -1 | 1): void {
        this.multiDiffPanel.navigateChange(direction);
    }

    setMultiDiffRenderSideBySide(renderSideBySide: boolean): void {
        this.multiDiffPanel.setRenderSideBySide(renderSideBySide);
    }

    showMultiDiffSearch(): void {
        this.multiDiffPanel.showSearch();
    }

    private openDiff(filePath?: string, selectionEpoch?: number): void {
        if (!this.view?.visible) {
            this.multiDiffPanel.hide();
            return;
        }
        if (!this.currentHash) {
            this.multiDiffPanel.cancelPending();
            return;
        }
        if (!this.getRepoRootUri()) { return; }
        // 完整 Diff 数据已原子写入 Store，此处只显示面板并定位文件。
        const resolvedSelectionEpoch = selectionEpoch ?? ++this.multiDiffSelectionEpoch;
        this.multiDiffPanel.show(this.currentHash, this.commitController.selectedCommit?.message ?? '', filePath, resolvedSelectionEpoch);
    }

    // 工作区 Diff 右侧编辑后回写文件。
    private async saveWorkspaceFile(filePath: string, content: string): Promise<void> {
        // 只有工作区文件(unstaged/untracked)可回写; staged 行右侧是 index 内容, 回写工作区会篡改语义。
        // filePath 是裸路径(不带 staged:/unstaged: 前缀), 合并展示后同一路径可能同时存在于两个分组,
        //   必须按 workingTreeKind 精确区分, 不能只取首个命中。
        if (this.currentChangeSet !== 'uncommitted') { return; }
        const isStagedOnly = this.files.some(file => file.path === filePath && file.workingTreeKind === 'staged')
            && !this.files.some(file => file.path === filePath && file.workingTreeKind !== 'staged');
        if (isStagedOnly) { return; }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        const fileUri = vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
        try {
            // 保留磁盘原有行尾: Monaco 传回的是 LF, 若原文件是 CRLF 直接写会让整个文件变成全量差异。
            const existing = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
            const useCrlf = /\r\n/.test(existing);
            const normalized = normalizeEol(content);
            const output = useCrlf ? normalized.replace(/\n/g, '\r\n') : normalized;
            if (output === existing) { return; }
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(output, 'utf8'));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`无法保存文件 ${filePath}: ${message}`);
        }
    }

    // 打开 Diff 对应侧的工作区文件。Ctrl/Cmd + 左键会校验该侧内容后再定位。
    private async openWorkspaceFileAtLine(
        filePath: string,
        line?: number,
        column?: number,
        side: 'original' | 'modified' = 'modified',
    ): Promise<void> {
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        const fileUri = vscode.Uri.joinPath(rootUri, ...filePath.split('/'));
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            let selection: vscode.Range | undefined;
            if (typeof line === 'number' && line > 0) {
                const expected = this.files.find(file => file.path === filePath)
                    ?? this.files.find(file => file.oldPath === filePath);
                const expectedContent = expected && 'modified' in expected
                    ? side === 'original' ? expected.original : expected.modified
                    : undefined;
                // git cat-file 读的是对象库原始内容(LF), 工作区在 core.autocrlf=true 下是 CRLF,
                // 直接全等比较会把所有文本文件都误判为已修改, 故先归一化行尾再比对。
                if (side === 'modified'
                    && typeof expectedContent === 'string'
                    && normalizeEol(document.getText()) !== normalizeEol(expectedContent)) {
                    void vscode.window.showWarningMessage(`${filePath} 与当前提交的内容已不一致（文件已被修改），无法定位到对应行。`);
                    return;
                }
                const position = document.validatePosition(new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1)));
                selection = new vscode.Range(position, position);
            }
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Active,
                selection,
                preserveFocus: false,
                preview: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`无法打开文件 ${filePath}: ${message}`);
        }
    }

    private syncFileHighlightFromDiffPanel(filePath: string, generation: number, selectionEpoch: number): void {
        const state = store.getState();
        // 已在途的旧滚动高亮不能覆盖 Changed Files 刚发起的新选择。
        if (selectionEpoch !== this.multiDiffSelectionEpoch
            || generation !== state.diffGeneration
            || state.selectedPath === filePath
            || !this.files.some(file => (file.diffKey || file.path) === filePath)) { return; }
        this.selectedPath = filePath;
    }

    // 生成 webview HTML (div flex 布局, 替代 table)
    private getSetiIconRoot(): vscode.Uri {
        const bundledRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'seti');
        const installedExtension = vscode.extensions.getExtension('vscode.vscode-theme-seti')
            ?? vscode.extensions.getExtension('vscode.theme-seti');
        if (!installedExtension) { return bundledRoot; }
        const installedRoot = vscode.Uri.joinPath(installedExtension.extensionUri, 'icons');
        if (installedRoot.scheme !== 'file'
            || existsSync(vscode.Uri.joinPath(installedRoot, 'seti.woff').fsPath)) {
            return installedRoot;
        }
        return bundledRoot;
    }

    private getHtml(): string {
        const codiconCssUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons', 'codicon.css'),
        );
        const setiIconRoot = this.getSetiIconRoot();
        const setiFontUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(setiIconRoot, 'seti.woff'),
        );
        const setiIconDefinitions = readInstalledSetiIconDefinitions(setiIconRoot);
        return renderGitkWebviewHtml(String(codiconCssUri), String(setiFontUri), setiIconDefinitions);
    }
}
