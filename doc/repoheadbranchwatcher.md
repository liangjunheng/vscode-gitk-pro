# RepoHeadBranchWatcher 设计与接入

## 目标

`RepoHeadBranchWatcher` 负责全部主仓库与子模块的 HEAD 分支读取、真实 HEAD 文件监听和逐仓库变更通知。

它解决了此前 `GitkViewProvider` 通过全局 `**/.git/HEAD` watcher 与 100ms timer 延迟刷新时，无法准确表达“哪个仓库的 HEAD 已变更”的问题。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| `GitRepoController` | 扫描并发布全部仓库/子模块列表 |
| `RepoHeadBranchWatcher` | 管理每个仓库的 HEAD watcher，缓存和读取当前 HEAD，发布逐仓库变更 |
| `GitBranchesController` | 从 watcher 获取 current HEAD，并维护完整分支列表与已选分支 |
| `GitCommitController` | 订阅分支 HEAD 提交变化后刷新提交列表 |
| `GitkViewProvider` | 创建、释放控制器，不直接监听 HEAD 文件 |

## 对外接口

```ts
export class RepoHeadBranchWatcher implements vscode.Disposable {
    readonly onEachRepoHeadBranchChanged:
        vscode.Event<{
            repositoryPath: string;
            headBranch: GitBranchOption | undefined;
        }>;

    getHeadBranchByRepo(
        repository: GitRepositoryOption,
    ): Promise<GitBranchOption | undefined>;
}
```

### `onEachRepoHeadBranchChanged`

该事件按仓库逐条发布：

- `repositoryPath` 是 `GitRepositoryOption.path`。
- `headBranch` 是当前 HEAD 对应的 `GitBranchOption`。
- `headBranch` 为 `undefined` 表示该仓库没有有效 HEAD，例如空仓库，或仓库已从总列表移除。

### `getHeadBranchByRepo()`

- 已有缓存时直接返回缓存。
- 没有缓存时读取 Git HEAD、保存缓存后返回。
- 无有效 HEAD 时返回 `undefined`。

## GitBranchOption 语义

Watcher 不改变既有 `GitBranchOption` 语义，始终保留完整 commit hash。

| HEAD 状态 | `name` | `label` | `hash` | `kind` |
| --- | --- | --- | --- | --- |
| 正常分支 | `refs/heads/main` | `main` | 完整 hash | `current` |
| Detached HEAD | 完整 hash | hash 前 8 位 | 完整 hash | `current` |
| 空仓库 | 无对象 | 无对象 | 无对象 | 无对象 |

Detached HEAD 的构造复用 `buildDetachedHeadBranch()`，保持项目统一语义。

## 仓库列表同步

Watcher 唯一订阅：

```ts
repoController.ontotalRepoListChanged
```

构造后还会立即以 `repoController.totalRepoList` 发起同步，防止 watcher 晚于仓库扫描创建而漏掉已有仓库。

### 高频事件处理

`GitRepoController` 每次扫描完成都会发布完整仓库列表。HEAD watcher 使用单飞异步合并：

```text
列表 A 到达 → 开始同步 A
列表 B 到达 → A 未完成，只保存 B
列表 C 到达 → 用 C 覆盖 B
A 完成 → 仅同步最新 C
```

内部保留：

```ts
private syncingRepositories = false;
private pendingRepositories?: readonly GitRepositoryOption[];
```

这不使用 `setTimeout`、timer 或 debounce。处理中出现的中间全量快照不重复执行，但最终最新仓库列表必定会完成同步。

### watcher 生命周期

同步每份完整列表时按仓库规范化路径处理：

1. 已有 watcher、且仓库仍在新列表：忽略，不重建 watcher、不重新读取 HEAD。
2. 新增仓库：创建 watcher，并首次读取 HEAD。
3. 已删除仓库：释放 watcher，清理缓存，并发布该仓库 `headBranch: undefined`。

Windows 下索引路径采用大小写归一化，避免同一路径大小写差异产生重复 watcher；对外事件仍使用原始 `repository.path`。

## 真实 HEAD 文件监听

新增仓库时先执行：

```text
git -C <repo> rev-parse --absolute-git-dir
```

再监听真实 Git 目录的 `HEAD`：

```ts
vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(gitDir), 'HEAD'),
);
```

不能直接拼接 `<repo>/.git/HEAD`：子模块与 linked worktree 的 `.git` 可能是指向真实 git-dir 的文件。

`onDidCreate`、`onDidChange`、`onDidDelete` 都重新读取对应仓库的 HEAD。相同仓库的读取串行执行，以免先到事件的异步读取晚于后到事件写回过期结果。

## HEAD 读取

读取复用已有 Git 查询：

```ts
const [branchName, headHash] = await Promise.all([
    getCurrentGitBranch(rootUri),
    getCurrentGitHeadHash(rootUri),
]);
```

规则：

1. `branchName` 和 `headHash` 都存在：构造常规 `current` 分支。
2. 只有 `headHash` 存在：构造 detached HEAD 分支。
3. `headHash` 不存在：删除该仓库的 HEAD 缓存，结果为 `undefined`。

只有 `name` 或 `hash` 真正变化时才发布逐仓库事件；重复系统文件事件不会重复驱动下游刷新。

## GitBranchesController 接入

`GitBranchesController` 接收 `RepoHeadBranchWatcher`：

```ts
constructor(
    repoController: GitRepoController,
    repoHeadBranchWatcher: RepoHeadBranchWatcher,
)
```

它是 watcher 的消费方：

- 新选中仓库初始化 current branch 时，调用 `getHeadBranchByRepo()`。
- 读取完整 local/remote 分支列表时，以 watcher 返回的 current HEAD 替换列表中的 `kind === 'current'` 项。
- 订阅 `onEachRepoHeadBranchChanged`，只处理当前已选仓库。
- HEAD 变化后更新该仓库 current 分支、已选 current 分支，并发布 `onBranchHeadCommitChanged`。

`GitBranchesController` 不再自行调用 `getCurrentGitBranch()`、`getCurrentGitHeadHash()` 或自行构造 detached HEAD。

## 下游刷新链路

```text
真实 git-dir/HEAD 文件变化
  → RepoHeadBranchWatcher
  → onEachRepoHeadBranchChanged
  → GitBranchesController 更新 current branch
  → onBranchHeadCommitChanged
  → GitCommitController.forceRefresh()
```

## Provider 调整

`GitkViewProvider`：

- 创建 `RepoHeadBranchWatcher(this.repoController)`。
- 将 watcher 加入 `context.subscriptions`。
- 将 watcher 注入 `GitBranchesController`。
- 删除全局 `**/.git/HEAD` watcher。
- 删除 `headChangeDebounceTimer`、`queueHeadChangeRefresh()` 和 `refreshCurrentHeadBranch()`。

Provider 不再持有 HEAD 文件监听或 HEAD 延迟刷新职责。

## 验证

- TypeScript 编译：`npm run compile`。
- IDE diagnostics：`RepoHeadBranchWatcher`、`GitBranchesController`、`GitkViewProvider` 无 error/warning。
