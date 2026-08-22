import * as vscode from 'vscode';
import { ChangeSetMode, ChangedFile, CommitMetadata } from './git';

export type GitSyncAction = 'fetch' | 'pull' | 'push';

// UI 仅提交意图；Provider 统一负责副作用与状态转换。
export type GitkIntent =
    | { type: 'focus' }
    | { type: 'blur' }
    | { type: 'webviewReady' }
    | { type: 'refresh' }
    | { type: 'selectRepositories'; paths: unknown }
    | { type: 'selectBranches'; names: unknown }
    | { type: 'loadMoreCommits' }
    | { type: 'gitSync'; action: unknown }
    | { type: 'commitAction'; action: unknown; hash: unknown; repositoryPath: unknown }
    | { type: 'selectCommit'; hash: unknown; repositoryPath?: unknown }
    | { type: 'selectFile'; path?: unknown }
    | { type: 'copyFilePath'; path: unknown; absolute?: unknown }
    | { type: 'workingTreeAction'; action: unknown; section: unknown; path?: unknown }
    | { type: 'toggleFilesMode' }
    | { type: 'search'; keywords: unknown };

// 单一数据源: 应用全局状态
// 仓库维度状态 (totalRepoList / selectedRepoList / isLoading) 由 GitRepoController 独占持有, 不入 Store。
// 分支维度状态 (branchesMap / selectedBranches / loadingRepos) 由 GitBranchesController 独占持有, 不入 Store。
export interface AppState {
    // 提交数据
    commits: Array<CommitMetadata & { key: string }>;
    rawCommits: CommitMetadata[];
    hasMoreCommits: boolean;
    isLoadingMoreCommits: boolean;
    commitPageError: string;

    // 当前选中
    currentHash: string | undefined;
    currentRepositoryPath: string | undefined;
    currentChangeSet: ChangeSetMode;
    files: ChangedFile[];
    stagedFiles: ChangedFile[];
    unstagedFiles: ChangedFile[];
    workingTreeRows: Array<{ hash: 'uncommitted'; label: string; repositoryPath: string; enabled: boolean }>;
    filesLoading: boolean;
    workingTreeActionLoading: boolean;
    selectedPath: string | undefined;
    selectedCommit: { key: string; hash: string; repositoryPath: string; kind: ChangeSetMode } | null;
    displayMode: 'tree' | 'flat';

    // 搜索
    searchKeywords: string[];

    // UI 状态
    isLoading: boolean;
    loadingMessage: string | undefined;
    isFocused: boolean;
    isViewVisible: boolean;

    // Multi-Diff 面板状态；Diff 正文复用 files。
    diffLoading: boolean;
    diffProgress: { completed: number; total: number };
    diffError: string | undefined;
    diffGeneration: number;
    commitListRevision: number;
}

export function createInitialState(): AppState {
    return {
        commits: [],
        rawCommits: [],
        hasMoreCommits: false,
        isLoadingMoreCommits: false,
        commitPageError: '',

        currentHash: undefined,
        currentRepositoryPath: undefined,
        currentChangeSet: 'commit',
        files: [],
        stagedFiles: [],
        unstagedFiles: [],
        workingTreeRows: [],
        filesLoading: false,
        workingTreeActionLoading: false,
        selectedPath: undefined,
        selectedCommit: null,
        displayMode: 'flat',

        searchKeywords: [],

        isLoading: true,
        loadingMessage: undefined,
        isFocused: false,
        isViewVisible: false,

        // Multi-Diff 面板状态
        diffLoading: false,
        diffProgress: { completed: 0, total: 0 },
        diffError: undefined,
        diffGeneration: 0,
        commitListRevision: 0,
    };
}
