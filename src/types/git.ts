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
    oldObjectId?: string;
    newObjectId?: string;
    oldMode?: string;
    newMode?: string;
    addedLines?: number;
    removedLines?: number;
}

export type ChangeSetMode = 'commit' | 'staged' | 'changes';

export interface WorkingTreeChanges {
    staged: CommitFile[];
    changes: CommitFile[];
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

// Changed Files 在读取正文前为元数据，完成后替换为完整 Diff 数据。
export type ChangedFile = CommitFile | DiffPayload;

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
