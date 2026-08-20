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
    inputSwimlanes?: GraphLane[];
    outputSwimlanes?: GraphLane[];
    laneColor?: string;
    laneStartsHere?: boolean;
}

export interface GraphLane {
    hash: string;
    color: string;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

/**
 * 仓库选项; 所有属性不可变。
 *
 * 改属性只能走 copyRepositoryOption 造新对象整体替换, 禁止原地赋值。
 * 属性全同的两个实例视为同一个对象, 判等用 equalsRepositoryOption, 不用 ===。
 */
export interface GitRepositoryOption {
    readonly path: string;
    readonly label: string;
    readonly description?: string;
    readonly hasSubmodules?: boolean;
}

/** 改某个属性的唯一入口: 返回新对象, 原对象保持不变。 */
export function copyRepositoryOption(
    source: GitRepositoryOption,
    changes: Partial<GitRepositoryOption>,
): GitRepositoryOption {
    return { ...source, ...changes };
}

/** 属性全同即同一个对象。 */
export function equalsRepositoryOption(left: GitRepositoryOption, right: GitRepositoryOption): boolean {
    return left.path === right.path
        && left.label === right.label
        && left.description === right.description
        && left.hasSubmodules === right.hasSubmodules;
}

/** 工作区虚拟提交; 所有属性不可变, 随宿主分支一同整体替换。 */
export interface GitBranchVirtualCommit {
    readonly mode: Exclude<ChangeSetMode, 'commit'>;
    readonly hash: string;
    readonly label: string;
    readonly enabled: boolean;
}

export type GitBranchKind = 'current' | 'local' | 'remote';

/**
 * 分支选项; 所有属性不可变。
 *
 * 改属性只能走 copyBranchOption 造新对象整体替换, 禁止原地赋值。
 * 属性全同的两个实例视为同一个对象, 判等用 equalsBranchOption, 不用 ===。
 */
export interface GitBranchOption {
    readonly name: string;
    readonly label: string;
    readonly hash: string;
    readonly kind: GitBranchKind;
    /** 仅 current 分支使用：工作区是否有未暂存变更。 */
    readonly hasChangeFiles?: boolean;
    /** 仅 current 分支使用：暂存区是否有变更。 */
    readonly hasStagedChangeFiles?: boolean;
    readonly virtualCommits?: readonly GitBranchVirtualCommit[];
}

/** 改某个属性的唯一入口: 返回新对象, 原对象保持不变。 */
export function copyBranchOption(
    source: GitBranchOption,
    changes: Partial<GitBranchOption>,
): GitBranchOption {
    return { ...source, ...changes };
}

function equalsVirtualCommits(
    left: readonly GitBranchVirtualCommit[] | undefined,
    right: readonly GitBranchVirtualCommit[] | undefined,
): boolean {
    if (left === right) { return true; }
    if (!left || !right || left.length !== right.length) { return false; }
    return left.every((commit, index) => {
        const other = right[index];
        return commit.mode === other.mode
            && commit.hash === other.hash
            && commit.label === other.label
            && commit.enabled === other.enabled;
    });
}

/** 属性全同即同一个对象; virtualCommits 逐项比较。 */
export function equalsBranchOption(left: GitBranchOption, right: GitBranchOption): boolean {
    return left.name === right.name
        && left.label === right.label
        && left.hash === right.hash
        && left.kind === right.kind
        && left.hasChangeFiles === right.hasChangeFiles
        && left.hasStagedChangeFiles === right.hasStagedChangeFiles
        && equalsVirtualCommits(left.virtualCommits, right.virtualCommits);
}

export interface CommitFile {
    path: string;
    status: FileStatus;
    oldPath?: string;
    oldObjectId?: string;
    newObjectId?: string;
    oldMode?: string;
    newMode?: string;
    isBinary?: boolean;
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
