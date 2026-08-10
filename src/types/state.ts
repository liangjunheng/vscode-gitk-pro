import * as vscode from 'vscode';
import { ChangeSetMode, CommitFile, DiffPayload, GitBranchOption, GitCommit, GitRepositoryOption, GraphState, RepositoryCommit } from './git';

export type GitSyncAction = 'fetch' | 'pull' | 'push';

// UI 仅提交意图；Provider 统一负责副作用与状态转换。
export type GitkIntent =
    | { type: 'focus' }
    | { type: 'blur' }
    | { type: 'refresh' }
    | { type: 'selectRepositories'; paths: unknown }
    | { type: 'selectBranches'; names: unknown }
    | { type: 'loadMoreCommits' }
    | { type: 'visibleCommits'; commits: Array<{ hash: string; repositoryPath: string }> }
    | { type: 'gitSync'; action: unknown }
    | { type: 'commitAction'; action: unknown; hash: unknown; repositoryPath: unknown }
    | { type: 'selectCommit'; hash: unknown; repositoryPath?: unknown }
    | { type: 'selectFile'; path?: unknown }
    | { type: 'copyFilePath'; path: unknown; absolute?: unknown }
    | { type: 'toggleFilesMode' }
    | { type: 'search'; keywords: unknown };

export interface DiffEntry {
    key: string;
    repositoryPath: string;
    hash: string;
    changeSet: ChangeSetMode;
    files: CommitFile[];
    data: DiffPayload[];
    loading: boolean;
    progress: { completed: number; total: number };
    error: string | undefined;
}

// 单一数据源: 应用全局状态
export interface AppState {
    // 仓库/分支选择
    repositories: GitRepositoryOption[];
    selectedRepositoryPaths: string[];
    hasRepositorySelection: boolean;
    branches: GitBranchOption[];
    selectedBranches: string[];
    hasBranchSelection: boolean;

    // 提交数据
    commits: RepositoryCommit[];
    rawCommits: GitCommit[];
    graphState: GraphState;
    allCommitHashes: string[];
    hasMoreCommits: boolean;
    isLoadingMoreCommits: boolean;
    commitPageError: string;

    // 当前选中
    currentHash: string | undefined;
    currentRepositoryPath: string | undefined;
    currentChangeSet: ChangeSetMode;
    files: CommitFile[];
    filesLoading: boolean;
    selectedPath: string | undefined;
    displayMode: 'tree' | 'flat';

    // 工作区变更
    stagedFiles: CommitFile[];
    changeFiles: CommitFile[];

    // 搜索
    searchKeywords: string[];
    searchBackupCommits: RepositoryCommit[] | null;

    // UI 状态
    isLoading: boolean;
    loadingMessage: string | undefined;
    isFocused: boolean;
    isViewVisible: boolean;

    // Multi-Diff 面板数据 (单一数据源)
    diffData: DiffPayload[];
    diffEntries: Record<string, DiffEntry>;
    diffLoading: boolean;
    diffProgress: { completed: number; total: number };
    diffError: string | undefined;
    diffGeneration: number;
}

export function createInitialState(): AppState {
    return {
        repositories: [],
        selectedRepositoryPaths: [],
        hasRepositorySelection: false,
        branches: [],
        selectedBranches: [],
        hasBranchSelection: false,

        commits: [],
        rawCommits: [],
        graphState: { activeLanes: [], visibleHashes: new Set(), nextColor: 0 },
        allCommitHashes: [],
        hasMoreCommits: false,
        isLoadingMoreCommits: false,
        commitPageError: '',

        currentHash: undefined,
        currentRepositoryPath: undefined,
        currentChangeSet: 'commit',
        files: [],
        filesLoading: false,
        selectedPath: undefined,
        displayMode: 'flat',

        stagedFiles: [],
        changeFiles: [],

        searchKeywords: [],
        searchBackupCommits: null,

        isLoading: true,
        loadingMessage: undefined,
        isFocused: false,
        isViewVisible: false,

        // Multi-Diff 面板数据 (单一数据源)
        diffData: [],
        diffEntries: {},
        diffLoading: false,
        diffProgress: { completed: 0, total: 0 },
        diffError: undefined,
        diffGeneration: 0,
    };
}
