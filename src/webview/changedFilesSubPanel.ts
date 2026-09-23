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
  #workingTreeCommitEditor { display: flex; flex: 0 0 auto; flex-direction: column; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); background: var(--vscode-editor-background); }
  #workingTreeCommitEditor[hidden] { display: none !important; }
  #workingTreeCommitMessage { display: block; width: 100%; min-height: 42px; box-sizing: border-box; resize: none; overflow: hidden; padding: 6px 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; line-height: 1.35; }
  #workingTreeCommitMessage:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #workingTreeCommitActions { position: relative; display: flex; width: 100%; align-items: stretch; }
  #workingTreeCommitMain, #workingTreeCommitMore { height: 26px; border: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; font-size: 13px; }
  #workingTreeCommitMain { display: inline-flex; flex: 1 1 auto; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; border-radius: 3px 0 0 3px; }
  #workingTreeCommitMore { flex: 0 0 26px; width: 26px; margin-left: auto; padding: 0; border-left: 1px solid color-mix(in srgb, var(--vscode-button-foreground) 45%, transparent); border-radius: 0 3px 3px 0; }
  #workingTreeCommitMain:hover, #workingTreeCommitMore:hover { background: var(--vscode-button-hoverBackground); }
  #workingTreeCommitMain:active, #workingTreeCommitMore:active { background: var(--vscode-button-hoverBackground); }
  #workingTreeCommitMain:focus-visible, #workingTreeCommitMore:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #workingTreeCommitMain:disabled, #workingTreeCommitMore:disabled, #workingTreeCommitMenu button:disabled { opacity: .55; cursor: default; }
  #workingTreeCommitMenu { position: absolute; top: calc(100% + 3px); right: 0; z-index: 10; min-width: 150px; margin: 0; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 4px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  #workingTreeCommitMenu[hidden] { display: none !important; }
  #workingTreeCommitMenu button { display: block; width: 100%; padding: 5px 8px; border: 0; border-radius: 3px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
  #workingTreeCommitMenu button:hover { color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
  #filesList { min-width: 0; min-height: 0; flex: 1 1 auto; overflow-x: auto; overflow-y: auto; }
  #filesList > * { min-width: max-content; }
  .changed-virtual-list { width: 100%; min-width: max-content; }
  .changed-virtual-spacer { width: 1px; min-height: 0; pointer-events: none; }
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
  .working-tree-section-header { cursor: pointer; user-select: none; }
  .working-tree-section-header .working-tree-section-chevron { flex: 0 0 auto; margin-right: 2px; font-size: 14px; }
  .working-tree-section-body[hidden] { display: none; }
  .working-tree-section-body .file-item { width: max-content; min-width: 100%; padding-left: 15px; padding-right: 0; background: var(--working-tree-row-background); }
  .working-tree-section-body .file-item:hover { --working-tree-row-background: var(--vscode-list-hoverBackground); }
  .working-tree-section-body .file-item.selected { --working-tree-row-background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .working-tree-section-body .file-item.multi-selected { --working-tree-row-background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
  .working-tree-section-body .file-item.selected.multi-selected { --working-tree-row-background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
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
  .working-tree-kind-conflict { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e51400); }
  .working-tree-kind-untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c)); }
  .working-tree-kind-untracked .kind-file { stroke-dasharray: 1.6 1.6; }
  .working-tree-kind-unstaged { color: var(--vscode-foreground); }
  .working-tree-kind-staged { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status { width: 12px; text-align: center; font-weight: 700; }
  .file-status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .file-status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .file-status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .file-status-U { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e51400); }
  .working-tree-section[data-section="conflict"] .file-name { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e51400); }
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
      <div id="workingTreeCommitEditor" hidden><textarea id="workingTreeCommitMessage" rows="2" spellcheck="false" placeholder="Message (Ctrl+Enter to commit)"></textarea><div id="workingTreeCommitActions"><button id="workingTreeCommitMain" type="button"><span>Commit</span></button><button id="workingTreeCommitMore" type="button" aria-label="更多提交操作"><span class="codicon codicon-chevron-down" aria-hidden="true"></span></button><div id="workingTreeCommitMenu" hidden><button type="button" data-working-tree-commit="commit">Commit</button><button type="button" data-working-tree-commit="amend">Commit (Amend)</button><button type="button" data-working-tree-commit="push">Commit &amp; Push</button><button type="button" data-working-tree-commit="sync">Commit &amp; Sync</button></div></div></div>
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
  // 记录由变更列表自身发起的选择；Store 回显时只更新高亮，不反向滚动列表。
  let pendingLocalFileSelectionPath = '';
  let workingTreeCommitMessage = '';
  const collapsedFolders = new Set();
  const collapsedWorkingTreeSections = new Set();
  const selectedWorkingTreeFiles = new Set();
  let workingTreeSelectionAnchor = '';
  // 与 commitListModelKey 同一思路: focus/blur 等无关 stateChanged 不应重新渲染文件列表, 否则正在被点击的 .file-item 会被拆掉重建, 导致首击无效。
  let filesModelKey = '';
  document.getElementById('filesModeBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'toggleFilesMode' });
  });
  function closeWorkingTreeCommitMenu() {
    const menu = document.getElementById('workingTreeCommitMenu');
    if (menu) menu.hidden = true;
  }
  function resizeWorkingTreeCommitMessage(input) {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  function postWorkingTreeCommit(action) {
    const input = document.getElementById('workingTreeCommitMessage');
    if (!input || !isWorkingTreeHash(selectedCommitHash) || !selectedCommitRepositoryPath || files.some(function(file) { return file.workingTreeKind === 'conflict'; })) return;
    vscode.postMessage({ type: 'workingTreeCommit', action: action, repositoryPath: selectedCommitRepositoryPath, message: input.value });
    closeWorkingTreeCommitMenu();
  }
  function updateWorkingTreeCommitEditor() {
    const editor = document.getElementById('workingTreeCommitEditor');
    const input = document.getElementById('workingTreeCommitMessage');
    if (!editor || !input) return;
    const branchName = selectedBranches.length === 1 ? selectedBranches[0] : '';
    input.placeholder = branchName
      ? 'Message (Ctrl+Enter to commit on \"' + branchName + '\")'
      : 'Message (Ctrl+Enter to commit)';
    const visible = isWorkingTreeHash(selectedCommitHash);
    const hasConflicts = visible && files.some(function(file) { return file.workingTreeKind === 'conflict'; });
    workingTreeCommitMain.disabled = hasConflicts;
    workingTreeCommitMore.disabled = hasConflicts;
    workingTreeCommitMenu.querySelectorAll('button').forEach(function(button) { button.disabled = hasConflicts; });
    editor.title = hasConflicts ? '请先解决所有合并冲突' : '';
    editor.hidden = !visible;
    if (!visible) {
      closeWorkingTreeCommitMenu();
      return;
    }
    const repositoryChanged = editor.dataset.repositoryPath !== selectedCommitRepositoryPath;
    if (!repositoryChanged && document.activeElement === input) {
      workingTreeCommitMessage = input.value;
      return;
    }
    if (input.value !== workingTreeCommitMessage) {
      input.value = workingTreeCommitMessage;
      resizeWorkingTreeCommitMessage(input);
    }
    editor.dataset.repositoryPath = selectedCommitRepositoryPath || '';
  }
  const workingTreeCommitMessageInput = document.getElementById('workingTreeCommitMessage');
  const workingTreeCommitMain = document.getElementById('workingTreeCommitMain');
  const workingTreeCommitMore = document.getElementById('workingTreeCommitMore');
  const workingTreeCommitMenu = document.getElementById('workingTreeCommitMenu');
  workingTreeCommitMessageInput.addEventListener('input', function() {
    workingTreeCommitMessage = workingTreeCommitMessageInput.value;
    resizeWorkingTreeCommitMessage(workingTreeCommitMessageInput);
    if (selectedCommitRepositoryPath) {
      vscode.postMessage({ type: 'updateCommitMessage', repositoryPath: selectedCommitRepositoryPath, message: workingTreeCommitMessageInput.value });
    }
  });
  workingTreeCommitMessageInput.addEventListener('keydown', function(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      postWorkingTreeCommit('commit');
    }
  });
  workingTreeCommitMain.addEventListener('click', function() { postWorkingTreeCommit('commit'); });
  workingTreeCommitMore.addEventListener('click', function(event) {
    event.stopPropagation();
    workingTreeCommitMenu.hidden = !workingTreeCommitMenu.hidden;
  });
  workingTreeCommitMenu.addEventListener('click', function(event) {
    const button = event.target.closest('[data-working-tree-commit]');
    if (!button) return;
    postWorkingTreeCommit(button.getAttribute('data-working-tree-commit') || 'commit');
  });
  document.addEventListener('click', function(event) {
    if (!event.target.closest('#workingTreeCommitActions')) closeWorkingTreeCommitMenu();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeWorkingTreeCommitMenu();
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
  function revealMountedSelectedFile(list) {
    const item = list.querySelector('.file-item.selected');
    if (!item) return;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const viewportTop = listRect.top + list.clientTop;
    const viewportBottom = viewportTop + list.clientHeight;
    const sectionHeader = item.closest('.working-tree-section')?.querySelector('.working-tree-section-header');
    const visibleTop = sectionHeader ? Math.max(viewportTop, sectionHeader.getBoundingClientRect().bottom) : viewportTop;
    // MultiDiff 回写高亮时让对应文件固定出现在当前分组标题下方，而不是只滚到“勉强可见”。
    const delta = itemRect.top - visibleTop;
    if (Math.abs(delta) > .5) list.scrollTop += delta;
  }

  function changedEntryDiffKey(entry) {
    if (!entry || entry.type !== 'file') return '';
    return entry.section ? entry.section + ':' + entry.file.path : (entry.file.diffKey || entry.file.path);
  }

  // 虚拟列表中的远端目标可能尚未挂载；先按逻辑卡片索引定位，再渲染目标附近窗口并做像素级校正。
  function revealSelectedFile() {
    if (!selectedPath) return;
    const list = document.getElementById('filesList');
    const hosts = Array.from(list.querySelectorAll('.changed-virtual-list'));
    let targetHost = null;
    let targetIndex = -1;
    for (const host of hosts) {
      const index = host._entryIndexByDiffKey instanceof Map
        ? (host._entryIndexByDiffKey.get(selectedPath) ?? -1)
        : -1;
      if (index >= 0) { targetHost = host; targetIndex = index; break; }
    }
    if (targetHost && targetIndex >= 0) {
      const listRect = list.getBoundingClientRect();
      const hostRect = targetHost.getBoundingClientRect();
      const targetTop = list.scrollTop + hostRect.top - listRect.top - list.clientTop + targetIndex * CHANGED_FILE_ROW_HEIGHT;
      const sectionHeader = targetHost.closest('.working-tree-section')?.querySelector('.working-tree-section-header');
      const stickyHeaderHeight = sectionHeader ? sectionHeader.getBoundingClientRect().height : 0;
      // 外部高亮始终置顶到分组标题下方；本地点击回显会被 localFileSelectionEcho 跳过，不改变用户刚点击时的列表位置。
      let nextScrollTop = targetTop - stickyHeaderHeight;
      nextScrollTop = Math.max(0, Math.min(nextScrollTop, Math.max(0, list.scrollHeight - list.clientHeight)));
      if (Math.abs(nextScrollTop - list.scrollTop) > .5) list.scrollTop = nextScrollTop;
      refreshChangedVirtualLists();
      syncWorkingTreeSelectionClasses(list);
    }
    revealMountedSelectedFile(list);
  }

  function updateFilesCommitHash() {
    const isCommit = selectedCommitHash && !isWorkingTreeHash(selectedCommitHash);
    const hashLabel = document.getElementById('filesCommitHash');
    if (hashLabel) hashLabel.textContent = isCommit ? selectedCommitHash.slice(0, 8) : '';
  }

  function workingTreeSelectionKey(section, path) {
    return section + '\u0000' + path;
  }

  function getWorkingTreeSelectionParts(key) {
    const separator = key.indexOf('\u0000');
    return separator < 0 ? null : { section: key.slice(0, separator), path: key.slice(separator + 1) };
  }

  function pruneWorkingTreeSelection() {
    const available = new Set(files.map(function(file) {
      const section = file.workingTreeKind === 'conflict' ? 'conflict' : file.workingTreeKind === 'staged' ? 'staged' : 'unstaged';
      return workingTreeSelectionKey(section, file.path);
    }));
    selectedWorkingTreeFiles.forEach(function(key) {
      if (!available.has(key)) selectedWorkingTreeFiles.delete(key);
    });
    if (workingTreeSelectionAnchor && !available.has(workingTreeSelectionAnchor)) workingTreeSelectionAnchor = '';
  }

  function selectedWorkingTreePaths(section, fallbackPath) {
    const paths = [];
    selectedWorkingTreeFiles.forEach(function(key) {
      const parts = getWorkingTreeSelectionParts(key);
      if (parts && parts.section === section) paths.push(parts.path);
    });
    if (fallbackPath && paths.indexOf(fallbackPath) < 0) return [fallbackPath];
    if (paths.length > 0) return paths;
    return fallbackPath ? [fallbackPath] : undefined;
  }

  function workingTreeActionPaths(button) {
    const section = button.getAttribute('data-section');
    if (!section) return undefined;
    return selectedWorkingTreePaths(section, button.getAttribute('data-path') || '');
  }

  function syncWorkingTreeSelectionClasses(list) {
    list.querySelectorAll('.file-item[data-diff-key]').forEach(function(item) {
      const diffKey = item.getAttribute('data-diff-key') || '';
      const section = item.getAttribute('data-section') || '';
      const path = item.getAttribute('data-path') || '';
      const selectionKey = workingTreeSelectionKey(section, path);
      const multiSelected = selectedWorkingTreeFiles.has(selectionKey);
      item.classList.toggle('multi-selected', multiSelected);
      item.classList.toggle('selected', diffKey === selectedPath && (multiSelected || !workingTreeSelectionAnchor));
    });
  }

  function workingTreeActionButton(action, section, path, icon, title) {
    return '<button type="button" class="working-tree-action" data-working-tree-action="' + action + '" data-section="' + section + '"' +
      (path ? ' data-path="' + escapeAttr(path) + '"' : '') + ' title="' + title + '" aria-label="' + title + '"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span></button>';
  }

  function workingTreeActionsHTML(actions) {
    return actions + '<span class="working-tree-actions-spacer" aria-hidden="true"></span>';
  }

  function workingTreeKindIconHTML(file, section) {
    if (section === 'conflict') {
      return '<span class="working-tree-kind working-tree-kind-conflict" title="Conflict：存在未解决冲突" aria-label="Conflict：存在未解决冲突"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5 16 15.5H2Z"/><path d="M9 6.25v4.5M9 13v.1" stroke-width="1.8"/></svg></span>';
    }
    if (section === 'staged') {
      return '<span class="working-tree-kind working-tree-kind-staged" title="Staged：已暂存" aria-label="Staged：已暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="m5.8 9 2.1 2.1 4.35-4.45" stroke-width="2"/></svg></span>';
    }
    if (file.isUntracked) {
      return '<span class="working-tree-kind working-tree-kind-untracked" title="Untracked：未跟踪" aria-label="Untracked：未跟踪"><svg viewBox="0 0 18 18" aria-hidden="true"><circle class="kind-file" cx="9" cy="9" r="6.25"/><path d="M7.15 7.15c.15-2.1 3.85-2.15 3.85.15 0 1.55-2 1.65-2 3.15M9 12.75v.1" stroke-width="1.7"/></svg></span>';
    }
    return '<span class="working-tree-kind working-tree-kind-unstaged" title="Unstaged：未暂存" aria-label="Unstaged：未暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="M9 5.25v4.5M9 12.4v.1" stroke-width="2"/></svg></span>';
  }

  function workingTreeFileActions(section, path) {
    if (section === 'conflict') return workingTreeActionButton('stage', section, path, 'add', '暂存当前文件并标记冲突已解决');
    if (section === 'staged') return workingTreeActionButton('unstage', section, path, 'remove', '取消暂存当前文件（移回 Unstaged Changes）');
    return workingTreeActionButton('discard', section, path, 'discard', '放弃当前文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, path, 'add', '暂存当前文件（移入 Staged Changes）');
  }

  function workingTreeFileHTML(file, section, treeIndent) {
    const lastSlash = file.path.lastIndexOf('/');
    const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
    const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
    const actions = workingTreeFileActions(section, file.path);
    const untracked = section === 'unstaged' && file.isUntracked ? ' untracked' : '';
    const diffKey = section + ':' + file.path;
    const selectionKey = workingTreeSelectionKey(section, file.path);
    const multiSelected = selectedWorkingTreeFiles.has(selectionKey);
    const activeSelected = diffKey === selectedPath && (multiSelected || !workingTreeSelectionAnchor);
    return '<div class="file-item' + (activeSelected ? ' selected' : '') + (multiSelected ? ' multi-selected' : '') + untracked + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '" data-section="' + section + '"' + (treeIndent ? ' style="padding-left:30px"' : '') + ' title="' + escapeAttr(file.path) + '">' +
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
        const actions = workingTreeFileActions(section, file.path);
        const diffKey = section + ':' + file.path;
        const untracked = section === 'unstaged' && file.isUntracked ? ' untracked' : '';
        const selectionKey = workingTreeSelectionKey(section, file.path);
        const multiSelected = selectedWorkingTreeFiles.has(selectionKey);
        const activeSelected = diffKey === selectedPath && (multiSelected || !workingTreeSelectionAnchor);
        html += '<div class="file-item' + (activeSelected ? ' selected' : '') + (multiSelected ? ' multi-selected' : '') + untracked + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '" data-section="' + section + '" style="padding-left:' + (folder ? 30 : 10) + 'px" title="' + escapeAttr(file.path) + '">';
        html += workingTreeKindIconHTML(file, section) + '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span><span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder + '/') + '</span>' : '') + '</span><span class="file-actions">' + workingTreeActionsHTML(actions) + '</span></div>';
      });
    });
    return html;
  }

  function workingTreeSectionHTML(section, label, sectionFiles) {
    if (section === 'conflict' && sectionFiles.length === 0) return '';
    const disabled = sectionFiles.length === 0;
    const collapsed = collapsedWorkingTreeSections.has(section);
    const hasSelected = sectionFiles.some(function(file) {
      return selectedWorkingTreeFiles.has(workingTreeSelectionKey(section, file.path));
    });
    const actions = disabled ? '' : section === 'conflict'
      ? workingTreeActionButton('stage', section, '', 'add', '暂存全部冲突文件并标记冲突已解决')
      : section === 'staged'
        ? workingTreeActionButton('unstage', section, '', 'remove', '取消暂存此分组的所有文件（全部移回 Unstaged Changes）')
        : workingTreeActionButton('discard', section, '', 'discard', '放弃此分组所有文件的未暂存更改（不可撤销）') + workingTreeActionButton('stage', section, '', 'add', '暂存此分组的所有文件（全部移入 Staged Changes）');
    return '<section class="working-tree-section' + (hasSelected ? ' has-selected' : '') + '" data-section="' + section + '">' +
      '<div class="working-tree-section-header' + (disabled ? ' disabled' : '') + '" data-working-tree-section-toggle="' + section + '"><span class="working-tree-section-chevron codicon codicon-chevron-' + (collapsed ? 'right' : 'down') + '"></span><span class="working-tree-section-leading"><span class="working-tree-section-title">' + label + '</span><span class="working-tree-section-count">' + sectionFiles.length + '</span></span><span class="working-tree-section-actions">' + workingTreeActionsHTML(actions) + '</span></div>' +
      '<div class="working-tree-section-body"' + (collapsed ? ' hidden' : '') + '></div></section>';
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

  const CHANGED_FILE_ROW_HEIGHT = 24;
  const CHANGED_FILE_OVERSCAN = 50;
  let changedVirtualFrame = 0;

  function changedCommitFileHTML(file, treeIndent) {
    const lastSlash = file.path.lastIndexOf('/');
    const folder = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
    const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
    const diffKey = file.diffKey || file.path;
    return '<div class="file-item' + (diffKey === selectedPath ? ' selected' : '') + '" data-path="' + escapeAttr(file.path) + '" data-diff-key="' + escapeAttr(diffKey) + '"' + (treeIndent ? ' style="padding-left:30px"' : '') + ' title="' + escapeAttr(file.path) + '">' +
      (file.isGitlink ? '<span class="gitlink-label">Repo</span>' : '') +
      '<span class="file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>' +
      '<span class="file-path"><span class="file-name">' + escapeHtml(name) + '</span>' + (folder ? ' <span class="file-folder">' + escapeHtml(folder) + '</span>' : '') + '</span></div>';
  }

  function changedFolderHTML(folder, expanded, folderKey) {
    return '<div class="folder-item" data-folder="' + escapeAttr(folderKey || folder) + '" title="' + escapeAttr(folder) + '">' +
      '<span class="tree-chevron codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="tree-folder-icon codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="file-path">' + escapeHtml(folder) + '</span></div>';
  }

  function changedVirtualEntries(section, sectionFiles) {
    if (filesMode !== 'tree') return sectionFiles.map(function(file) { return { type: 'file', key: 'file:' + file.path, file: file, section: section }; });
    const byFolder = new Map();
    sectionFiles.forEach(function(file) {
      const slash = file.path.lastIndexOf('/');
      const folder = slash >= 0 ? file.path.slice(0, slash) : '';
      const group = byFolder.get(folder) || [];
      group.push(file);
      byFolder.set(folder, group);
    });
    const entries = [];
    byFolder.forEach(function(folderFiles, folder) {
      if (folder) {
        const expanded = !collapsedFolders.has(section ? 'working-tree:' + section + ':' + folder : folder);
        entries.push({ type: 'folder', key: 'folder:' + folder, folder: folder, folderKey: section ? 'working-tree:' + section + ':' + folder : folder, expanded: expanded, section: section });
        if (!expanded) return;
      }
      folderFiles.forEach(function(file) { entries.push({ type: 'file', key: 'file:' + file.path, file: file, section: section, folder: folder }); });
    });
    return entries;
  }

  function createChangedVirtualRow(entry, index, renderEntry) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderEntry(entry);
    const row = wrapper.firstElementChild;
    if (row) row.dataset.virtualIndex = String(index);
    return row;
  }

  function rebuildChangedVirtualWindow(host, entries, renderEntry, start, end) {
    const top = document.createElement('div');
    top.className = 'changed-virtual-spacer';
    const bottom = document.createElement('div');
    bottom.className = 'changed-virtual-spacer';
    const fragment = document.createDocumentFragment();
    fragment.appendChild(top);
    for (let index = start; index < end; index++) {
      const row = createChangedVirtualRow(entries[index], index, renderEntry);
      if (row) fragment.appendChild(row);
    }
    fragment.appendChild(bottom);
    host.replaceChildren(fragment);
    host._virtualTop = top;
    host._virtualBottom = bottom;
  }

  function renderChangedVirtualList(host, entries, renderEntry) {
    const list = document.getElementById('filesList');
    if (!list) return;
    const previousEntries = host._entries;
    const previousRenderEntry = host._renderEntry;
    const previousStart = Number.isInteger(host._virtualStart) ? host._virtualStart : -1;
    const previousEnd = Number.isInteger(host._virtualEnd) ? host._virtualEnd : -1;
    host._entries = entries;
    host._renderEntry = renderEntry;
    if (previousEntries !== entries) {
      const entryIndexByDiffKey = new Map();
      entries.forEach(function(entry, index) {
        const key = changedEntryDiffKey(entry);
        if (key) entryIndexByDiffKey.set(key, index);
      });
      host._entryIndexByDiffKey = entryIndexByDiffKey;
    }
    const listRect = list.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const hostTop = hostRect.top - listRect.top;
    const start = Math.max(0, Math.min(entries.length, Math.floor((list.scrollTop - hostTop) / CHANGED_FILE_ROW_HEIGHT) - CHANGED_FILE_OVERSCAN));
    const end = Math.max(start, Math.min(entries.length, Math.ceil((list.scrollTop + list.clientHeight - hostTop) / CHANGED_FILE_ROW_HEIGHT) + CHANGED_FILE_OVERSCAN));
    if (previousEntries === entries && previousRenderEntry === renderEntry && previousStart === start && previousEnd === end) return;

    const canReuse = previousEntries === entries
      && previousRenderEntry === renderEntry
      && host._virtualTop && host._virtualBottom
      && previousStart < end && start < previousEnd;
    if (!canReuse) {
      rebuildChangedVirtualWindow(host, entries, renderEntry, start, end);
    } else {
      // RecyclerView 式增量更新：普通滚动只移除离屏边缘，并补上新进入 overscan 的少量行。
      Array.from(host.children).forEach(function(child) {
        const index = Number(child.dataset.virtualIndex);
        if (Number.isInteger(index) && (index < start || index >= end)) child.remove();
      });
      if (start < previousStart) {
        const prepend = document.createDocumentFragment();
        for (let index = start; index < Math.min(previousStart, end); index++) {
          const row = createChangedVirtualRow(entries[index], index, renderEntry);
          if (row) prepend.appendChild(row);
        }
        const firstRow = Array.from(host.children).find(function(child) { return child.dataset.virtualIndex !== undefined; });
        host.insertBefore(prepend, firstRow || host._virtualBottom);
      }
      if (end > previousEnd) {
        const append = document.createDocumentFragment();
        for (let index = Math.max(start, previousEnd); index < end; index++) {
          const row = createChangedVirtualRow(entries[index], index, renderEntry);
          if (row) append.appendChild(row);
        }
        host.insertBefore(append, host._virtualBottom);
      }
    }
    host._virtualTop.style.height = (start * CHANGED_FILE_ROW_HEIGHT) + 'px';
    host._virtualBottom.style.height = (Math.max(0, entries.length - end) * CHANGED_FILE_ROW_HEIGHT) + 'px';
    host._virtualStart = start;
    host._virtualEnd = end;
  }

  function renderWorkingTreeVirtualBody(body, section, sectionFiles) {
    const entries = changedVirtualEntries(section, sectionFiles);
    const virtual = document.createElement('div');
    virtual.className = 'changed-virtual-list';
    body.replaceChildren(virtual);
    renderChangedVirtualList(virtual, entries, function(entry) {
      if (entry.type === 'folder') return changedFolderHTML(entry.folder, entry.expanded, entry.folderKey);
      return workingTreeFileHTML(entry.file, section, Boolean(entry.folder));
    });
    syncWorkingTreeSelectionClasses(document.getElementById('filesList'));
  }

  function refreshChangedVirtualLists() {
    document.querySelectorAll('#filesList .changed-virtual-list').forEach(function(host) {
      renderChangedVirtualList(host, host._entries || [], host._renderEntry || function() { return ''; });
    });
  }

  function scheduleChangedVirtualLists() {
    if (changedVirtualFrame) return;
    changedVirtualFrame = requestAnimationFrame(function() { changedVirtualFrame = 0; refreshChangedVirtualLists(); });
  }
  document.getElementById('filesList').addEventListener('scroll', scheduleChangedVirtualLists, { passive: true });
  window.addEventListener('resize', scheduleChangedVirtualLists, { passive: true });

  function renderFiles() {
    const list = document.getElementById('filesList');
    const modeButton = document.getElementById('filesModeBtn');
    const modeIcon = document.getElementById('filesModeIcon');
    const isTree = filesMode === 'tree';
    modeIcon.setAttribute('d', isTree ? 'M2.5 3h5M5 3v4M5 7h5M7.5 7v4M7.5 11h6' : 'M3 4h10M3 8h10M3 12h10');
    modeButton.title = '显示方式（当前：' + (isTree ? '树状' : '平铺') + '）';
    bindFilesListInteractions(list);
    if (isWorkingTreeHash(selectedCommitHash)) {
      pruneWorkingTreeSelection();
      const sectionFiles = files;
      if (!sectionFiles.length) { list.innerHTML = '<div id="filesEmpty">暂无变更文件</div>'; return; }
      const conflictSectionFiles = sectionFiles.filter(function(file) { return file.workingTreeKind === 'conflict'; });
      const stagedSectionFiles = sectionFiles.filter(function(file) { return file.workingTreeKind === 'staged'; });
      const unstagedSectionFiles = sectionFiles.filter(function(file) { return file.workingTreeKind === 'unstaged' || file.workingTreeKind === 'untracked'; });
      const sectionHTML = workingTreeSectionHTML('conflict', 'Merge Changes', conflictSectionFiles) + workingTreeSectionHTML('staged', 'Staged Changes', stagedSectionFiles) + workingTreeSectionHTML('unstaged', 'Unstaged Changes', unstagedSectionFiles);
      list.innerHTML = '<div class="working-tree-content">' + sectionHTML + '</div>';
      [['conflict', conflictSectionFiles], ['staged', stagedSectionFiles], ['unstaged', unstagedSectionFiles]].forEach(function(pair) {
        const body = list.querySelector('.working-tree-section[data-section="' + pair[0] + '"] .working-tree-section-body');
        if (body && pair[1].length && !body.hidden) renderWorkingTreeVirtualBody(body, pair[0], pair[1]);
      });
      revealSelectedFile();
      return;
    }
    selectedWorkingTreeFiles.clear();
    workingTreeSelectionAnchor = '';
    if (!files.length) { list.innerHTML = '<div id="filesEmpty">此提交没有变更文件</div>'; return; }
    const virtual = document.createElement('div');
    virtual.className = 'changed-virtual-list';
    list.replaceChildren(virtual);
    const entries = changedVirtualEntries('', files);
    renderChangedVirtualList(virtual, entries, function(entry) {
      if (entry.type === 'folder') return changedFolderHTML(entry.folder, entry.expanded, entry.folderKey);
      return changedCommitFileHTML(entry.file, Boolean(entry.folder));
    });
    revealSelectedFile();
  }

  // 所有文件行统一使用事件委托；虚拟化会反复替换可视范围内的 DOM，不能给每一行重复绑定监听器。
  function bindFilesListInteractions(list) {
    if (list.dataset.virtualInteractionsBound === '1') return;
    list.dataset.virtualInteractionsBound = '1';
    list.addEventListener('click', function(event) {
      const target = event.target;
      const header = target.closest('[data-working-tree-section-toggle]');
      if (header && list.contains(header) && !target.closest('.working-tree-action')) {
        const section = header.getAttribute('data-working-tree-section-toggle');
        if (section) {
          if (collapsedWorkingTreeSections.has(section)) collapsedWorkingTreeSections.delete(section); else collapsedWorkingTreeSections.add(section);
          renderFiles();
        }
        return;
      }
      const folder = target.closest('.folder-item');
      if (folder && list.contains(folder)) {
        const key = folder.getAttribute('data-folder');
        if (key) { if (collapsedFolders.has(key)) collapsedFolders.delete(key); else collapsedFolders.add(key); renderFiles(); }
      }
    });
    list.addEventListener('pointerdown', function(event) {
      const action = event.target.closest('.working-tree-action');
      const item = event.target.closest('.file-item');
      if (action || item) {
        if (event.button !== 0) return;
        event.preventDefault();
        if (action) event.stopPropagation();
      }
    });
    list.addEventListener('pointerup', function(event) {
      if (event.button !== 0) return;
      const action = event.target.closest('.working-tree-action');
      if (action && list.contains(action)) {
        event.preventDefault(); event.stopPropagation();
        const paths = workingTreeActionPaths(action);
        const message = { type: 'workingTreeAction', action: action.getAttribute('data-working-tree-action'), section: action.getAttribute('data-section'), path: action.getAttribute('data-path') || undefined };
        if (paths) message.paths = paths;
        vscode.postMessage(message);
        return;
      }
      const item = event.target.closest('.file-item');
      if (!item || !list.contains(item)) return;
      event.preventDefault();
      const path = item.getAttribute('data-path');
      const diffKey = item.getAttribute('data-diff-key') || path;
      const section = item.getAttribute('data-section');
      if (!path || !diffKey) return;
      if (section && isWorkingTreeHash(selectedCommitHash)) {
        const selectionKey = workingTreeSelectionKey(section, path);
        const additive = event.ctrlKey || event.metaKey;
        const anchorParts = workingTreeSelectionAnchor ? getWorkingTreeSelectionParts(workingTreeSelectionAnchor) : null;
        const sectionFiles = files.filter(function(file) {
          return (section === 'conflict' && file.workingTreeKind === 'conflict') ||
            (section === 'staged' && file.workingTreeKind === 'staged') ||
            (section === 'unstaged' && (file.workingTreeKind === 'unstaged' || file.workingTreeKind === 'untracked'));
        });
        const anchorIndex = event.shiftKey && anchorParts && anchorParts.section === section
          ? sectionFiles.findIndex(function(file) { return file.path === anchorParts.path; }) : -1;
        const currentIndex = sectionFiles.findIndex(function(file) { return file.path === path; });
        if (event.shiftKey && anchorIndex >= 0 && currentIndex >= 0) {
          if (!additive) selectedWorkingTreeFiles.clear();
          for (let index = Math.min(anchorIndex, currentIndex); index <= Math.max(anchorIndex, currentIndex); index++) selectedWorkingTreeFiles.add(workingTreeSelectionKey(section, sectionFiles[index].path));
        } else if (additive) {
          if (selectedWorkingTreeFiles.has(selectionKey)) selectedWorkingTreeFiles.delete(selectionKey); else selectedWorkingTreeFiles.add(selectionKey);
        } else {
          selectedWorkingTreeFiles.clear(); selectedWorkingTreeFiles.add(selectionKey);
        }
        workingTreeSelectionAnchor = selectionKey;
      } else {
        selectedWorkingTreeFiles.clear(); workingTreeSelectionAnchor = '';
      }
      selectedPath = diffKey;
      pendingLocalFileSelectionPath = diffKey;
      syncWorkingTreeSelectionClasses(list);
      vscode.postMessage({ type: 'selectFile', path: diffKey });
    });
  }
`;
