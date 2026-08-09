# 工作记忆

## 项目: vscode-gitk (c:\Users\JUNHENG.LIANG\OneDrive\vscode\vscode-gitk)

VS Code 扩展, 在活动栏提供 gitk 风格的提交图面板。

### 技术栈
- TypeScript + VS Code Extension API (桌面 + Web 双端)
- Webview View (viewsContainers/activitybar + views/webview)
- 不直接调用 git CLI, 通过 VS Code Git 扩展 API (vscode.git exports getAPI(1)) 获取提交历史和变更文件, 兼容 web
- repository.log() / repository.diffBetween(ref1, ref2) / git scheme URI

### 文件结构
- package.json: 扩展清单, main 指向 ./out/extension.js (移除 browser 字段避免桌面调试干扰); viewsContainers 改为 "panel" (底部面板区, 和 Terminal/Output 一起, 不是 activitybar); activationEvents: ["*"] (强制立即激活, 测试用)
- .vscode/launch.json: 官方模板 "Run Extension" (extensionHost, args=${workspaceFolder}, preLaunchTask=npm: watch)
- .vscode/tasks.json: 官方模板 (type=npm, script=watch, isBackground, $tsc-watch)
- .vscode/extensions.json + settings.json: 官方脚手架标配 (推荐 eslint)
- run.bat: 一键启动脚本 (双击即可), 调 Code.exe --extensionDevelopmentPath 启动 Extension Development Host, 不依赖 F5/launch.json
- src/extension.ts: 激活入口, activate 开头 console.log + showInformationMessage 诊断; 注册 2 个 provider + GitkStatusBar
- src/gitkViewProvider.ts: 上方 WebviewViewProvider, 渲染提交图, 行点击发送 selectCommit
- src/commitFilesViewProvider.ts: 下方 WebviewViewProvider, 显示变更文件 tree/flat 切换, 点击文件打开 Multi-Diff Editor (vscode.open + IResourceMultiDiffEditorInput), onDidChangeActiveTextEditor + onDidChangeVisibleTextEditors 同步高亮, diff 关闭时清除高亮
- src/gitLogProvider.ts: 通过 vscode.git API 获取 log/diffBetween, buildGraph 图形布局, buildGitFileUri 构造 git scheme URI (格式: git://<path>?{"path":"<fsPath>","ref":"<ref>"})
- src/diffContentProvider.ts: GitkDiffContentProvider 实现 TextDocumentContentProvider, scheme=vscode-gitk-diff (旧方案, 已不用于 openDiff)
- src/statusBar.ts: GitkStatusBar 常驻版, 构造函数里直接 show(), 不判断 git 仓库
- media/gitk-logo.png: 自生成 git 分支图 logo (256x256), 用于 panel 容器图标

### VS Code Multi-Diff Editor 正确打开方式 (2026-08-05 确认)
- VS Code 源码 src/vs/workbench/contrib/multiDiffEditor 无 `vscode.openMultiDiffEditor` 命令
- MultiDiffEditorInput.ID = `workbench.input.multiDiffEditor`, 内部 URI scheme = `multi-diff-editor`
- 打开方式: `vscode.commands.executeCommand('vscode.open', multiDiffSourceUri, {label, resources, multiDiffSource}, ViewColumn.Active)`
  - multiDiffSource: `vscode.Uri.parse('multi-diff-editor:gitk-<hash>')`
  - resources: Array<{original: Uri|undefined, modified: Uri|undefined}>
  - VS Code editorService 识别 untyped input 的 resources 字段, 经 MultiDiffEditorResolverContribution 解析
- Added/Deleted 文件空侧: 注册 `gitk-empty` scheme TextDocumentContentProvider 返回空字符串

### 加载进度条 (2026-08-07)
- gitkViewProvider.ts webview `loadingProgress` 消息携带 {phase, message, current, total}
- phase: 'repository' | 'branch' | 'commit' | 'start'
- gitLogProvider.ts:
  - getGitRepositories(onProgress) 报告工作区文件夹解析 (git rev-parse) + 子模块扫描 (git config) 进度, total 随子模块发现增长
  - resolveCommitRefs(rootUri, refs) 批量单次 git rev-parse, 正则过滤有效哈希, 部分失败从 error.stdout 提取
  - getGitCommits(rootUri, limit, refs, skip, onProgress) 报告 resolveCommitRefs + git log 进度, total = 2 (1 resolve + 1 log)
  - getGitRefs 5s TTL 缓存, 避免 refreshSelectors + getGitCommits 重复调用
  - getGitRepositories 工作区文件夹解析 + 子模块扫描均改 Promise.all 并行
  - GitRepositoryOption 新增 hasSubmodules 字段; getGitRepositoriesInternal 遍历 allRepositories 的 parentPath 构建 parentPaths 集合判定
  - 初始化流程严格顺序: 初始化环境→初始化仓库→加载子模块→加载分支→加载提交→刷新内容
  - 仓库图标按 hasSubmodules 区分: 有子模块=文件夹+内嵌矩形(绿色), 无子模块=纯文件夹图标
  - Changed Files 标题栏的全部动作图标已重绘为统一 16px / 1.5px 圆角线框 SVG；标题栏按钮使用 24px VS Code 风格 hover、active、focus 状态，树状/平铺切换路径同步更新
  - 已选 commit 的折叠/展开属于 Webview 本地状态：setupRow 仅在 !wasSelected 时发送 selectCommit，避免重复执行 setCommitFiles 和刷新 Changed Files
  - Changed Files 标题左侧布局固定为：文案 → 8 位 commit id（changes/staged 时隐藏）→ Copy Hash；其余提交/分支操作保持右对齐，短哈希由 updateFilesCommitHash() 在选择、点击和加载清空时同步
  - 加载更多提交须保持增量渲染：appendRows 只扫描新增批次更新 columnWidthChars/列宽；仅当新增 lane 或 refs 扩宽图区域时回退全量 render
  - buildGraph(commits, state?, startIndex?) 增量构建, GraphState 保存 activeLanes + nextColor
  - loadMoreCommits 用增量构建, 只处理新提交 (prevCount 起始), O(N²)→O(N)
  - 跳过 resolveCommitRefs, refs 直接传 git log
  - getCommitHashes(rootUri, refs) 预取全量 hash (git rev-list), 与首次 git log 并行
  - getGitCommitsByHashes(rootUri, hashes) 用 git log --no-walk, O(101) 无遍历
  - loadMoreCommits 优先用预取 hash + getGitCommitsByHashes, 耗尽回退 git log --skip
- gitkViewProvider.ts:
  - refreshInternal 严格顺序: 初始化环境→refreshSelectors(初始化仓库+加载子模块+加载分支)→加载提交→刷新内容
  - refreshSelectors 传 onProgress 给 getGitRepositories; 分支 0/1→1/1
  - refreshInternal 单仓库时透传 getGitCommits 的 onProgress; 多仓库时按 rootUris.length 逐个完成计数
  - refreshBranchCommits 传 onProgress 给 getGitCommits
  - 双重加载修复: refresh()/refreshInternal() 加 skipSelectors 参数, refreshWithRetry 用 retryCount===0 判断首次
- webview 单条进度条始终可见:
  - total=0: indeterminate 动画 (translateX -150%→350%, 30% 宽蓝色条)
  - total>0: 比例填充 (current/total*100%) + "current / total" 文字
  - showLoadingProgress(phase, message, current, total) 切换 indeterminate/比例两种态

### 环境
- VS Code 安装路径: C:\Users\JUNHENG.LIANG\AppData\Local\Programs\Microsoft VS Code\Code.exe
- code 命令不在 PATH 中
- OneDrive 占位文件可能阻塞读取 (vscode-filter-line 项目因 offline 属性无法读)

### 用户规则
- 必须用英语回答; 中文提问最后一句给英文写法提示, 英文提问先纠正语法
- 必需通过项目代码论证
- 内容以中文输出
- 忽略 harness 工程
