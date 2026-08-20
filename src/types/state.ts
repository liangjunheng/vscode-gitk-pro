import * as vscode from 'vscode';
import { ChangeSetMode, ChangedFile, GitCommit, RepositoryCommit } from './git';

export type GitSyncAction = 'fetch' | 'pull' | 'push';

// UI 仅提交意图；Provider 统一负责副作用与状态转换。
export type GitkIntent =
    | { type: 'focus' }
    | { type: 'blur' }
    | { type: 'refresh' }
    | { type: 'selectRepositories'; paths: unknown }
    | { type: 'selectBranches'; names: unknown }
    | { type: 'loadMoreCommits' }
    | { type: 'gitSync'; action: unknown }
    | { type: 'commitAction'; action: unknown; hash: unknown; repositoryPath: unknown }
    | { type: 'selectCommit'; hash: unknown; repositoryPath?: unknown }
    | { type: 'selectFile'; path?: unknown }
    | { type: 'copyFilePath'; path: unknown; absolute?: unknown }
    | { type: 'toggleFilesMode' }
    | { type: 'search'; keywords: unknown };

// 单一数据源: 应用全局状态
// 仓库维度状态 (totalRepoList / selectedRepoList / scanning) 由 GitRepoController 独占持有, 不入 Store。
// 分支维度状态 (branchesMap / selectedBranches / loadingRepos) 由 GitBranchesController 独占持有, 不入 Store。
export interface AppState {
    // 提交数据
    commits: RepositoryCommit[];
    rawCommits: GitCommit[];
    hasMoreCommits: boolean;
    isLoadingMoreCommits: boolean;
    commitPageError: string;

    // 当前选中
    currentHash: string | undefined;
    currentRepositoryPath: string | undefined;
    currentChangeSet: ChangeSetMode;
    files: ChangedFile[];
    filesLoading: boolean;
    selectedPath: string | undefined;
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
        filesLoading: false,
        selectedPath: undefined,
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
    };
}
