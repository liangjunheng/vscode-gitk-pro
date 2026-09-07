/**
 * 变更文件列表子面板: 承载 webview 右侧 Changed Files 区域的样式、结构与交互脚本。
 * 三段片段按原样迁移自 GitkViewProvider 的内联 webview, 仅标题文案改为"变更文件列表";
 * 脚本片段与宿主片段、commitListSubPanel 片段拼接在同一个 IIFE 内, 共享同一作用域。
 */

/** 变更文件列表子面板的样式片段。 */
export const CHANGED_FILES_SUB_PANEL_STYLES = `
  #filesSection { width: 100%; height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  #filesHeader { height: 30px; padding: 0 10px; display: flex; align-items: center; flex: 0 0 auto; color: var(--vscode-tab-activeForeground); background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-weight: 600; }
  #filesTitle { display: flex; align-items: center; min-width: 0; gap: 6px; white-space: nowrap; }
  #filesCommitHash { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 400; }
  #filesActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  #filesActions .action-group { display: flex; align-items: center; gap: 2px; }
  #filesHeader [hidden] { display: none !important; }
  #filesHeader .toolbar-icon { width: 24px; height: 24px; border: 1px solid transparent; border-radius: 4px; transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease; }
  #filesHeader .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-toolbar-hoverOutline, transparent); }
  #filesHeader .toolbar-icon:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  #filesHeader .toolbar-icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #filesHeader .toolbar-icon svg { width: 16px; height: 16px; stroke-width: 1.5; }
  #filesList { min-width: 0; min-height: 0; flex: 1 1 auto; overflow-x: auto; overflow-y: auto; }
  #filesList > * { min-width: max-content; }
  #commitContextMenu { position: fixed; z-index: 20; min-width: 180px; max-height: calc(100vh - 8px); overflow-y: auto; margin: 0; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  #commitContextMenu:not(:popover-open) { display: none; }
  #commitContextMenu button { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; border-radius: 3px; padding: 5px 8px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; font: inherit; }
  #commitContextMenu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground)); }
  #commitContextMenu .context-menu-icon { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  #commitContextMenu .context-menu-separator { height: 1px; margin: 4px 6px; background: var(--vscode-menu-separatorBackground, var(--vscode-menu-border, var(--vscode-editorWidget-border))); }
  .file-item, .folder-item { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 10px; }
  .file-item { cursor: pointer; }
  .folder-item { cursor: pointer; font-weight: 600; gap: 0; }
  .folder-item .file-path { margin-left: 4px; }
  .file-item:hover, .folder-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #filesList > .working-tree-content { display: inline-grid; grid-template-columns: 1fr; width: max-content; min-width: 100%; }
  .working-tree-section-body { position: relative; width: 100%; min-width: 0; background: var(--working-tree-row-background); }
  .working-tree-section-body::before { content: ''; position: absolute; top: 0; bottom: 0; left: 7px; z-index: 1; width: 1px; pointer-events: none; }
  .working-tree-section[data-section="staged"] .working-tree-section-body::before { background: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .working-tree-section[data-section="unstaged"] .working-tree-section-body::before { background: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .working-tree-section + .working-tree-section { border-top: 1px solid var(--vscode-panel-border); }
  .working-tree-section { --working-tree-header-background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background)); --working-tree-row-background: var(--vscode-editor-background); position: relative; width: 100%; min-width: 0; }
  .working-tree-section-header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; width: 100%; min-width: 0; height: 26px; padding: 0 0 0 10px; box-sizing: border-box; font-weight: 600; background: var(--working-tree-header-background); }
  .working-tree-section-body .file-item { width: max-content; min-width: 100%; padding-left: 15px; padding-right: 0; background: var(--working-tree-row-background); }
  .working-tree-section-body .file-item:hover { --working-tree-row-background: var(--vscode-list-hoverBackground); }
  .working-tree-section-body .file-item.selected { --working-tree-row-background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .working-tree-section-header.disabled { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .working-tree-section-leading { position: sticky; left: 10px; z-index: 2; display: inline-flex; align-items: center; flex: 0 0 auto; min-width: 0; padding-right: 4px; background: var(--working-tree-header-background); }
  .working-tree-section-title { min-width: 0; }
  .working-tree-section-count { margin-left: 5px; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .working-tree-section-actions, .file-actions { position: sticky; right: 0; isolation: isolate; overflow: hidden; display: flex; align-items: center; flex: 0 0 auto; margin-left: auto; gap: 2px; box-sizing: border-box; padding: 1px 0 1px 4px; }
  .working-tree-section-actions { --working-tree-actions-background: var(--working-tree-header-background); --working-tree-actions-base: var(--vscode-editorWidget-background, var(--vscode-editor-background)); z-index: 3; }
  .file-actions { --working-tree-actions-background: var(--working-tree-row-background); --working-tree-actions-base: var(--vscode-editor-background); }
  .working-tree-section-actions::before, .file-actions::before { content: ''; position: absolute; inset: 0; z-index: 0; background: linear-gradient(var(--working-tree-actions-background), var(--working-tree-actions-background)), var(--working-tree-actions-base); }
  .working-tree-action { position: relative; z-index: 1; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; appearance: none; }
  .working-tree-actions-spacer { position: relative; z-index: 1; flex: 0 0 8px; width: 8px; align-self: stretch; }
  .working-tree-action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .working-tree-action:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  .working-tree-action:focus { outline: none; }
  .working-tree-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .working-tree-action .codicon { font-size: 16px; }
  .working-tree-section-header.disabled .working-tree-section-actions { display: none; }
  .file-item .file-actions { z-index: 2; align-self: stretch; }
  .file-item .file-path { flex: 1 1 auto; }
  /* 选择器需两级以压过 codicon.css 的 .codicon[class*='codicon-']，否则其 display:inline-block 与 16px/1 行高会让图标顶对齐。 */
  .folder-item .tree-chevron, .folder-item .tree-folder-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 14px; width: 14px; height: 100%; color: var(--vscode-icon-foreground); font-size: 13px; line-height: 1; }
  .working-tree-kind { display: inline-grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; box-sizing: border-box; }
  .working-tree-kind svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .working-tree-kind .kind-accent { fill: currentColor; stroke: none; }
  .working-tree-kind-untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c)); }
  .working-tree-kind-untracked .kind-file { stroke-dasharray: 1.6 1.6; }
  .working-tree-kind-unstaged { color: var(--vscode-foreground); }
  .working-tree-kind-staged { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status { width: 12px; text-align: center; font-weight: 700; }
  .file-status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .file-status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .working-tree-section[data-section="staged"] .file-name { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .working-tree-section[data-section="unstaged"] .file-name { color: var(--vscode-textLink-foreground, #3794ff); }
  .working-tree-section[data-section="unstaged"] .file-item.untracked .file-status,
  .working-tree-section[data-section="unstaged"] .file-item.untracked .file-name { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .file-path { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .file-folder { opacity: 0.55; }
  .gitlink-label { flex: 0 0 auto; padding: 1px 5px; border: 1px solid var(--vscode-badge-background, var(--vscode-panel-border)); border-radius: 3px; color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground)); font-size: 10px; line-height: 14px; }
  #filesEmpty { padding: 8px 10px; color: var(--vscode-descriptionForeground); }
  #filesEmpty:has(.files-loading-spinner) { display: flex; align-items: center; gap: 7px; }
  .files-loading-spinner { width: 12px; height: 12px; flex: 0 0 auto; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: files-loading-spin .8s linear infinite; }
  @keyframes files-loading-spin { to { transform: rotate(360deg); } }
`;

/** 变更文件列表子面板的结构片段。 */
export const CHANGED_FILES_SUB_PANEL_MARKUP = `
    <section id="filesSection">
      <div id="filesHeader"><div id="filesTitle"><span>变更文件列表</span><span id="filesCommitHash"></span></div><div id="filesActions"><div class="action-group"><button class="toolbar-icon" id="filesModeBtn" title="显示方式（当前：树状）" aria-label="显示方式"><svg viewBox="0 0 16 16" aria-hidden="true"><path id="filesModeIcon" d="M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6"/></svg></button></div></div></div>
      <div id="filesList"><div id="filesEmpty">选择一个提交以查看变更文件</div></div>
      <div id="commitContextMenu" popover="manual"><button type="button" data-commit-action="toggleDescription"><svg class="context-menu-icon" viewBox="0 0 16 16"><path id="toggleDescriptionIcon" d="M3 5.5 8 10l5-4.5"/></svg><span>展开描述</span></button><button type="button" data-commit-action="copyHash"><svg class="context-menu-icon" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7.5" height="8" rx="1"/><path d="M3 10.5v-7A1.5 1.5 0 0 1 4.5 2H10"/></svg><span>copy hash</span></button><div class="context-menu-separator"></div><button type="button" data-commit-action="checkout"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M4 3v8m0 0-2-2m2 2 2-2M4 11h4.5A3.5 3.5 0 0 0 12 7.5V5"/><path d="m10 6 2-2 2 2"/></svg><span>checkout</span></button><button type="button" data-commit-action="revert"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M5.5 4 3 6.5 5.5 9M3.5 6.5h6A3.5 3.5 0 1 1 6 10"/></svg><span>revert</span></button><button type="button" data-commit-action="drop"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 6.5v6h6v-6M7 8.5v2.5M9 8.5v2.5"/></svg><span>drop</span></button><button type="button" data-commit-action="cherryPick"><svg class="context-menu-icon" viewBox="0 0 16 16"><circle cx="4" cy="4" r="1.25"/><circle cx="12" cy="12" r="1.25"/><path d="M4 5.25v2.5A3.25 3.25 0 0 0 7.25 11H12M6 3h3"/></svg><span>cherry pick</span></button><div class="context-menu-separator"></div><button type="button" data-commit-action="merge"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M4 3v10M4 10c0-2.5 1.75-4 4.25-4H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="6" r="1.25"/></svg><span>merge</span></button><button type="button" data-commit-action="rebase"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M3 4h7M8.5 2 11 4 8.5 6M13 12H6M7.5 10 5 12l2.5 2"/></svg><span>rebase</span></button><button type="button" data-commit-action="reset"><svg class="context-menu-icon" viewBox="0 0 16 16"><rect x="4.5" y="5.5" width="8" height="8" rx="1"/><path d="M2.5 6A4.5 4.5 0 0 1 7 2.5h2M7 2.5l2 2-2 2"/></svg><span>reset</span></button><div class="context-menu-separator"></div><button type="button" data-commit-action="createBranch"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M4 3v10M4 5.5c0 2.1 1.4 3.5 3.5 3.5H11"/><circle cx="4" cy="3" r="1.25"/><circle cx="4" cy="13" r="1.25"/><circle cx="12" cy="9" r="1.25"/></svg><span>create branch</span></button><button type="button" data-commit-action="addTag"><svg class="context-menu-icon" viewBox="0 0 16 16"><path d="M2.5 7.75 7.25 3h5.75v5.75L8.25 13.5 2.5 7.75Z"/><circle cx="10.25" cy="5.75" r=".75" fill="currentColor" stroke="none"/></svg><span>add tag</span></button></div>
    </section>
`;

/** 变更文件列表子面板的交互脚本片段。 */
export const CHANGED_FILES_SUB_PANEL_SCRIPT = `
  function closeCommitContextMenu() {
    var contextMenu = document.getElementById('commitContextMenu');
    if (contextMenu.matches(':popover-open')) contextMenu.hidePopover();
  }
  document.addEventListener('click', function(event) {
    if (!event.target.closest('#commitContextMenu')) closeCommitContextMenu();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeCommitContextMenu();
  });
  let files = [];
  let stagedFiles = [];
  let unstagedFiles = [];
  let filesLoading = false;
  let filesMode = 'flat';
  let selectedPath = '';
  const collapsedFolders = new Set();
  document.getElementById('filesModeBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'toggleFilesMode' });
  });
  document.getElementById('commitContextMenu').addEventListener('click', function(event) {
    var button = event.target.closest('[data-commit-action]');
    if (!button || !selectedCommitHash || isWorkingTreeHash(selectedCommitHash) || !selectedCommitRepositoryPath) return;
    var action = button.getAttribute('data-commit-action');
    if (action === 'toggleDescription') {
      var row = document.querySelector('.commit-row.selected');
      if (row) row.click();
    } else {
      vscode.postMessage({ type: 'commitAction', action: action, hash: selectedCommitHash, repositoryPath: selectedCommitRepositoryPath });
    }
    this.hidePopover();
  });
  function revealSelectedFile() {
    if (!selectedPath) return;
    const list = document.getElementById('filesList');
    const item = list.querySelector('.file-item.selected');
    if (!item) return;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const viewportTop = listRect.top + list.clientTop;
    const viewportBottom = viewportTop + list.clientHeight;
    const sectionHeader = item.closest('.working-tree-section')?.querySelector('.working-tree-section-header');
    const visibleTop = sectionHeader ? Math.max(viewportTop, sectionHeader.getBoundingClientRect().bottom) : viewportTop;
    if (itemRect.bottom > viewportBottom) list.scrollTop += itemRect.bottom - viewportBottom;
    else if (itemRect.top < visibleTop) list.scrollTop -= visibleTop - itemRect.top;
  }

  function updateFilesCommitHash() {
    const isCommit = selectedCommitHash && !isWorkingTreeHash(selectedCommitHash);
    const hashLabel = document.getElementById('filesCommitHash');
    if (hashLabel) hashLabel.textContent = isCommit ? selectedCommitHash.slice(0, 8) : '';
  }

  function workingTreeActionButton(action, section, path, icon, title) {
    return '<button type="button" class="working-tree-action" data-working-tree-action="' + action + '" data-section="' + section + '"' +
      (path ? ' data-path="' + escapeAttr(path) + '"' : '') + ' title="' + title + '" aria-label="' + title + '"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span></button>';
  }

  function workingTreeActionsHTML(actions) {
    return actions + '<span class="working-tree-actions-spacer" aria-hidden="true"></span>';
  }

  function workingTreeKindIconHTML(file, section) {
    if (section === 'staged') {
      return '<span class="working-tree-kind working-tree-kind-staged" title="Staged：已暂存" aria-label="Staged：已暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="m5.8 9 2.1 2.1 4.35-4.45" stroke-width="2"/></svg></span>';
    }
    if (file.isUntracked) {
      return '<span class="working-tree-kind working-tree-kind-untracked" title="Untracked：未跟踪" aria-label="Untracked：未跟踪"><svg viewBox="0 0 18 18" aria-hidden="true"><circle class="kind-file" cx="9" cy="9" r="6.25"/><path d="M7.15 7.15c.15-2.1 3.85-2.15 3.85.15 0 1.55-2 1.65-2 3.15M9 12.75v.1" stroke-width="1.7"/></svg></span>';
    }
    return '<span class="working-tree-kind working-tree-kind-unstaged" title="Unstaged：未暂存" aria-label="Unstaged：未暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="M9 5.25v4.5M9 12.4v.1" stroke-width="2"/></svg></span>';
  }

  function workingTreeFileHTML(file, section) {
    const lastSlash = file.path.lastIndexOf('/');
    const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
    const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
    const actions = section === 'staged'
      ? workingTreeActionButton('unstage', section, file.path, 'remove', '取消暂存当前文件（移回 Unstaged Changes）')
      : workingTreeActionButton('discard', section, file.path, 'discard', '放弃当前文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, file.path, 'add', '暂存当前文件（移入 Staged Changes）');
    const untracked = section === 'unstaged' && file.isUntracked ? ' untracked' : '';
    const diffKey = section + ':' + file.path;
    return '<div class="file-item' + (diffKey === selectedPath ? ' selected' : '') + untracked + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '" data-section="' + section + '" title="' + escapeAttr(file.path) + '">' +
      workingTreeKindIconHTML(file, section) + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>' +
      '<span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder) + '</span>' : '') + '</span><span class="file-actions">' + workingTreeActionsHTML(actions) + '</span></div>';
  }

  function workingTreeSectionFilesHTML(section, sectionFiles) {
    const orderedFiles = sectionFiles;
    if (filesMode !== 'tree') return orderedFiles.map(function(file) { return workingTreeFileHTML(file, section); }).join('');
    const byFolder = new Map();
    orderedFiles.forEach(function(file) {
      const lastSlash = file.path.lastIndexOf('/');
      const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash) : '';
      const folderFiles = byFolder.get(folder) || [];
      folderFiles.push(file);
      byFolder.set(folder, folderFiles);
    });
    let html = '';
    byFolder.forEach(function(folderFiles, folder) {
      const folderKey = 'working-tree:' + section + ':' + folder;
      if (folder) {
        const expanded = !collapsedFolders.has(folderKey);
        html += '<div class="folder-item" data-folder="' + escapeAttr(folderKey) + '" title="' + escapeAttr(folder) + '">';
        html += '<span class="tree-chevron codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="tree-folder-icon codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="file-path">' + escapeHtml(folder) + '</span></div>';
        if (!expanded) return;
      }
      folderFiles.forEach(function(file) {
        const lastSlash = file.path.lastIndexOf('/');
        const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
        const actions = section === 'staged'
          ? workingTreeActionButton('unstage', section, file.path, 'remove', '取消暂存当前文件（移回 Unstaged Changes）')
          : workingTreeActionButton('discard', section, file.path, 'discard', '放弃当前文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, file.path, 'add', '暂存当前文件（移入 Staged Changes）');
        const diffKey = section + ':' + file.path;
        const untracked = section === 'unstaged' && file.isUntracked ? ' untracked' : '';
        html += '<div class="file-item' + (diffKey === selectedPath ? ' selected' : '') + untracked + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '" data-section="' + section + '" style="padding-left:' + (folder ? 30 : 10) + 'px" title="' + escapeAttr(file.path) + '">';
        html += workingTreeKindIconHTML(file, section) + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span><span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder + '/') + '</span>' : '') + '</span><span class="file-actions">' + workingTreeActionsHTML(actions) + '</span></div>';
      });
    });
    return html;
  }

  function workingTreeSectionHTML(section, label, sectionFiles) {
    if (section === 'staged' && sectionFiles.length === 0) return '';
    const disabled = sectionFiles.length === 0;
    const hasSelected = sectionFiles.some(function(file) { return section + ':' + file.path === selectedPath; });
    const actions = disabled ? '' : section === 'staged'
      ? workingTreeActionButton('unstage', section, '', 'remove', '取消暂存此分组的所有文件（全部移回 Unstaged Changes）')
      : workingTreeActionButton('discard', section, '', 'discard', '放弃此分组所有文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, '', 'add', '暂存此分组的所有文件（全部移入 Staged Changes）');
    return '<section class="working-tree-section' + (hasSelected ? ' has-selected' : '') + '" data-section="' + section + '">' +
      '<div class="working-tree-section-header' + (disabled ? ' disabled' : '') + '"><span class="working-tree-section-leading"><span class="working-tree-section-title">' + label + '</span><span class="working-tree-section-count">' + sectionFiles.length + '</span></span><span class="working-tree-section-actions">' + workingTreeActionsHTML(actions) + '</span></div>' +
      '<div class="working-tree-section-body">' + workingTreeSectionFilesHTML(section, sectionFiles) + '</div></section>';
  }

  // 文件夹折叠绑定同时服务普通提交与虚拟提交两个渲染分支。
  function bindFolderItems(list) {
    list.querySelectorAll('.folder-item').forEach(function(item) {
      item.addEventListener('pointerdown', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
      });
      item.addEventListener('pointerup', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        const folder = item.getAttribute('data-folder');
        if (!folder) return;
        if (collapsedFolders.has(folder)) collapsedFolders.delete(folder); else collapsedFolders.add(folder);
        renderFiles();
      });
    });
  }

  function renderFiles() {
    const list = document.getElementById('filesList');
    const modeButton = document.getElementById('filesModeBtn');
    const modeIcon = document.getElementById('filesModeIcon');
    const isTree = filesMode === 'tree';
    modeIcon.setAttribute('d', isTree ? 'M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6' : 'M3 4h10M3 8h10M3 12h10');
    modeButton.title = '显示方式（当前：' + (isTree ? '树状' : '平铺') + '）';
    if (isWorkingTreeHash(selectedCommitHash)) {
      // 虚拟提交的当前 DiffPayload[] 是宿主选中结果的权威快照；不能再读取异步维护的 stagedFiles/unstagedFiles。
      const sectionFiles = files;
      // 选中的虚拟行对应分组为空时, 与普通提交一致显示"暂无变更文件", 不渲染空 section。
      if (!sectionFiles.length) {
        list.innerHTML = '<div id="filesEmpty">暂无变更文件</div>';
        return;
      }
      const sectionHTML = selectedCommitHash === 'staged'
        ? workingTreeSectionHTML('staged', 'Staged Changes', sectionFiles)
        : workingTreeSectionHTML('unstaged', 'Unstaged Changes', sectionFiles);
      list.innerHTML = '<div class="working-tree-content">' + sectionHTML + '</div>';
      bindWorkingTreeActions(list);
      bindFolderItems(list);
      bindFileItems(list);
      revealSelectedFile();
      return;
    }
    if (!files.length) {
      list.innerHTML = '<div id="filesEmpty">此提交没有变更文件</div>';
      return;
    }
    const ordered = files;
    let html = '';
    if (filesMode === 'tree') {
      const filesByFolder = new Map();
      ordered.forEach(function(file) {
        const lastSlash = file.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash) : '';
        const group = filesByFolder.get(folder) || [];
        group.push(file);
        filesByFolder.set(folder, group);
      });
      filesByFolder.forEach(function(folderFiles, folder) {
        if (folder) {
          const expanded = !collapsedFolders.has(folder);
          html += '<div class="folder-item" data-folder="' + escapeAttr(folder) + '" title="' + escapeAttr(folder) + '">';
          html += '<span class="tree-chevron codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="tree-folder-icon codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="file-path">' + escapeHtml(folder) + '</span></div>';
          if (!expanded) return;
        }
        folderFiles.forEach(function(file) {
          const lastSlash = file.path.lastIndexOf('/');
          const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
          html += '<div class="file-item' + (file.path === selectedPath ? ' selected' : '') + '" data-path="' + escapeAttr(file.path) + '" style="padding-left:' + (folder ? 30 : 10) + 'px" title="' + escapeAttr(file.path) + '">';
          html += (file.isGitlink ? '<span class="gitlink-label">Repo</span>' : '') + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span><span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder + '/') + '</span>' : '') + '</span></div>';
        });
      });
    } else {
      for (const file of ordered) {
        const lastSlash = file.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
        const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
        html += '<div class="file-item' + (file.path === selectedPath ? ' selected' : '') + '" data-path="' + escapeAttr(file.path) + '" title="' + escapeAttr(file.path) + '">';
        html += (file.isGitlink ? '<span class="gitlink-label">Repo</span>' : '') + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>';
        html += '<span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder) + '</span>' : '') + '</span>' + (file.isGitlink ? '<span class="gitlink-label">Repo</span>' : '') + '</div>';
      }
    }
    list.innerHTML = html;
    revealSelectedFile();
    bindFolderItems(list);
    bindFileItems(list);
  }

  function bindWorkingTreeActions(list) {
    list.querySelectorAll('[data-working-tree-action]').forEach(function(button) {
      button.addEventListener('pointerdown', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('pointerup', function(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'workingTreeAction', action: button.getAttribute('data-working-tree-action'), section: button.getAttribute('data-section'), path: button.getAttribute('data-path') || undefined });
      });
    });
  }

  function bindFileItems(list) {
    list.querySelectorAll('.file-item').forEach(function(item) {
      item.addEventListener('pointerdown', function(event) {
        if (event.button !== 0 || event.target.closest('.working-tree-action')) return;
        event.preventDefault();
      });
      item.addEventListener('pointerup', function(event) {
        if (event.button !== 0 || event.target.closest('.working-tree-action')) return;
        event.preventDefault();
        const path = item.getAttribute('data-path');
        const diffKey = item.getAttribute('data-diff-key') || path;
        if (!path || !diffKey) return;
        selectedPath = diffKey;
        list.querySelectorAll('.file-item.selected').forEach(function(s) { s.classList.remove('selected'); });
        item.classList.add('selected');
        vscode.postMessage({ type: 'selectFile', path: diffKey });
      });
    });
  }
`;
