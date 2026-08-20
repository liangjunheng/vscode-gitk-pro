import { AppState, createInitialState, GitkIntent } from '../types';

export type StoreEffect =
    | { type: 'refresh' }
    | { type: 'selectRepositories'; paths: unknown }
    | { type: 'selectBranches'; names: string[] }
    | { type: 'loadMoreCommits' }
    | { type: 'gitSync'; action: unknown }
    | { type: 'commitAction'; action: unknown; hash: unknown; repositoryPath: unknown }
    | { type: 'selectCommit'; hash: unknown; repositoryPath?: unknown }
    | { type: 'selectFile'; path?: unknown }
    | { type: 'copyFilePath'; path: unknown; absolute?: unknown }
    | { type: 'persistFilesDisplayMode'; displayMode: AppState['displayMode'] }
    | { type: 'search'; keywords: unknown };

type Listener = (state: AppState) => void;
type Selector<T> = (state: AppState) => T;

/**
 * 单一数据源 Store
 * 
 * 所有状态变更通过 setState / patch 进行, 自动通知订阅者。
 * UI 通过 subscribe 订阅状态变化, 实现数据驱动 UI。
 */
export class Store {
    private state: AppState = createInitialState();
    private listeners = new Set<Listener>();
    private batchDepth = 0;
    private batchDirty = false;

    /** 获取当前状态 (只读快照) */
    getState(): Readonly<AppState> {
        return this.state;
    }

    /** 部分更新状态, 合并后通知所有订阅者 */
    setState(partial: Partial<AppState>): void {
        this.state = { ...this.state, ...partial };
        if (this.batchDepth > 0) {
            this.batchDirty = true;
        } else {
            this.notify();
        }
    }

    /** 将 UI Intent 归约为同步状态变化与声明式副作用；Store 不执行 I/O。 */
    dispatch(intent: GitkIntent): readonly StoreEffect[] {
        let partial: Partial<AppState> | undefined;
        let effects: readonly StoreEffect[] = [];
        switch (intent.type) {
            case 'focus':
                partial = { isFocused: true };
                break;
            case 'blur':
                partial = { isFocused: false };
                break;
            case 'refresh':
                effects = [{ type: 'refresh' }];
                break;
            // 仓库选择由 GitRepoController 独占写入; Store 只做类型过滤后转发意图。
            case 'selectRepositories': {
                if (!Array.isArray(intent.paths) || !intent.paths.every(path => typeof path === 'string')) { break; }
                effects = [{ type: 'selectRepositories', paths: [...new Set(intent.paths)] }];
                break;
            }
            // 分支选择由 GitBranchesController 独占写入; Store 只做类型过滤后转发意图。
            case 'selectBranches': {
                if (!Array.isArray(intent.names) || !intent.names.every(name => typeof name === 'string')) { break; }
                effects = [{ type: 'selectBranches', names: [...new Set(intent.names)] }];
                break;
            }
            case 'loadMoreCommits':
                effects = [{ type: 'loadMoreCommits' }];
                break;
            case 'gitSync':
                effects = [{ type: 'gitSync', action: intent.action }];
                break;
            case 'commitAction':
                effects = [{ type: 'commitAction', action: intent.action, hash: intent.hash, repositoryPath: intent.repositoryPath }];
                break;
            case 'selectCommit': {
                const isWorkingTree = intent.hash === 'staged' || intent.hash === 'changes';
                const isCommit = typeof intent.hash === 'string' && typeof intent.repositoryPath === 'string';
                if (!isWorkingTree && !isCommit) { break; }
                const hash = intent.hash as string;
                const repositoryPath = isWorkingTree
                    ? this.state.currentRepositoryPath
                    : intent.repositoryPath as string;
                const changeSet: AppState['currentChangeSet'] = isWorkingTree ? hash as 'staged' | 'changes' : 'commit';
                partial = {
                    currentHash: hash,
                    currentRepositoryPath: repositoryPath,
                    currentChangeSet: changeSet,
                    selectedPath: undefined,
                    files: [],
                    filesLoading: true,
                };
                effects = [{ type: 'selectCommit', hash: intent.hash, repositoryPath: intent.repositoryPath }];
                break;
            }
            case 'selectFile':
                if (typeof intent.path !== 'string' || !this.state.files.some(file => file.path === intent.path)) { break; }
                if (intent.path === this.state.selectedPath) { break; }
                partial = { selectedPath: intent.path };
                effects = [{ type: 'selectFile', path: intent.path }];
                break;
            case 'copyFilePath':
                effects = [{ type: 'copyFilePath', path: intent.path, absolute: intent.absolute }];
                break;
            case 'toggleFilesMode': {
                const displayMode = this.state.displayMode === 'tree' ? 'flat' : 'tree';
                partial = { displayMode };
                effects = [{ type: 'persistFilesDisplayMode', displayMode }];
                break;
            }
            case 'search':
                effects = [{ type: 'search', keywords: intent.keywords }];
                break;
        }
        if (partial) { this.setState(partial); }
        return effects;
    }

    /** 函数式更新: 基于当前状态计算新状态 */
    patch(updater: (state: AppState) => Partial<AppState>): void {
        const partial = updater(this.state);
        this.state = { ...this.state, ...partial };
        if (this.batchDepth > 0) {
            this.batchDirty = true;
        } else {
            this.notify();
        }
    }

    /** 批量更新: 收集多次 setState, 退出时仅通知一次 */
    batch<T>(fn: () => T): T {
        this.batchDepth++;
        try {
            return fn();
        } finally {
            this.batchDepth--;
            if (this.batchDepth === 0 && this.batchDirty) {
                this.batchDirty = false;
                this.notify();
            }
        }
    }

    /** 订阅状态变化, 返回取消订阅函数 */
    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** 选择器订阅: 仅当选择值变化时回调 */
    subscribeSelector<T>(selector: Selector<T>, listener: (value: T, state: AppState) => void): () => void {
        let prev = selector(this.state);
        const wrapped: Listener = (state) => {
            const next = selector(state);
            if (next !== prev) {
                prev = next;
                listener(next, state);
            }
        };
        this.listeners.add(wrapped);
        return () => this.listeners.delete(wrapped);
    }

    private notify(): void {
        for (const listener of this.listeners) {
            listener(this.state);
        }
    }
}

/** 全局 Store 单例 */
export const store = new Store();
