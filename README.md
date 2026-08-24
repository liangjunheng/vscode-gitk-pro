<div align="center">
  <img src="media/gitk-logo.png" width="128" height="128" alt="Gitk Pro 图标">

# Gitk Pro

**专注于 Git 历史浏览与变更管理的 VS Code 工作区。**

无需离开编辑器，即可查看提交拓扑、多文件差异，管理分支与标签，并处理已暂存和未暂存的更改。

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/liangjunheng.vscode-gitk-pro?label=Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=liangjunheng.vscode-gitk-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.80.0-007ACC.svg)](https://code.visualstudio.com/)

</div>

## 项目简介

Gitk Pro 在 VS Code 底部面板中提供 Gitk 风格的提交图，并将历史浏览与日常 Git 操作整合在同一界面。插件会发现当前工作区中的仓库及已初始化子模块，绘制分支拓扑，并同步提交图、变更文件列表和多文件差异编辑器。

插件直接使用 Git 完成仓库发现、历史读取、远程同步和写入操作，面向桌面版 VS Code 设计。

## 主要功能

### 提交图

- 使用彩色泳道显示提交拓扑、合并路径、引用、作者、日期和短哈希。
- 在工作区仓库与已初始化子模块之间切换。
- 同时选择一个或多个本地或远程分支，查看组合后的提交历史。
- 按哈希、父提交哈希、作者、邮箱、提交者、日期、标题、正文或引用名称搜索提交。
- 展开提交，查看完整提交信息和元数据。
- 提交图刷新时保持当前可见提交的位置稳定。

### 变更文件与 Multi-Diff

- 在一个 Multi-Diff 编辑器中查看某次提交涉及的全部文件。
- 在平铺列表与目录树之间切换 Changed Files 的显示方式。
- 从差异视图打开单个文件，并同步文件选中状态。
- 使用编辑器标题栏按钮或 `F7`、`F8` 在差异之间导航。
- 从 Changed Files 标题栏直接复制提交哈希。

### 工作区变更

- 通过虚拟的 **Uncommitted Changes** 提交查看已暂存、未暂存和未跟踪文件。
- 对单个文件或整个分区执行暂存、取消暂存和放弃更改。
- 提交已暂存内容，或通过内置 `COMMIT_EDITMSG` 编辑流程执行 Amend。
- 使用 `Ctrl+Enter` / `Cmd+Enter` 完成提交，使用 `Escape` 取消提交。

### 历史与仓库操作

- 对选中的仓库执行 Fetch、Pull 和 Push。
- 基于选中的提交创建分支或标签。
- 对提交执行 Checkout、Cherry-pick、Revert 或 Reset。
- 通过文件系统监听同步仓库、HEAD、Index 和工作区状态。

## 快速开始

1. 打开包含 Git 仓库的文件夹或工作区。
2. 打开底部面板并选择 **Gitk**。
3. 从仓库选择器中选择仓库或已初始化子模块。
4. 选择需要查看历史的一个或多个分支。
5. 选择提交，加载 Changed Files 列表和 Multi-Diff 视图。
6. 选择 **Uncommitted Changes**，管理当前工作区变更。

也可以从命令面板运行 **Gitk: Open Gitk Panel**。

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

## 快捷键

| 快捷键 | 使用场景 | 功能 |
| --- | --- | --- |
| `F7` | Gitk Multi-Diff | 下一个差异 |
| `F8` | Gitk Multi-Diff | 上一个差异 |
| `Ctrl+Enter` / `Cmd+Enter` | `COMMIT_EDITMSG` | 完成提交 |
| `Escape` | `COMMIT_EDITMSG` | 取消提交 |

## 设置

| 设置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `vscode-gitk.changedFilesDisplayMode` | `tree`、`flat` | `flat` | 控制 Changed Files 的布局。工具栏切换操作会写入 VS Code 全局用户设置。 |

## 运行要求

- VS Code `1.80.0` 或更高版本。
- 已安装 Git，并且扩展宿主可以调用 Git。
- 当前工作区至少包含一个 Git 仓库。

## 开发

安装依赖并编译：

```bash
npm install
npm run compile
```

按 `F5` 启动 Extension Development Host。开发期间可以运行：

```bash
npm run watch
```

在已配置的 Windows 开发环境中，也可以运行 `run.bat`，该脚本会先编译扩展，再打开新的 Extension Development Host 窗口。

## 项目结构

```text
src/
  extension.ts                 扩展激活与命令注册
  git/                         仓库、分支、提交、差异与监听逻辑
  services/                    Git 操作与共享应用服务
  store/                       集中式应用状态与副作用
  webview/                     提交图与 Multi-Diff 界面
media/                         产品图标、面板图标、Codicons 与 Monaco 资源
scripts/                       构建期资源脚本
```

## 许可证

本项目基于 [MIT License](LICENSE.txt) 发布。
