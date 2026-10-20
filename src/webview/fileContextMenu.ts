/**
 * 文件右键菜单的唯一定义: 普通 commit 的变更文件列表与仓库卡片的文件行共用同一份菜单结构、
 * 样式与禁用规则。两处各自手写 HTML 曾导致只改一处、另一处停留在旧菜单。
 *
 * 脚本片段会被拼进 changedFilesSubPanel.ts (普通模板字符串) 与 repositoryChangesSubPanel.ts
 * (String.raw) 两种模板, 因此这里不能出现反引号或美元符加花括号。
 */
export const FILE_CONTEXT_MENU_ACTIONS = ['openFile', 'openBefore', 'openAfter', 'revealInOS', 'revealInExplorer', 'copy', 'copyPath', 'copyRelativePath'] as const;
export type FileContextMenuAction = typeof FILE_CONTEXT_MENU_ACTIONS[number];

export const FILE_CONTEXT_MENU_HTML =
  '<button type="button" data-file-action="openFile">打开文件</button>'
  + '<button type="button" data-file-action="openBefore">打开文件 (修改前)</button>'
  + '<button type="button" data-file-action="openAfter">打开文件 (修改后)</button>'
  + '<div class="context-menu-separator"></div>'
  + '<button type="button" data-file-action="revealInOS">通过文件管理器显示</button>'
  + '<button type="button" data-file-action="revealInExplorer">通过资源管理器视图显示</button>'
  + '<div class="context-menu-separator"></div>'
  + '<button type="button" data-file-action="copy">复制文件</button>'
  + '<button type="button" data-file-action="copyPath">复制文件路径</button>'
  + '<button type="button" data-file-action="copyRelativePath">复制文件相对路径</button>';

export const FILE_CONTEXT_MENU_STYLES = `
  .file-context-menu { position: fixed; z-index: 20; box-sizing: border-box; width: max-content; min-width: 180px; max-width: calc(100vw - 8px); max-height: calc(100vh - 8px); overflow-y: auto; margin: 0; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  .file-context-menu:not(:popover-open) { display: none; }
  .file-context-menu button { display: block; box-sizing: border-box; width: 100%; max-width: 100%; padding: 5px 8px; border: 0; border-radius: 3px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; font: inherit; white-space: normal; overflow-wrap: anywhere; }
  .file-context-menu button:hover:not(:disabled) { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground)); }
  .file-context-menu button:disabled { opacity: .5; cursor: default; }
  .file-context-menu button[hidden] { display: none; }
  .file-context-menu .context-menu-separator { height: 1px; margin: 4px 6px; background: var(--vscode-menu-separatorBackground, var(--vscode-menu-border, var(--vscode-editorWidget-border))); }
`;

/**
 * 菜单状态由文件事实决定, 不由调用方的列表类型决定:
 * - "打开文件"、"显示" 类动作都作用于磁盘上的当前文件: 已删除的文件、Gitlink 没有可打开的文件, 一律置灰。
 * - "打开文件 (修改前)" 打开改动之前的版本: 工作区文件取 HEAD 版本, 普通 commit 的文件取该提交的父提交版本。
 *   新增/未跟踪的文件没有修改前的版本, Gitlink 没有文件内容, 都置灰。
 * - "打开文件 (修改后)" 打开该提交写入的版本, 常驻显示、不比较磁盘文件是否一致 (比较在大文件上代价高)。
 *   它只对普通 commit 有意义: 工作区文件的修改后就是磁盘文件, 与 "打开文件" 重复, 所以隐藏。
 *   该提交删除的文件、Gitlink 没有修改后的版本, 置灰。
 */
export const FILE_CONTEXT_MENU_SCRIPT = `
  function createFileContextMenu(id) {
    var menu = document.createElement('div');
    menu.id = id;
    menu.className = 'file-context-menu';
    menu.setAttribute('popover', 'manual');
    menu.innerHTML = ${JSON.stringify(FILE_CONTEXT_MENU_HTML)};
    document.body.append(menu);
    return menu;
  }
  function applyFileContextMenuState(menu, file, historical) {
    var missingOnDisk = file.status === 'D' || Boolean(file.isGitlink);
    function setDisabled(action, disabled) { menu.querySelector('[data-file-action="' + action + '"]').disabled = Boolean(disabled); }
    setDisabled('openFile', missingOnDisk);
    setDisabled('openBefore', Boolean(file.isGitlink) || file.status === 'A' || Boolean(file.isUntracked));
    var openAfter = menu.querySelector('[data-file-action="openAfter"]');
    openAfter.hidden = !historical;
    openAfter.disabled = !historical || file.status === 'D' || Boolean(file.isGitlink);
    setDisabled('revealInOS', missingOnDisk);
    setDisabled('revealInExplorer', missingOnDisk);
  }
  function placeFileContextMenu(menu, event) {
    menu.showPopover();
    var bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - bounds.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - bounds.height - 4)) + 'px';
  }
`;
