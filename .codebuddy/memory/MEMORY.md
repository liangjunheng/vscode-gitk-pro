# 工作记忆

## 项目概况
- 项目：`vscode-gitk`，VS Code 扩展，在底部 Panel 提供 gitk 风格提交图、Changed Files 和 Multi-Diff。
- 技术栈：TypeScript、VS Code Extension API、Webview View；通过 VS Code Git 扩展 API 获取仓库、日志和差异，兼容桌面与 Web。
- 当前工作区：`c:\Users\JUNHENG.LIANG\OneDrive\vscode\vscode-gitk`。

## 核心结构与约定
- `src/extension.ts`：激活入口，注册视图 provider 和状态栏。
- `src/gitLogProvider.ts`：仓库、refs、提交、差异和提交图布局。
- `src/webview/gitkViewProvider.ts`：提交图面板 TS 逻辑。
- `src/commitFilesViewProvider.ts`：Changed Files 与 Multi-Diff 打开、选中同步。
- Webview 分层：面板类只保留 TS 控制逻辑；`xxxDocument.ts` 生成整页 HTML；子面板分别导出 `STYLES`、`MARKUP`、`SCRIPT`；拥有 DOM 的子面板负责监听，子面板之间不互相 import。
- Multi-Diff 使用 `vscode.commands.executeCommand('vscode.open', multiDiffSourceUri, { label, resources, multiDiffSource }, ViewColumn.Active)`；内部 scheme 为 `multi-diff-editor`；空侧由 `gitk-empty` provider 提供。

## 提交加载设计
- 初始化顺序：环境 → 仓库/子模块 → 分支 → 提交 → 内容。
- `getGitRefs` 使用 5 秒缓存；仓库与子模块扫描并行。
- 加载更多保持增量：`buildGraph(commits, state?, startIndex?)` 保存 lane 状态；预取 hash 后用 `git log --no-walk` 按批取提交，耗尽时才回退 `--skip`。
- Webview 进度条：`total=0` 为不定进度，`total>0` 显示比例和计数。

## 图标资产
- `media/gitk-logo.svg/.png`：256×256 彩色扩展图标。
- `media/gitk-sidebar.svg/.png`：24×24 单色 Panel 图标，由 `package.json` 的 `viewsContainers.panel` / `views` 使用。

## 环境与文件安全
- VS Code：`C:\Users\JUNHENG.LIANG\AppData\Local\Programs\Microsoft VS Code\Code.exe`；`code` 不在 PATH。
- 禁止用未显式指定 UTF-8 的 PowerShell 读写源码；无 BOM UTF-8 `.ps1` 也可能被 Windows PowerShell 按 ANSI 解码。源码编辑优先使用文件编辑工具。
- OneDrive 工作区发生过写入后静默回退；关键编辑后必须重新读取校验。
- `.codebuddy` 是项目数据，禁止删除。

## 用户规则
- 内容以中文输出；中文提问最后一句提示对应英文问法，英文提问最后一句先修正语法。
- 必须依据项目代码论证根因和解决方案。
- 忽略 `harness` 工程。
- 禁止防御性、兜底、延时或定时器式表层补丁；必须定位并解决状态所有权、事件时序或数据流根因。
- 不使用 emoji。
