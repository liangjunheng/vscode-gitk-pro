# UncommittedFilesWatcher 设计与接入

## 目标

`UncommittedFilesWatcher` 是当前工作区未提交文件状态的唯一读取者和监听者。它为每个当前仓库 HEAD 维护以下状态：

- Staged files；
- Unstaged files；
- Untracked files。

不使用定期轮询。状态变更由仓库工作区文件 watcher 驱动。

## 现有数据模型

复用 `WorkingTreeChanges`：

```ts
class WorkingTreeChanges {
    staged: CommitFile[];
    changes: CommitFile[];
}
```

- `staged`：已暂存文件；
- `changes`：未暂存文件和未跟踪文件；
- `changes` 内 `CommitFile.isUntracked === true`：未跟踪文件。

读取使用现有 `getWorkingTreeChanges(rootUri)`，由一次 Git 状态快照生成完整结果。

## 对外接口

```ts
export class UncommittedFilesWatcher implements vscode.Disposable {
    readonly onEachHeadBranchUncommittedFileChanged:
        vscode.Event<{
            branch: GitBranchOption;
            changes: WorkingTreeChanges;
        }>;

    getUncommittedFilesByHeadBranch(
        branch: GitBranchOption,
    ): Promise<WorkingTreeChanges>;

    refreshUncommittedFilesByHeadBranch(
        branch: GitBranchOption,
    ): Promise<void>;
}
```

### `getUncommittedFilesByHeadBranch()`

- 仅接受 `kind === 'current'` 的分支；
- 缓存命中时返回 `WorkingTreeChanges` 副本；
- 缓存未命中时请求当前仓库刷新，再返回缓存；
- 传入非当前 HEAD 分支时抛出错误，不能把其他 ref 当成工作区状态。

### `refreshUncommittedFilesByHeadBranch()`

用于 stage、unstage、discard 等主动 Git 操作完成后请求刷新。它同样只允许当前 HEAD 分支，并进入该仓库的刷新槽，不会并发运行 Git status。

### `onEachHeadBranchUncommittedFileChanged`

仅在 staged、unstaged 或 untracked 文件列表实际变化时发布：

```ts
{
    branch: GitBranchOption;
    changes: WorkingTreeChanges;
}
```

事件中的 `changes` 是副本，调用方不能污染内部缓存。

## 输入与职责链路

`UncommittedFilesWatcher` 不直接依赖 `RepoHeadBranchWatcher`，而是消费 `GitBranchesController` 已确认的 current HEAD：

```text
RepoHeadBranchWatcher
  → GitBranchesController.onEachRepoCurrentHeadBranchChanged
  → UncommittedFilesWatcher
```

`GitBranchesController` 是已选仓库有效分支集合的所有者，因此只有它确认后的 current HEAD 才会驱动工作区未提交状态。

## 缓存结构

缓存不拼接复合字符串 key，不使用 `\0` 分隔符。

```ts
Map<repositoryPath, Map<headHash, WorkingTreeChanges>>
Map<repositoryPath, Map<headHash, GitBranchOption>>
```

- 外层 key：`GitRepositoryOption.path`；
- 内层 key：完整 HEAD hash；
- 当前工作区只有一个 HEAD，因此自动刷新槽按 `repositoryPath` 管理；
- 历史 HEAD 的缓存可以保留给查询，但工作区文件事件只刷新该仓库当前 HEAD。

## 仓库工作区 watcher

每个受管当前仓库建立一个 watcher：

```ts
vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(repositoryRootUri, '**/*'),
);
```

监听 `onDidCreate`、`onDidChange`、`onDidDelete`。

### 路径过滤

文件事件按以下顺序处理：

1. 不是 `file` URI：忽略；
2. 相对仓库路径属于 `.git` 或 `.git/**`：忽略；
3. 使用 Git ignore 规则判断：

```text
git -C <repo> check-ignore --no-index -q -- <relativePath>
```

4. Git 返回 `0`：路径被忽略，不刷新；
5. Git 返回 `1`：路径未被忽略，请求刷新当前 HEAD；
6. 其他错误：记录错误并忽略该事件，避免在 ignore 判定失败时错误刷新。

使用 `git check-ignore` 而不是自行解析根目录 `.gitignore`，以保持与 Git 一致，覆盖嵌套 `.gitignore`、反向规则、`.git/info/exclude` 和全局 excludes。

## 高频文件事件合并

每个仓库维护独立刷新槽：

```ts
type RepositoryRefreshSlot = {
    branch?: GitBranchOption;
    generation: number;
    running: boolean;
    needsRefresh: boolean;
    completion?: Promise<void>;
};
```

行为如下：

```text
事件 A 到达
  → 当前仓库未读取
  → 立即刷新当前 HEAD 的 UncommittedFiles
  → running = true

事件 B 到达
  → A 仍在执行
  → needsRefresh = true
  → 不执行刷新

事件 C 到达
  → A 仍在执行且已标记 needsRefresh
  → 忽略

A 完成
  → needsRefresh 为 true
  → 清除 needsRefresh
  → 立即补读一次 UncommittedFiles

补读完成
  → running = false
  → needsRefresh = false
  → 结束
```

任意高频事件序列至多产生“当前读取 + 一次补读”。没有 timer、debounce、定期轮询或并发 Git status。

不同仓库使用不同刷新槽，互不影响。

## HEAD 切换安全性

同一仓库任意时刻只有一个 current HEAD，因此刷新槽只有一个 current branch。

HEAD 切换时：

1. 刷新槽替换为新的 `GitBranchOption`；
2. `generation` 递增；
3. 请求新 HEAD 的未提交状态刷新。

在旧 HEAD 下启动的 Git status 返回时，若其 generation 与当前刷新槽不一致，则直接废弃结果。旧 HEAD 的结果不能覆盖新 HEAD 的缓存或触发新 HEAD 事件。

## GitCommitController 接入

`GitCommitController` 消费 `onEachHeadBranchUncommittedFileChanged`：

- 只接收当前 selected current branch 的同仓库、同 HEAD hash 事件；
- 更新 `workingTree`、`hasUncommittedChanges`；
- 发布既有 `onWorkingTreeChangesChanged` 和 `onUncommittedPresenceChanged`。

它不再自行持有：

- `.git/index` watcher；
- 文档修改/保存 watcher；
- `checkWorkingTreePresence()` 请求；
- `getWorkingTreeChanges()` 工作区查询；
- presence generation / abort controller。

## Uncommitted Changes 虚拟提交接入

`Uncommitted Changes` 被点击时，`GitkViewProvider` 直接调用：

```ts
uncommittedFilesWatcher.getUncommittedFilesByHeadBranch(selectedBranch)
```

它只读取 watcher 缓存，不重新从本地执行 Git 状态查询。

当对应 current HEAD 的 `onEachHeadBranchUncommittedFileChanged` 到达时：

```text
UncommittedFilesWatcher
  → GitCommitController.onWorkingTreeChangesChanged
  → GitkViewProvider
  → 若虚拟提交正在选中，直接用事件快照更新 Changed Files
```

这样虚拟提交点击和后续文件变更都使用同一个 watcher 状态源。

## 生命周期

`UncommittedFilesWatcher` 由 `GitkViewProvider` 创建并加入 `context.subscriptions`。

`dispose()` 时：

1. 释放 `GitBranchesController` 订阅；
2. dispose 全部仓库工作区 watcher；
3. 清理仓库刷新槽；
4. 清理按仓库 / HEAD hash 组织的缓存；
5. dispose 事件 emitter。

## 验证

```text
npm run compile
```

并检查以下文件无 IDE diagnostics：

- `src/git/uncommittedFilesWatcher.ts`
- `src/git/gitBranchesController.ts`
- `src/git/gitCommitController.ts`
- `src/webview/gitkViewProvider.ts`
