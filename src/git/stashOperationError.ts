export type StashOperationErrorCode =
    | 'no-stash'
    | 'local-changes-overwritten'
    | 'stash-conflict'
    | 'uncommitted-index'
    | 'operation-in-progress'
    | 'unknown';

export class StashOperationError extends Error {
    constructor(readonly code: StashOperationErrorCode, message: string, readonly cause?: unknown) {
        super(message);
        this.name = 'StashOperationError';
    }
}

export function classifyStashOperationError(error: unknown): StashOperationErrorCode {
    if (error instanceof StashOperationError) { return error.code; }
    const message = error instanceof Error ? error.message : String(error);
    if (/No stash found|no stashed state|Stash 已不存在/i.test(message)) { return 'no-stash'; }
    if (/local changes.*overwritten|本地修改与 stash 冲突|Stash 路径已有本地修改|已存在或有本地修改.*stash/i.test(message)) {
        return 'local-changes-overwritten';
    }
    if (/^CONFLICT\b/im.test(message) || /应用 Stash 后存在冲突|native conflict/i.test(message)) { return 'stash-conflict'; }
    if (/index is not clean|暂存区是干净|Uncommitted/i.test(message)) { return 'uncommitted-index'; }
    if (/存在未解决的.*冲突|operation.*progress/i.test(message)) { return 'operation-in-progress'; }
    return 'unknown';
}

export function toStashOperationError(error: unknown): StashOperationError {
    if (error instanceof StashOperationError) { return error; }
    return new StashOperationError(
        classifyStashOperationError(error),
        error instanceof Error ? error.message : String(error),
        error,
    );
}
