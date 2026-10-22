<div align="center">
  <img src="media/fastergit-logo.png" width="128" height="128" alt="FasterGit 图标">

# FasterGit

**在 VS Code 底部面板中浏览 Git 历史、审查多文件差异、管理多仓库变更。**

提交图、分支管理、多仓库提交和合并冲突处理集中在同一个面板里，本地仓库读写由内置 libgit2 原生模块完成。

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/liangjunheng.fastergit?label=Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=liangjunheng.fastergit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.94.0-007ACC.svg)](https://code.visualstudio.com/)

</div>

## 项目简介

FasterGit 在 VS Code 底部面板中绘制彩色泳道提交图，并把历史浏览、变更文件列表和多文件差异编辑器联动起来。插件会发现当前工作区中的仓库及已初始化子模块，在同一界面里完成日常 Git 操作，不需要在终端和多个视图之间来回切换。

本地仓库的发现、历史读取和写入由随扩展分发的 libgit2 原生模块完成。Fetch、Pull、Push、子模块更新以及继续或中止合并操作会调用系统 Git CLI，以复用你已有的凭据和网络配置。插件面向桌面版 VS Code 设计。

## 主要功能

### 提交图

- 使用彩色泳道显示提交拓扑、合并路径、引用、作者、日期和短哈希。
- 在工作区仓库与已初始化子模块之间切换。
- 同时选择一个或多个本地或远程分支，查看组合后的提交历史。
- 按哈希、父提交哈希、作者、邮箱、提交者、日期、标题、正文或引用名称搜索提交，多个关键词用空格分隔。
- 展开提交，查看完整提交信息和元数据。
- 提交图刷新时保持当前可见提交的位置稳定。

### 变更文件与 Multi-Diff

- 在一个 Multi-Diff 编辑器中查看某次提交涉及的全部文件，支持双栏和单栏两种显示。
- 在平铺列表与目录树之间切换 Changed Files 的显示方式。
- 在整个 Multi-Diff 中搜索，使用 `F7`、`Shift+F7` 或编辑器标题栏按钮在差异之间导航。
- 文件右键菜单支持打开文件、打开修改前或修改后的版本、在文件管理器或资源管理器视图中显示，以及复制文件路径。
- 子模块指针（Gitlink）的变更会展示为可跳转到子模块提交的卡片。

### 工作区变更与 Commit Panel

- 通过虚拟的 **Uncommitted Changes** 提交查看合并冲突、已暂存、未暂存和未跟踪文件。
- 对单个文件或整个分区执行暂存、取消暂存和放弃更改；放弃未跟踪文件时默认移入回收站。
- 打开 Commit Panel，在一个编辑器页面里按仓库卡片分别编写提交信息、管理 Staged 与 Unstaged 列表。
- 提交已暂存内容，或通过内置 `COMMIT_EDITMSG` 编辑流程执行 Amend，并可从历史提交信息中选取。
- 使用 `Ctrl+Enter` / `Cmd+Enter` 完成提交，使用 `Escape` 取消提交。

### 历史与仓库操作

- 对选中的仓库执行 Fetch、Pull 和 Push。
- 在提交上右键，执行 Checkout、Revert、Drop、Cherry-pick、Merge、Rebase 或 Reset，也可以基于该提交创建分支或添加标签。
- 在选中仓库的根目录打开终端。
- 通过文件系统监听同步仓库、HEAD、Index 和工作区状态。

### 合并冲突

- 仓库处于 Merge、Rebase、Cherry-pick 或 Revert 过程中时，可直接在界面上继续或中止当前操作。
- 冲突文件以内嵌 Merge Editor 卡片的形式显示在 Multi-Diff 中，支持接受当前、传入或组合结果，并可保存后标记为已解决。
- 子模块指针冲突同样可以在卡片中处理。

### 状态栏

当工作区包含 Git 仓库时，状态栏显示仓库数量，以及冲突、已暂存、未暂存和未跟踪文件的合计；悬停可查看每个仓库的明细，点击打开 FasterGit 面板。

## 快速开始

1. 打开包含 Git 仓库的文件夹或工作区。
2. 打开底部面板并选择 **FasterGit**，或从命令面板运行 **FasterGit: Open Panel**。
3. 从仓库选择器中选择仓库或已初始化子模块。
4. 选择需要查看历史的一个或多个分支。
5. 选择提交，加载 Changed Files 列表和 Multi-Diff 视图。
6. 选择 **Uncommitted Changes**，管理当前工作区变更；也可以运行 **FasterGit: Open Commit Panel** 同时处理多个仓库。

## 界面控件

| 控件 | 功能 |
| --- | --- |
| 仓库选择器 | 切换当前仓库或子模块 |
| 分支选择器 | 筛选并选择一个或多个分支 |
| 搜索框 | 搜索提交元数据；多个关键词使用空格分隔 |
| 定位按钮 | 返回当前 HEAD 提交 |
| 刷新 | 重新加载仓库、引用、提交和当前变更 |
| Fetch / Pull / Push | 同步当前仓库 |
| Tree / Flat | 切换 Changed Files 的目录树或平铺布局 |

## 命令

| 命令 | 功能 |
| --- | --- |
| `FasterGit: Open Panel` | 聚焦 FasterGit 底部面板 |
| `FasterGit: Open Commit Panel` | 打开多仓库 Commit Panel |

## 快捷键

| 快捷键 | 使用场景 | 功能 |
| --- | --- | --- |
| `Ctrl+F` / `Cmd+F` | FasterGit Multi-Diff | 搜索整个 Multi-Diff |
| `F7` | FasterGit Multi-Diff | 下一个差异 |
| `Shift+F7` | FasterGit Multi-Diff | 上一个差异 |
| `Ctrl+Enter` / `Cmd+Enter` | `COMMIT_EDITMSG` | 完成提交 |
| `Escape` | `COMMIT_EDITMSG` | 取消提交 |

## 设置

| 设置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `vscode-gitk.changedFilesDisplayMode` | `tree`、`flat` | `flat` | 控制 Changed Files 的布局。工具栏切换操作会写入 VS Code 全局用户设置。 |
| `vscode-gitk.multiDiffRenderSideBySide` | `true`、`false` | `true` | Multi-Diff 面板是否使用双栏模式显示差异。 |
| `vscode-gitk.discardUntrackedChangesToTrash` | `true`、`false` | `true` | 还原未跟踪文件时移入回收站，而不是永久删除。回收站不可用的环境（远程、Snap）始终永久删除。 |
| `vscode-gitk.useSystemProxy` | `true`、`false` | `true` | 远程 Git 操作使用 VS Code `http.proxy`，或 Windows 用户级系统 HTTP/HTTPS 代理及 bypass 列表。 |

设置项和命令 ID 仍沿用 `vscode-gitk.` 前缀，已有的用户配置和快捷键绑定不会失效。

## 运行要求

- VS Code `1.94.0` 或更高版本。
- 通用原生 VSIX 内置 Windows x64/arm64、Linux x64/arm64/armhf、Alpine x64/arm64、macOS x64/arm64 的 `.node` 二进制文件，并分别放在 `lib/<target>/` 下；安装后会按扩展宿主的系统、架构与 libc 类型加载对应模块。用户不需要额外安装 Node.js、Rust、Zig、libgit2 或 OpenSSL。
- 浏览器版 VS Code（Web Extension Host）暂不支持；libgit2 原生模块无法在浏览器内运行，需要另行实现 Web 后端。远程开发时，通用 VSIX 会在远程扩展宿主中选择对应的原生模块。
- 远程 fetch/pull/push 与子模块更新通过系统 Git CLI 执行，以复用 Git Credential Manager、企业网络策略和仓库传输配置；其余本地仓库读取与写入仍由内置 libgit2 原生模块处理。因此运行远程操作时需要 Git CLI 可在扩展宿主的 `PATH` 中找到。
- 系统代理默认启用。Git 自己已配置的 `http.proxy` 或 `remote.<name>.proxy`、宿主已有的代理环境变量优先于自动发现；Windows 只读取用户级手动代理和 bypass 列表。PAC/WPAD、NTLM/Kerberos 和 SOCKS 等需要系统或 Git 自身支持，扩展不会猜测、执行 PAC 或覆盖已有代理配置。
- 当前工作区至少包含一个 Git 仓库。

## 开发

安装依赖并编译 TypeScript：

```bash
npm install
npm run compile
```

原生 `.node` 模块已经与 TypeScript 和 VSCE 打包流程分离，需要单独执行构建命令。构建产物只写入对应的 `lib/<target>/` 目录：

```bash
# 只构建当前开发系统
npm run build:native

# 在当前开发机交叉编译全部九个平台
npm run build:native:all

# 检查九个平台的产物是否齐全
npm run verify:native:all
```

按 `F5` 启动 Extension Development Host。首次运行前需要先执行 `npm run build:native`，确保当前平台的模块已存在。开发期间可以运行：

```bash
npm run watch
```

在已配置的 Windows 开发环境中，也可以运行 `run.bat`，该脚本会先编译扩展，再打开新的 Extension Development Host 窗口。

当 `lib/` 已包含要分发的平台模块时，可以直接使用标准 VSCE 命令打包 VSIX：

```bash
npx vsce package
```

`vsce package`（以及 `npm run package:vsix`）只执行 TypeScript 编译和打包，不会构建、补全或验证原生模块；它只会把 `lib/` 中已经存在的最终 `.node` 文件收入 VSIX。打包通用版本前应先独立执行 `npm run build:native:all` 和 `npm run verify:native:all`。`build:native:all` 默认并行构建 3 个目标，可通过 `npm run build:native:all -- --jobs 4` 或环境变量 `VSCODE_GITK_NATIVE_JOBS` 调整；每个目标使用独立的 Cargo target 目录。Windows x64 首次交叉编译会把固定版本的 Zig、GNU Make、OpenSSL 配置所需的 Perl 模块及各平台 Cargo 中间产物存放到仓库根目录的 `vscode-gitk-native-tools/`，不使用 WSL；之后会直接复用缓存。可执行 `.\build-native-all.ps1 -Jobs 4` 编译全部平台，或添加 `-MissingOnly` 只补齐缺失平台。

原生模块构建机仍需安装 Node.js/npm、Rust 与 Git for Windows；这些只用于生成 `lib/<target>/` 中的二进制文件，不是扩展用户的运行时依赖。CI 会显式地先运行独立原生构建和验证，再运行 `vsce package` 生成不带 `--target` 标识的通用 VSIX。各系统 CI 宿主只下载构建产物进行加载测试，不参与编译。扩展运行时只加载 VSIX 内置模块，绝不会要求用户现场编译。

## 项目结构

```text
src/
  extension.ts                 扩展激活与命令注册
  git/                         仓库、分支、提交、差异与监听逻辑
  services/                    Git 操作与共享应用服务
  store/                       集中式应用状态与副作用
  webview/                     提交图与 Multi-Diff 界面
media/                         产品图标、面板图标、Codicons 与 Monaco 资源
lib/<target>/                  按 VS Code 平台划分的原生模块构建输出
scripts/                       构建期资源脚本
```

## 许可证

本项目基于 [MIT License](LICENSE.txt) 发布。
