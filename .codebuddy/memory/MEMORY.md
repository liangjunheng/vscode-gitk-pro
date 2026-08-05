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

### 环境
- VS Code 安装路径: C:\Users\JUNHENG.LIANG\AppData\Local\Programs\Microsoft VS Code\Code.exe
- code 命令不在 PATH 中
- OneDrive 占位文件可能阻塞读取 (vscode-filter-line 项目因 offline 属性无法读)

### 用户规则
- 必须用英语回答; 中文提问最后一句给英文写法提示, 英文提问先纠正语法
- 必需通过项目代码论证
- 内容以中文输出
- 忽略 harness 工程
