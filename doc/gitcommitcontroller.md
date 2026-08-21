# GitCommitController 需求

## 0. 目标与边界

提交列表与提交内容的**唯一写入者**。

控制器管四件事：按分支选择读取提交、按关键字产出展示列表、维护工作区两行的显示开关、按需读取提交或工作区的 Diff 内容。它不涉及仓库发现、分支选择、分页，也不负责 Diff 的展示与编辑器交互。它订阅 `GitBranchesController.onSelectedBranchesChanged` 作为唯一的外部状态输入，对外只暴露状态与变更通知，不直接操作 Webview。

依赖链单向：仓库 → 分支 → 提交。控制器**不得**反向调用 `GitRepoController` 或 `GitBranchesController` 的任何方法。

## 1. 状态定义

| 字段                   | 含义                                         | 写入者                                   |
| ---------------------- | -------------------------------------------- | ---------------------------------------- |
| `selectedBranches`   | 用户已选分支（已消费的那一份）               | 仅`onSelectedBranchesChanged` 处理流程 |
| `totalCommitList`    | 建图后的完整提交列表（带`repositoryPath`） | 仅加载流程                               |
| `searchedCommitList` | 建图后的**展示列表**；UI 渲染的就是它  | 仅刷新流程（第 3 节）                    |
| `searchKeywords`     | 当前搜索关键字；空数组表示不过滤             | 仅`search()`                           |
| `selectedCommit`     | 当前选中提交对象；无选中时为`undefined`    | 仅用户操作与首次默认（第 6 节）          |
| `isLoading`          | 提交读取是否在途                             | 仅刷新流程，见第 4 节                    |

提交列表 UI 的 loading 生命周期比本字段更宽：仓库或分支选择会改变提交数据源，Provider 在选择 Intent 到达时先显示“正在获取当前仓库...”，随后以 `GitBranchesController.isLoading` 显示“正在获取当前分支...”。分支控制器可能在当前分支快路径中提前发布一次选择并触发可取消的提交预读，因此只要分支控制器仍在 loading，分支阶段就优先于 `GitCommitController.isLoading`；分支读取收尾后，再由提交控制器接管为“正在加载历史提交列表...”。新选择取消旧任务时，旧流程的 generation 门禁不会发布 false，阶段状态因此连续。

### searchedCommitList 是展示列表，不是「搜索态才有的东西」

UI 通过 `onSearchedCommitsChanged` 渲染，渲染的对象始终是 `searchedCommitList`。所以它在任何时刻都必须是有效的完整展示内容：

- `searchKeywords` 为空时，它是当前分支选择下的全部提交（不过滤）。
- `searchKeywords` 非空时，它是过滤后的结果。

它**不是**「只在搜索时才填充、平时为空」的字段。调用方不需要判断「现在该渲染哪个列表」—— 那个判断被消除了，永远渲染 `searchedCommitList`。

`totalCommitList` 是未过滤的完整列表，供需要全量数据的场景使用（例如统计、图形连线的上下文）。它不参与展示决策。

### selectedCommit 存提交对象

`selectedCommit` 的类型是 `CommitMetadata`，存的是提交元数据对象而非 Webview 展示标识。

与 `GitBranchesController.selectedBranches` 存 `GitBranchOption` 而非分支名同源：调用方拿到选中项后通常还要用它的 `subject` / `author` / `date` 渲染标题栏，只给标识会迫使调用方回列表里反查一次，而该提交可能已不在列表中（第 6 节规则 2 允许这种情况）。存对象则任何时候都能直接取到这些字段。

`CommitMetadata` 通过 `gitBranchOption.repoPath` 持有仓库归属，所以「多仓库下不同仓库存在相同 hash」的定位问题天然解决 —— 比较时必须 `hash` 与仓库路径都相等才算同一提交。

**代价是对象里的图形字段会过期。** `lane` / `laneColor` / `inputSwimlanes` 等由 `buildGraph` 写入，随列表内容变化（见第 10 节）。列表刷新后 `selectedCommit` 里的这几个字段仍是旧布局的值。

因此有一条硬约束：**`selectedCommit` 的图形字段不可信，任何渲染都不得读取它们**。需要布局信息时从当前 `searchedCommitList` 里按 `hash` + `repositoryPath` 查出对应项再取。`selectedCommit` 只用于提供提交本身的业务字段（hash、subject、author、date、parents）和作为「选中了哪个」的标识。

同理，判断相等时**只比 `hash` + `repositoryPath`**，不做全属性比较 —— 全属性比较会因图形字段差异把同一个提交判为不同。

### 当前分支的工作区变更开关

Changes / Staged Changes 两行不再挂在 `GitBranchOption.virtualCommits` 中。显示开关仍直接保存在 `GitBranchOption.hasChangeFiles` 与 `GitBranchOption.hasStagedChangeFiles`，由 `GitBranchesController` 读取工作区状态后整体替换 current 分支；提交区域按当前仓库和分支选择独立生成工作区变更行。

Diff 内容仍由第 8 节的 `getVirtualCommitContent` 按需读取。开关只回答「要不要显示」，不缓存内容。

非当前分支不在 map 中，查不到即视为两行都不显示。

### 状态机

```mermaid
stateDiagram-v2
    [*] --> Idle: 构造, 列表为空, selectedCommit 未定
    Idle --> Diffing: onSelectedBranchesChanged
    Diffing --> Idle: 与 selectedBranches 一致<br/>直接忽略 (规则 2)
    Diffing --> Loading: 内容不一致
    Idle --> Loading: search(keywords)<br/>关键字与当前不同
    Idle --> Idle: search(keywords)<br/>关键字相同则忽略
    Loading --> Idle: 刷新完成, 建图并通知<br/>isLoading = false
    Loading --> Loading: 再次收到事件或搜索<br/>直接丢弃 (规则 3)
```

## 2. 提交数据模型

### `CommitMetadata`

`CommitMetadata` 表示提交列表中的提交元数据，包含 hash、作者、时间、message、refs 以及提交图泳道字段。

### `GitCommitOption`

`GitCommitOption` 是扩展端非 Webview 阶段的提交聚合对象，持有 `CommitMetadata`、`CommitFile[]` 和 `DiffPayload[]`。`CommitMetadata`、`CommitFile` 与 `DiffPayload` 均提供 `equals()` 值语义比较，`GitCommitOption.equals()` 会比较三部分数据。发送到 Webview 时只发送可序列化的展示数据，不依赖 class 原型方法。

## 2. 输入契约与去重

有三个触发刷新的入口：

1. 内部监听 `GitRepoController.onSelectedRepoListChanged` —— 更新仓库数据源、取消旧提交读取，并等待分支回调。
2. 内部监听 `GitBranchesController.onSelectedBranchesChanged` —— 分支或所属仓库数据源变化时读取提交。
3. `search(keywords)` —— 关键字变化。
4. Provider 监听 `GitBranchesController.onBranchHeadCommitChanged` —— 分支名未变但 HEAD hash 变化时调用提交控制器 `forceRefresh()`；事件仅表示变化事实，不携带或维护 map。

前两个入口做内容去重，**内容与当前一致则整个调用返回**，不改状态、不发通知、不发起 IO。`forceRefresh()` 明确跳过分支名去重，因为它要处理的正是「name 集合相同、commit hash 已变」的情况；它不改 `selectedBranches` 与 `searchKeywords`，按现有状态重读两个提交列表和虚拟提交开关。

若 HEAD 事件到达时已有提交读取在途，不能直接丢弃，否则 watcher 可能不再产生第二次事件。控制器只记一个 `pendingForceRefresh` 布尔，当前读取在 `finally` 收尾后补跑一次；多次 HEAD 事件合并为一次刷新即可，因为读取目标始终是最新 Git 状态。

分支比较按 `name` 集合，且忽略顺序：

- 不能比数组引用 —— 上游每次 fire 的都是新数组（`this.selected.map(entry => entry.branch)`）。
- 不能比全属性 —— current 分支的变更标记会变化，但提交列表不该因此重载。
- 不能依赖顺序 —— 上游按仓库遍历顺序构建，用户多选顺序不稳定。

关键字比较按数组逐项，空数组与空数组视为一致。

去重是必需的，不是优化。`GitBranchesController` 在一次仓库切换中可能 fire 两次：快路径写入当前分支时一次，全量分支落地后默认选中项跟随更新时一次。若不去重，切一次仓库会触发两轮读取。

## 3. 刷新流程

分支变化与关键字变化走**同一条刷新流程**，只是入口不同：

1. 同步置 `isLoading = true`（必须在任何 await 之前，见第 4 节）。
2. 同步替换变化的那一项（`selectedBranches` 或 `searchKeywords`）。
3. 读取提交：refs 取 `selectedBranches` 的 `name` 数组。
   - `searchKeywords` 为空：`getGitCommits(rootUri, limit, refs, 0)`。
   - `searchKeywords` 非空：`searchCommits(rootUri, keywords, refs)`。
4. 建图，整体替换 `searchedCommitList`，fire `onSearchedCommitsChanged`。
5. 分支变化时同步刷新 `totalCommitList`（见下），fire `onTotalCommitsChanged`。
6. 按第 6 节处理 `selectedCommit`（**仅首次赋值，其余情况不动**）。
7. `isLoading = false`（`finally`）。

第 3 步走同一条流程而非两套逻辑，是因为「不过滤」只是「过滤条件为空」的特例。两套逻辑会各自维护一份「怎么建图、怎么替换、怎么收敛」，迟早分叉。

第 5 步的 `totalCommitList` 只在分支变化时才需要重读 —— 关键字变化不影响未过滤的全量列表。关键字变化时它保持原样，也不 fire `onTotalCommitsChanged`。

工作区变更开关属于 `GitBranchesController` 的 current 分支对象。提交控制器不读取工作区 presence、不持有虚拟事件，也不依赖分支控制器；Provider 通过普通 `onTotalBranchesListChanged` 快照渲染工作区虚拟行。

`getWorkingTreeChangePresence` 只跑一次 `git status --porcelain`，不读 Diff 元数据，代价远低于列表读取，可以并入同一条流程而不必单独设门禁。

第 4 步是**整体替换**，不是「先清空再填充」。任何「先清空 → await IO → 再填充」的写法，中间态存在多久 UI 就空多久。

第 8 步必须在 `finally` 里执行。异常路径若不置回，控制器会永久拒绝后续请求（规则 3 会把一切都丢弃）。

```mermaid
sequenceDiagram
    autonumber
    participant Br as GitBranchesController
    participant UI as Webview
    participant Ctrl as GitCommitController
    participant Git as gitLogProvider

    alt 分支变化
        Br-->>Ctrl: onSelectedBranchesChanged(branches)
        Ctrl->>Ctrl: name 集合与 selectedBranches 比较
    else 关键字变化
        UI-->>Ctrl: search(keywords)
        Ctrl->>Ctrl: 与 searchKeywords 比较
    end

    alt 分支与仓库数据源变化
        Ctrl->>Ctrl: abort 旧提交读取<br/>创建新 AbortController + generation
    else isLoading 为 true
        Ctrl->>Ctrl: 搜索返回当前结果<br/>forceRefresh 记账补跑
    else 内容一致
        Ctrl->>Ctrl: 直接返回, 无状态变化无 IO
    else 需要刷新
        Ctrl->>Ctrl: isLoading = true (任何 await 之前)<br/>替换变化的那一项
        Ctrl-->>UI: onCommitsLoadingChanged(true)
        alt 关键字为空
            Ctrl->>Git: getGitCommits(rootUri, limit, refs, 0)
        else 关键字非空
            Ctrl->>Git: searchCommits(rootUri, keywords, refs)
        end
        Git-->>Ctrl: 提交数据
        Ctrl->>Ctrl: buildGraph + 整体替换 searchedCommitList
        Ctrl-->>UI: onSearchedCommitsChanged
        opt 分支变化时
            Ctrl->>Ctrl: 刷新 totalCommitList
            Ctrl-->>UI: onTotalCommitsChanged
        end
        Ctrl->>Ctrl: selectedCommit 仅在未定时取首条<br/>无独立事件, 随 onSearchedCommitsChanged 一并可读
        Ctrl->>Ctrl: isLoading = false (finally)
        Ctrl-->>UI: onCommitsLoadingChanged(false)
    end
```

## 4. 并发控制：新分支选择取消旧提交读取

`selectBranches` 收到与当前数据源不同的分支或仓库集合时，先调用内部 `AbortController.abort()` 取消正在执行的提交列表读取，再立即按新 refs 和新仓库启动读取。分支名集合和仓库 path 集合都一致时才直接返回；仅比较分支名会把不同仓库中的同名分支误判为同一数据源。

每轮 `refresh` 创建独立的 `AbortController` 和递增 `generation`，取消信号透传 `getGitCommits` / `searchCommits`。每个 await 后先校验 `signal.aborted` 和 generation，再整体替换 `searchedCommitList` 或 `totalCommitList`。旧流程的 `finally` 也必须校验 generation，禁止关闭新流程的 loading 或清空新流程的控制器。

搜索和 `forceRefresh` 仍共用 `isLoading` 门禁：它们不会改变分支数据源，因此在途时搜索返回当前结果，`forceRefresh` 记入 `pendingForceRefresh` 并在当前有效流程收尾后补跑。控制器不接受外部 `AbortSignal`，取消权只属于新的分支选择和自身 dispose。

`getCommitContent` 与 `getVirtualCommitContent` **都不受 `isLoading` 限制**也不置位：它们不写任何控制器状态（见第 7、8 节），与列表读取无竞争关系。若受门禁限制，用户在列表加载期间点提交就什么也看不到。

```mermaid
flowchart TD
    A[收到请求] --> B{是内容读取?}
    B -->|是| C[直接执行, 纯查询<br/>不受 isLoading 限制]
    B -->|否| D{isLoading?}
    D -->|true| E[直接丢弃, 不排队]
    D -->|false| F{内容与当前一致?}
    F -->|是| G[直接返回, 无 IO]
    F -->|否| H[同步置 isLoading = true]
    H --> I[读取, 建图, 替换 searchedCommitList]
    I --> J{selectedCommit 未定?}
    J -->|是| K[取首条并 fire]
    J -->|否| L[不动]
    K --> M[finally: isLoading = false]
    L --> M
```

丢弃带来的取舍：被丢弃的那次请求不会得到对应的列表。分支变化的场景可接受 —— 分支选择变化必然伴随 `GitBranchesController` 的后续事件（全量分支落地时的收敛），届时比较会发现不一致并重新读取。**关键字变化的场景需要留意**：用户连续输入时若前一次读取未完成，后续输入会被丢弃，列表停在旧关键字的结果上。缓解手段是在调用方做输入防抖，而不是在控制器里排队 —— 排队意味着要处理「排队中又来新请求」的合并，复杂度远高于防抖。

## 5. 不碰分支选择

**控制器只读分支选择，绝不写。**

`selectedBranches` 只在 `onSelectedBranchesChanged` 入口整体替换，用途仅限「决定是否刷新」和「取 refs」。任何情况下都不得改动它，也不得诱导上游改选择。

具体禁止项：

1. 不得因「该分支没有提交」而改选或清空 `selectedBranches`。
2. 不得因读取失败而回退到其他分支。
3. 不得因搜索无结果而改动分支选择。
4. 不得调用 `GitBranchesController.selectBranches`。
5. 不得在列表为空时替用户挑一个分支重试。

读取失败或结果为空时，正确做法是保留 `selectedBranches` 原样，把空列表或错误状态如实反映出去。

## 6. 选中提交：仅首次默认，刷新时不动

这是本节的全部规则，只有两条：

1. **首次加载时**（`selectedCommit === undefined`），默认取 `searchedCommitList` 的第一条。
2. **刷新 `searchedCommitList` 时不得修改 `selectedCommit`**，即使该提交已不在新列表中。

第 2 条是明确的设计取舍，不是遗漏。理由：列表刷新（换分支、改关键字）是用户在调整「看哪些提交」，而选中提交是用户在看「哪一个提交的内容」，两件事互不隶属。刷新时改动选中项会导致用户正在阅读的 Diff 内容被无声换掉。

由此产生的后果要正视：`selectedCommit` 可能指向一个不在当前展示列表中的提交。这是允许的 ——

- `getCommitContent` 是对 git 的直接查询（第 7 节），不依赖提交是否在列表里，内容照常能读出来。
- UI 侧「高亮选中行」会找不到对应行，表现为没有高亮。这是正确的：那个提交确实不在当前视图中。

因此**不存在「回退首条」的收敛规则**。`selectedCommit` 只有三个变化来源：首次默认赋值、用户调 `selectCommit`、以及列表由空变非空时的首次赋值（本质仍是第 1 条 —— 此前 `selectedCommit` 为 `undefined`）。

`selectCommit(commit)` 是用户操作入口，唯一允许主动改 `selectedCommit` 的公开方法，入参是 `CommitMetadata` 对象。一道校验：与当前选择的 `hash` + `repositoryPath` 相同则返回 `false` 不触发通知，避免重复点击引发无意义的内容重载。

**不校验「该提交是否在列表中」** —— 既然第 2 条允许 `selectedCommit` 指向列表外的提交，入口就没有理由拒绝这类值。工作区虚拟提交的约定 hash 也因此天然可用。

入参收对象而非标识，除了与 `selectedBranches` 保持一致，还有一个实际作用：既然不做存在性校验，控制器无法自己把标识补全成对象（列表里可能查不到），只能要求调用方直接给。

```mermaid
flowchart TD
    A[searchedCommitList 刷新完成] --> B{selectedCommit === undefined?}
    B -->|是| C{新列表非空?}
    B -->|否| D[保持不变, 不 fire<br/>即使已不在新列表中]
    C -->|是| E[取首条<br/>随 onSearchedCommitsChanged 一并可读]
    C -->|否| F[保持 undefined]
```

## 7. 提交内容读取

`getCommitContent(hash, repositoryPath)` 返回该提交的 `DiffPayload[]`。

**它是纯查询：不写任何控制器状态，不发任何事件。** 这是它能豁免 `isLoading` 门禁的前提（第 4 节），也是它与列表读取的根本区别 —— 列表读取改变控制器状态，内容读取只是把数据取回来交给调用方。

流程：

1. `getCommitFiles(rootUri, hash)` 取变更文件元数据（`CommitFile[]`）。
2. 逐文件读取 `original` / `modified` 正文，组装成 `DiffPayload[]`。
3. 返回结果，调用方自行决定怎么用。

`DiffPayload extends CommitFile`，额外带 `index`（用于恢复并发读取后的文件顺序）、`fullPath`、`original`、`modified`、`error`。

三条约束：

1. **不复用 `DiffReader.prepare`。** 该方法把结果直接 `store.setState({ files, diffLoading })` 写进 Store，还依赖 `store.getState().diffGeneration` 做代次判断。控制器复用它等于通过 Store 产生副作用，违背「纯查询」。需要的是 `readDiffs` 那一层的能力 —— 组装 `DiffPayload[]` 并返回。
2. **必须持有独立的 `DiffReader` 实例，不与调用方共用。** `stop()` 会推进实例内部的 `requestGeneration` 并 `kill` 全部 `git cat-file` 子进程。共用一个实例时，调用方任何一次 `stop()`（切换提交、关闭面板都会触发）都会连坐中止控制器正在进行的纯查询，读取会以异常收场。
3. **不做进度上报。** 进度是展示需求，属调用方。控制器只在全部读完后一次性返回。
4. **单文件读取失败不抛异常**，写入该条 `DiffPayload.error` 字段并继续。整个提交读不到（如 hash 不存在）才抛。

工作区虚拟提交（Changes / Staged Changes）**不走这个方法**，因为它比对的是索引与工作区而非两个 commit，`hash` 参数对它没有意义。这类内容由下一节的 `getVirtualCommitContent` 负责。两个方法分开而不用 `ChangeSetMode` 在一个方法里分流，是为了避免调用方传一个假 hash 再靠 mode 参数覆盖它 —— 那样签名会同时存在两个互斥的入参。

## 8. 工作区内容读取

`getVirtualCommitContent(mode, repositoryPath)` 返回 Changes 或 Staged Changes 的 `DiffPayload[]`，`mode` 取 `'changes' | 'staged'`。

与 `getCommitContent` 同为**纯查询**：不写任何控制器状态，不发任何事件，不受 `isLoading` 门禁限制。

**每次调用都从本地重新读取，不做任何缓存。** 工作区与索引的内容随时在变（编辑、保存、`git add`、外部工具改动都会影响），任何缓存都无法确定失效时机。`hasChangeFiles` 与 `hasStagedChangeFiles` 只存显示开关，不存内容；内容仍按需读取。

`hasChangeFiles` / `hasStagedChangeFiles` 为 `false` 时调用方本不该展示或调用它。但控制器**不据此拒绝** —— 开关是上一次分支刷新时的快照，此刻工作区可能已有新变更；直接读取并返回真实结果（可能是空数组）比按过期开关拒绝更正确。

流程：

1. `getWorkingTreeChangeFiles(rootUri, mode)` 仅取当前模式的文件元数据：`staged` 只读 cached raw diff；`changes` 只读普通 raw diff，并补充未跟踪文件。
2. 逐文件读取两侧正文，组装成 `DiffPayload[]`。

两侧正文的取法与提交 Diff 不同，这是本方法存在的根本原因：

- `mode === 'staged'`：original 取 HEAD 版本，modified 取索引版本。
- `mode === 'changes'`：original 取索引版本，modified 取磁盘上的工作区文件。

读磁盘文件这一路不经过 git，是 `getCommitContent` 完全没有的分支。

约束与 `getCommitContent` 一致：不复用 `DiffReader.prepare`（它写 Store）、不做进度上报、单文件失败写入该条 `DiffPayload.error` 并继续。

## 9. 对外接口

```ts
interface GitCommitController {
    /** 用户已选分支（只读副本） */
    readonly selectedBranches: readonly GitBranchOption[];
    /** 建图后的完整提交列表；不参与展示决策 */
    readonly totalCommitList: readonly GitCommitOption[];
    /** 建图后的展示列表；UI 渲染的就是它 */
    readonly searchedCommitList: readonly GitCommitOption[];
    /** 当前搜索关键字；空数组表示不过滤 */
    readonly searchKeywords: readonly string[];
    /** 当前选中提交对象；无选中时为 undefined。图形字段可能过期，不可用于渲染布局 */
    readonly selectedCommit: GitCommitOption | undefined;
    /** 提交读取是否在途 */
    readonly isLoading: boolean;

    /** HEAD hash 变化后的强制刷新；不改分支选择，在途时合并为一次补跑 */
    forceRefresh(): void;
    /** 搜索入口；空数组表示不过滤 */
    search(keywords: readonly string[]): Promise<GitCommitOption[]>;
    /** 用户操作入口，唯一允许主动改 selectedCommit 的公开方法；返回是否被接受 */
    selectCommit(commit: GitCommitOption): boolean;
    /** 纯查询：读取某提交的 Diff 内容，不改任何状态不发事件 */
    getCommitContent(hash: string, repositoryPath: string): Promise<DiffPayload[]>;
    /** 纯查询：读取工作区 Changes / Staged 内容，每次都重新读取不缓存 */
    getVirtualCommitContent(mode: 'changes' | 'staged', repositoryPath: string): Promise<GitCommitOption>;

    onSearchedCommitsChanged: Event<GitCommitOption[]>;
    onTotalCommitsChanged: Event<GitCommitOption[]>;
    onSelectedCommitChanged: Event<GitCommitOption | undefined>;
    onCommitsLoadingChanged: Event<boolean>;
}
```

`onSearchedCommitsChanged` 是 UI 的主要订阅点。`onSelectedCommitChanged` 是提交区域选中状态的唯一事件源；提交控制器构造时接收 `GitRepoController` 与 `GitBranchesController`，仅内部监听它们的已选仓库/分支回调来维护提交数据源；`onTotalCommitsChanged` 仍只在分支变化时 fire。

`getCommitContent` 与 `getVirtualCommitContent` 是唯一返回数据而非改状态的两个方法。它们不发事件，因为没有状态变化可通知 —— 调用方 `await` 到返回值就是全部结果。

`selectCommit` 是唯一允许主动修改 `selectedCommit` 的公开入口。Provider 在用户点击普通或虚拟提交行时都先构造/定位 `CommitMetadata`，再调用该方法；相同业务键直接返回 false。方法接受选择后先同步 fire `onCommitsLoadingChanged(true)`，再修改 `selectedCommit` 并立即 fire `onSelectedCommitChanged`，最后 fire `onCommitsLoadingChanged(false)`。调用方据此更新提交区域选中状态并启动内容读取。提交列表刷新、搜索、仓库/分支选择、HEAD 变化均不得自动调用 `selectCommit`；首次默认选中由控制器内部通过同一入口完成。

仓库与分支选择处理是 private：调用方不得调用或向提交控制器传入仓库快照。`GitRepoController.onSelectedRepoListChanged` 先更新内部仓库快照并取消旧读取，`GitBranchesController.onSelectedBranchesChanged` 再以分支集合触发读取。`search` 只接收关键字，并使用内部仓库快照构造 `rootUri`。

接口只暴露被真正使用的成员。分页不在本轮范围，需要时再加。

## 10. 与调用方的职责划分

控制器负责提交读取、过滤、内容查询；调用方负责监听事件把状态推给 Webview，以及把内容读取的结果送去渲染。

控制器**不得**直接 `postMessage`，不得写 Store，不得调用 Diff 编辑器相关方法。反过来，调用方**不得**回写任何控制器状态，只能读。

```mermaid
flowchart LR
    subgraph Br[GitBranchesController]
        B1[selectedBranches 所有权]
    end

    subgraph Ctrl[GitCommitController]
        S1[selectedBranches 只读副本]
        S2[totalCommitList]
        S3[searchedCommitList]
        S4[searchKeywords]
        S5[selectedCommit]
        S6[isLoading]
    end

    subgraph Caller[GitkViewProvider]
        P1[监听 onSearchedCommitsChanged<br/>渲染展示列表]
        P2[点选后调 getCommitContent<br/>或 getVirtualCommitContent]
        P3[搜索框防抖后调 search]
        P4[监听 onTotalBranchesListChanged<br/>按 current 分支标记决定工作区行]
    end

    Repo[GitRepoController] -->|onSelectedRepoListChanged| Ctrl
    Br -->|onSelectedBranchesChanged| Ctrl
    UI[Webview] -->|selectCommit| Ctrl
    P3 --> Ctrl
    Ctrl -->|onSearchedCommitsChanged| P1
    Br -->|onTotalBranchesListChanged| P4
    Ctrl -->|onCommitsLoadingChanged| P1
    P1 --> UI
    P4 --> UI
    P2 -->|DiffPayload 数组| UI
    Ctrl -.->|禁止反向调用| Br
    Caller -.->|只读, 禁止回写| Ctrl
    Ctrl -.->|禁止 postMessage / 禁止写 Store| UI
```

**内容读取由调用方主动发起，不由控制器内部串联。** 控制器改动 `selectedCommit` 后绝不自己调 `getCommitContent` 再把结果推出去 —— 那会把「谁需要内容、什么时候需要」的决定权收进控制器。调用方在用户点选后自行决定取哪种内容：普通提交走 `getCommitContent`，Changes / Staged 两行走 `getVirtualCommitContent`。

**「点的是哪一行」的判断在调用方。** 控制器不提供「这个 hash 是不是虚拟提交」的辅助方法 —— 虚拟提交的约定 hash 是展示层的协议，控制器只按调用的方法名区分要读什么。

**搜索防抖在调用方。** 搜索不会取消正在执行的提交读取；加载在途时返回当前结果，因此快速连续的关键字变化仍可能不立即落地。防抖是展示层的输入处理，放进控制器等于让它承担 UI 节奏。分支选择不同：它改变提交数据源，必须取消旧读取并优先执行最新选择。

## 11. buildGraph 的所有权与既有约束

`buildGraph` 已从 `gitLogProvider` 移入 `GitCommitController`，作为控制器私有方法。`gitLogProvider` 只负责读取原始 `CommitMetadata[]`，不再导出或持有图形布局算法；这样提交数据的读取、建图和列表整体替换由同一所有者完成。

`buildGraph` 原地改写入参的 `lane` / `laneColor` / `laneStartsHere` / `inputSwimlanes` / `outputSwimlanes` 五个字段并返回同一数组。

两个列表都各自建图。**不得让两个列表共享提交对象** —— 尤其不能拿 `totalCommitList` 过滤出 `searchedCommitList` 再建图，那会改写 `totalCommitList` 里对象的 lane，全量列表的布局被展示列表污染。

`searchedCommitList` 的读取来源为：关键字非空时调用 `searchCommits`，关键字为空时调用 `getGitCommits`。分支变化且关键字为空时，`searchedCommitList` 已经是本轮完整提交结果，`totalCommitList` 应通过逐对象复制得到，禁止再次执行相同的 `git log`。

两个字段仍不得共享对象引用：正确写法是 `this.total = this.searched.map(commit => ({ ...commit }))`，而不是 `this.total = this.searched`。图形字段中的泳道数组可共享只读快照，因为本轮 `buildGraph` 已结束，后续刷新会整体替换列表而不会原地重建旧对象。关键字非空时两份列表内容不同，才需要独立读取无过滤的全量列表。

这也解释了第 1 节为什么规定「`selectedCommit` 的图形字段不可信」：图形字段属于「这一次布局的结果」，不是提交本身的属性。`selectedCommit` 持有的是某一帧的对象引用，那一帧的布局早已被后续刷新取代。

## 12. 验收场景

| 场景                                        | 期望                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| 首次分支选择落地，关键字为空                | `searchedCommitList` 为全部提交，`selectedCommit` 取其第一条      |
| 首次落地时列表为空                          | `selectedCommit` 保持 undefined                                     |
| 列表由空变非空                              | `selectedCommit` 取首条（此前为 undefined）                         |
| 分支快路径后全量落地再 fire 一次            | name 集合一致，直接忽略，无 IO 无 UI 抖动                             |
| current 分支变更标记更新后 fire             | name 集合一致，不重载                                                 |
| 上游 fire 的数组顺序与副本不同但集合相同    | 判定一致，不重载                                                      |
| 用户切换分支                                | `searchedCommitList` 与 `totalCommitList` 都刷新，两个事件都 fire |
| 用户改关键字                                | 只刷新`searchedCommitList`，不 fire `onTotalCommitsChanged`       |
| 用户输入相同关键字                          | 直接返回，无 IO 无通知                                                |
| 关键字由非空变空                            | `searchedCommitList` 恢复为全部提交（走 `getGitCommits`）         |
| **切换分支后已选提交不在新列表中**    | **`selectedCommit` 保持不变，不回退首条**                     |
| **改关键字后已选提交被过滤掉**        | **`selectedCommit` 保持不变，UI 无高亮但内容仍可读**          |
| 选中提交被 amend 掉后刷新                   | `selectedCommit` 保持不变（指向已消失的 hash 由调用方决定如何呈现） |
| 用户点选提交                                | `selectedCommit` 更新并 fire，返回 true                             |
| 重复点选同一提交                            | 返回 false，不 fire，不重复读取内容                                   |
| 点选列表外的提交（如虚拟提交）              | 接受，不做「是否在列表中」的校验                                      |
| 读取在途时收到分支变化或搜索                | 请求被丢弃，在途读取不受影响，`isLoading` 保持 true                 |
| 读取过程中抛异常                            | `isLoading` 仍置回 false，`selectedBranches` 保持不变             |
| 某分支无提交                                | 两个列表为空，`selectedBranches` **保持不变**                 |
| 读取失败                                    | 保留`selectedBranches` 原样，如实反映错误，不回退其他分支           |
| 搜索无结果                                  | `searchedCommitList` 为空，不改动分支选择与 `selectedCommit`      |
| 外部刷新被中止                              | 读取不受影响，仍能正常落地，`isLoading` 正确收敛                    |
| 多仓库下两个仓库有相同 hash                 | 按 hash + repositoryPath 精确定位，不互相错配                         |
| 列表刷新后读`selectedCommit.lane`         | 该值属旧布局，不可用于渲染；须回`searchedCommitList` 查当前项       |
| 判断某行是否为选中行                        | 只比 hash + repositoryPath，不做全属性比较（图形字段会有差异）        |
| 列表加载在途时调`getCommitContent`        | 正常返回内容，不被`isLoading` 拦住                                  |
| `getCommitContent` 中单文件读取失败       | 该条`DiffPayload.error` 有值，其余文件正常返回                      |
| `getCommitContent` 的 hash 不存在         | 抛异常，由调用方处理，控制器状态不变                                  |
| `getCommitContent` 调用前后               | 所有状态不变，无事件发出                                              |
| 切换分支后                                  | `GitBranchesController` 更新 current 分支的变更标记                 |
| 改关键字后                                  | 只更新提交展示列表，不触发工作区状态读取                              |
| HEAD hash 变化但已选分支 name 不变          | 分支控制器发无负载通知，Provider 调提交控制器`forceRefresh`         |
| HEAD 事件到达时提交读取在途                 | 置`pendingForceRefresh`，当前读取收尾后补跑一次                     |
| 多次 HEAD 事件在同一读取期间到达            | 合并成一次补跑，最终读取最新 Git 状态                                 |
| HEAD 未变化、只有普通分支列表变化           | 不触发`forceRefresh`                                                |
| HEAD 分支未勾选                             | 即使有变更标记，Provider 仍不显示 Changes / Staged 两行               |
| HEAD 分支已勾选                             | 按`hasChangeFiles` / `hasStagedChangeFiles` 显示虚拟提交          |
| 连续两次调`getVirtualCommitContent`       | 两次都重新读取本地，不返回缓存                                        |
| 开关为 false 时仍调用                       | 不拒绝，照常读取并返回真实结果（可能为空数组）                        |
| `getVirtualCommitContent('changes')`      | original 取索引版本，modified 取磁盘工作区文件                        |
| `getVirtualCommitContent('staged')`       | original 取 HEAD 版本，modified 取索引版本                            |
| 列表加载在途时调`getVirtualCommitContent` | 正常返回，不被`isLoading` 拦住                                      |
