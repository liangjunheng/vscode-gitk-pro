import * as vscode from 'vscode';

// 提交元数据；图形字段由提交控制器补充。
export class CommitMetadata {
    gitBranchOption?: GitBranchOption;
    hash = '';
    shortHash = '';
    parents: string[] = [];
    author = '';
    authorEmail?: string;
    committer = '';
    committerEmail?: string;
    authorDate = '';
    authorDateLabel = '';
    message = '';
    body?: string;
    refs: string[] = [];
    lane?: number;
    inputSwimlanes?: GraphLane[];
    outputSwimlanes?: GraphLane[];
    laneColor?: string;
    laneStartsHere?: boolean;

    constructor(init: Partial<CommitMetadata> = {}) {
        Object.assign(this, init);
    }

    equals(other: CommitMetadata): boolean {
        const sameBranch = this.gitBranchOption && other.gitBranchOption
            ? this.gitBranchOption.equals(other.gitBranchOption)
            : this.gitBranchOption === other.gitBranchOption;
        return this.hash === other.hash && sameBranch;
    }
}

// Webview 之外使用的提交聚合对象；提交元数据、文件元数据和完整 Diff 属于同一提交。
export class GitCommitOption {
    constructor(
        readonly commitMetadata: CommitMetadata,
        readonly commitFiles: readonly CommitFile[] = [],
        readonly diffPayload: readonly DiffPayload[] = [],
    ) {}

    equals(other: GitCommitOption): boolean {
        return this.commitMetadata.equals(other.commitMetadata)
            && this.commitFiles.length === other.commitFiles.length
            && this.commitFiles.every((file, index) => file.equals(other.commitFiles[index]))
            && this.diffPayload.length === other.diffPayload.length
            && this.diffPayload.every((payload, index) => payload.equals(other.diffPayload[index]));
    }
}

export class GraphLane {
    hash = '';
    color = '';

    constructor(init: Partial<GraphLane> = {}) {
        Object.assign(this, init);
    }

    equals(other: GraphLane): boolean {
        return this.hash === other.hash && this.color === other.color;
    }
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

/**
 * 仓库选项; 所有属性不可变。
 *
 * 属性不可变，修改时创建新的 GitRepositoryOption 实例。
 * 属性全同的两个实例视为同一个对象, 判等直接调用实例 equals。
 */
export class GitRepositoryOption {
    readonly path: string;
    readonly label: string;
    readonly description?: string;
    readonly hasSubmodules?: boolean;

    constructor(init: { path: string; label: string; description?: string; hasSubmodules?: boolean }) {
        this.path = init.path;
        this.label = init.label;
        this.description = init.description;
        this.hasSubmodules = init.hasSubmodules;
    }

    equals(other: GitRepositoryOption): boolean {
        return this.path === other.path
            && this.label === other.label
            && this.description === other.description
            && this.hasSubmodules === other.hasSubmodules;
    }
}

export type GitBranchKind = 'current' | 'local' | 'remote';

/**
 * 分支选项; 所有属性不可变。
 *
 * 属性不可变，修改时创建新的 GitBranchOption 实例。
 * 属性全同的两个实例视为同一个对象, 判等直接调用实例 equals。
 */
export class GitBranchOption {
    readonly repoOption: GitRepositoryOption;
    readonly name: string;
    readonly label: string;
    readonly hash: string;
    readonly kind: GitBranchKind;

    constructor(init: {
        repoOption: GitRepositoryOption;
        name: string;
        label: string;
        hash: string;
        kind: GitBranchKind;
    }) {
        this.repoOption = init.repoOption;
        this.name = init.name;
        this.label = init.label;
        this.hash = init.hash;
        this.kind = init.kind;
    }

    equals(other: GitBranchOption): boolean {
        return this.repoOption.equals(other.repoOption)
            && this.name === other.name
            && this.label === other.label
            && this.hash === other.hash
            && this.kind === other.kind;
    }
}

export class CommitFile {
    path = '';
    status: FileStatus = 'M';
    oldPath?: string;
    oldObjectId?: string;
    newObjectId?: string;
    oldMode?: string;
    newMode?: string;
    isBinary?: boolean;
    isUntracked?: boolean;
    workingTreeKind?: 'untracked' | 'unstaged' | 'staged';
    diffKey?: string;

    constructor(init: Partial<CommitFile> = {}) {
        Object.assign(this, init);
    }

    equals(other: CommitFile): boolean {
        return this.path === other.path
            && this.status === other.status
            && this.oldPath === other.oldPath
            && this.oldObjectId === other.oldObjectId
            && this.newObjectId === other.newObjectId
            && this.oldMode === other.oldMode
            && this.newMode === other.newMode
            && this.isBinary === other.isBinary
            && this.isUntracked === other.isUntracked
            && this.workingTreeKind === other.workingTreeKind
            && this.diffKey === other.diffKey;
    }
}

export type ChangeSetMode = 'commit' | 'staged' | 'changes' | 'uncommitted';

export class WorkingTreeChanges {
    staged: CommitFile[] = [];
    changes: CommitFile[] = [];

    constructor(init: Partial<WorkingTreeChanges> = {}) {
        this.staged = init.staged ?? [];
        this.changes = init.changes ?? [];
    }

    equals(other: WorkingTreeChanges): boolean {
        return this.staged.length === other.staged.length
            && this.staged.every((file, index) => file.equals(other.staged[index]))
            && this.changes.length === other.changes.length
            && this.changes.every((file, index) => file.equals(other.changes[index]));
    }
}

export class GitRepositoryState {
    head = '';
    branch = '';
    refs = '';
    status = '';

    constructor(init: Partial<GitRepositoryState> = {}) {
        Object.assign(this, init);
    }

    equals(other: GitRepositoryState): boolean {
        return this.head === other.head
            && this.branch === other.branch
            && this.refs === other.refs
            && this.status === other.status;
    }
}

// Diff 数据载荷
export class DiffPayload extends CommitFile {
    index = 0;
    fullPath = '';
    original = '';
    modified = '';
    error?: string;

    constructor(init: Partial<DiffPayload> = {}) {
        super(init);
        Object.assign(this, init);
    }

    equals(other: DiffPayload): boolean {
        return super.equals(other)
            && this.index === other.index
            && this.fullPath === other.fullPath
            && this.original === other.original
            && this.modified === other.modified
            && this.error === other.error;
    }
}

// Changed Files 在读取正文前为元数据，完成后替换为完整 Diff 数据。
export type ChangedFile = CommitFile | DiffPayload;

// Multi-Diff 加载事件
export class MultiDiffLoadEvent {
    type: 'progress' | 'complete' | 'error' = 'progress';
    hash = '';
    rootUri: vscode.Uri;
    generation = 0;
    completed = 0;
    total = 0;
    message?: string;

    constructor(init: {
        type: 'progress' | 'complete' | 'error';
        hash: string;
        rootUri: vscode.Uri;
        generation: number;
        completed: number;
        total: number;
        message?: string;
    }) {
        Object.assign(this, init);
    }

    equals(other: MultiDiffLoadEvent): boolean {
        return this.type === other.type
            && this.hash === other.hash
            && this.rootUri.toString() === other.rootUri.toString()
            && this.generation === other.generation
            && this.completed === other.completed
            && this.total === other.total
            && this.message === other.message;
    }
}
