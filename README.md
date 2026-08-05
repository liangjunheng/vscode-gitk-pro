# vscode-gitk

VS Code 插件, 在活动栏提供一个类似 gitk 的提交图面板。**支持桌面版和 Web 版 (vscode.dev / GitHub Codespaces)**。

## 功能

- 左侧活动栏新增 Gitk 图标, 点击打开面板
- 面板上方: 提交图 (分支连线 + 提交点), 每行显示短哈希/分支名/提交信息/作者/日期
- 面板下方: 变更文件列表, 点击提交行后加载该提交的变更文件
- 变更文件支持 **树形 (Tree)** 和 **平铺 (Flat)** 两种显示方式, 顶部按钮切换
- 点击变更文件可在 diff 编辑器中查看差异, 右侧文件列表与编辑器活动标签同步高亮
- 颜色按分支列区分, HEAD 提交带圆环高亮

## Web 支持

本插件不直接调用 `git` 命令行, 而是通过 VS Code 内置 Git 扩展 API (`vscode.git`) 获取提交历史和变更文件:
- `repository.log()` 获取提交列表
- `repository.diffBetween(ref1, ref2)` 获取两个提交间的变更文件
- `git` scheme URI 读取特定提交的文件内容, 用于 diff 编辑器

因此插件可在 **VS Code 桌面版** 和 **VS Code Web (vscode.dev, GitHub Codespaces)** 中运行。

## 构建

```bash
npm install
npm run compile
```

按 F5 在 Extension Development Host 中调试。
