import * as vscode from 'vscode';

// 单条提交记录
export interface GitCommit {
    hash: string;
    shortHash: string;
    parents: string[];
    author: string;
    authorEmail?: string;
    committer: string;
    committerEmail?: string;
    authorDate: string;
    authorDateLabel: string;
    message: string;
    body?: string;
    refs: string[];
    lane?: number;
    lanes?: LaneInfo[];
    laneColor?: string;
    laneStartsHere?: boolean;
}

export interface LaneInfo {
    fromLane: number;
    toLane: number;
    color: string;
    isCommit: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface GitRepositoryOption {
    path: string;
    label: string;
    description?: string;
    hasSubmodules?: boolean;
}

export interface GitBranchVirtualCommit {
    mode: Exclude<ChangeSetMode, 'commit'>;
    hash: string;
    label: string;
    files: CommitFile[];
}

export type GitBranchKind = 'current' | 'local' | 'remote';

export interface GitBranchOption {
    name: string;
    label: string;
    hash: string;
    kind: GitBranchKind;
    virtualCommits?: GitBranchVirtualCommit[];
}

export interface CommitFile {
    path: string;
    status: FileStatus;
    oldPath?: string;
    addedLines?: number;
    removedLines?: number;
}

export type ChangeSetMode = 'commit' | 'staged' | 'changes';

export interface WorkingTreeChanges {
    staged: CommitFile[];
    changes: CommitFile[];
}

export interface GraphState {
    activeLanes: Array<{ hash: string; color: string } | undefined>;
    visibleHashes: Set<string>;
    nextColor: number;
}

export interface GitRepositoryState {
    head: string;
    branch: string;
    refs: string;
    status: string;
}

// 带仓库路径的提交记录 (用于多仓库合并视图)
export interface RepositoryCommit extends GitCommit {
    repositoryPath: string;
}

// Diff 数据载荷
export interface DiffPayload extends CommitFile {
    index: number;
    fullPath: string;
    original: string;
    modified: string;
    error?: string;
}

// Multi-Diff 加载事件
export interface MultiDiffLoadEvent {
    type: 'progress' | 'complete' | 'error';
    hash: string;
    rootUri: vscode.Uri;
    generation: number;
    completed: number;
    total: number;
    message?: string;
}

export interface VisibleCommitTarget {
    hash: string;
    repositoryPath: string;
}

// VS Code Git 扩展 API 类型 (部分字段)
export interface GitRefApi {
    readonly name?: string;
    readonly type?: number; // 0=Head, 1=RemoteHead, 2=Tag
    readonly commit?: string;
}

export interface GitChangeApi {
    readonly uri: vscode.Uri;
    readonly originalUri: vscode.Uri;
    readonly renameUri?: vscode.Uri;
    readonly status: number;
}

export interface GitApiRepository {
    rootUri: vscode.Uri;
    state: {
        HEAD?: GitRefApi;
        refs?: GitRefApi[];
        workingTreeChanges?: GitChangeApi[];
        indexChanges?: GitChangeApi[];
        onDidChange: vscode.Event<void>;
    };
}

export interface GitApi {
    repositories: GitApiRepository[];
    onDidOpenRepository?: vscode.Event<GitApiRepository>;
    onDidCloseRepository?: vscode.Event<GitApiRepository>;
}

export interface GitExtensionApi {
    getAPI(version: 1): GitApi;
}
