import * as vscode from 'vscode';
import type { WorkingTreeChanges } from '../types';

/** Git 工作区、Stash 与对象读取边界，全部由 libgit2 原生后端实现。 */
export interface GitBackend extends vscode.Disposable {
    warmup(rootUri: vscode.Uri): Promise<void>;
    readObjects(rootUri: vscode.Uri, objects: readonly string[]): Promise<Map<string, string>>;
    getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getWorkingTreeStatusWithoutSubmoduleWorktrees(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getWorkingTreeStatusForPaths(rootUri: vscode.Uri, paths: readonly string[], signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>>;
    hasWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean>;
    stage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    unstage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    discardWorktree(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    /** 创建 stash：unstaged 仅保存指定工作区文件；同文件 staged 内容须显式确认后才合入 unstaged 快照，index 始终保持不变。 */
    stash(
        rootUri: vscode.Uri,
        scope: StashScope,
        paths?: readonly string[],
        mergeStagedIntoUnstaged?: boolean,
        allUnstagedPaths?: boolean,
    ): Promise<StashResult>;
    /**
     * 应用 stash 并保留条目（git stash apply）。stash 用提交 hash 标识：序号会随其他 stash 操作移位。
     */
    stashApply(rootUri: vscode.Uri, stash: string): Promise<StashApplyResult>;
    /** 将 stash 中选定文件还原到工作区，不修改 index，也不删除 stash 条目。 */
    stashRestorePaths(rootUri: vscode.Uri, stash: string, paths: readonly string[]): Promise<void>;
    /** 应用并删除条目（git stash pop）；应用带冲突时与 Git 一致地保留条目。 */
    stashPop(rootUri: vscode.Uri, stash: string): Promise<StashApplyResult>;
    /** 删除 stash 条目（git stash drop）。提交对象保留到垃圾回收前。 */
    stashDrop(rootUri: vscode.Uri, stash: string): Promise<void>;
}

export type StashScope = 'unstaged' | 'staged';

export interface StashApplyResult {
    readonly stash: string;
    /** 应用后索引里有冲突，冲突文件留在工作区。 */
    readonly conflicts: boolean;
    /** 条目是否已被删除（只有 pop 且没有冲突时为 true）。 */
    readonly dropped: boolean;
}

export interface StashResult {
    readonly stash: string;
    /** 与 Git CLI 一致：没有匹配修改时成功返回但不创建条目。 */
    readonly created?: boolean;
    /** libgit2 未从工作区移走的子模块（gitlink）路径，由界面提示。 */
    readonly skippedGitlinks: readonly string[];
}
