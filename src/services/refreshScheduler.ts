/**
 * 刷新优先级常量与类型
 *
 * 优先级: RepositoryState(1) < Lifecycle(2) < RepositorySelection(3)
 * 高优先级抢占低优先级, 同优先级合并 (skipSelectors 取交集)
 */

export const RefreshPriority = {
    RepositoryState: 1,
    Lifecycle: 2,
    RepositorySelection: 3,
} as const;

export type RefreshPriorityValue = typeof RefreshPriority[keyof typeof RefreshPriority];

export interface QueuedRefresh {
    priority: RefreshPriorityValue;
    skipSelectors: boolean;
    resolvers: Array<() => void>;
    rejecters: Array<(reason: unknown) => void>;
}
