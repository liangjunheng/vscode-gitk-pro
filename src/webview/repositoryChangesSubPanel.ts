import { FILE_CONTEXT_MENU_STYLES } from './fileContextMenu';
// Repository worktrees have independent expansion, drafts and repository-scoped actions.
export const REPOSITORY_CHANGES_STYLES = `
  ${FILE_CONTEXT_MENU_STYLES}
  #filesList { display: none; }
  #repositoryChangesViewport { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; }
  #repositoryChangesList { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; padding: 12px 3px 8px 2px; }
  #repositoryChangesList[hidden] { display: none; }
  .repo-changes { width: 100%; min-width: 0; margin-bottom: 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 6px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); cursor: pointer; }
  .repo-changes.focused { border-color: var(--vscode-focusBorder); }
  .repo-changes:focus { outline: none; }
  .repo-changes-header { position: sticky; top: 0; z-index: 2; isolation: isolate; display: flex; width: 100%; align-items: center; height: 30px; min-width: 0; gap: 3px; padding: 0 6px; overflow: hidden; background-color: inherit; }
  .repo-changes-header::after { content: none; }
  .repo-changes-header.pinned::after { content: ''; position: absolute; top: 0; right: 0; left: 0; z-index: 3; height: 1px; background: var(--vscode-widget-border, var(--vscode-editorGroup-border)); pointer-events: none; }
  .repo-changes.focused > .repo-changes-header.pinned::after { background: var(--vscode-focusBorder); }
  .repo-changes-toggle { display: flex; justify-content: center; align-items: center; flex: 0 0 18px; width: 18px; height: 24px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .repo-changes-title { display: flex; align-items: center; flex: 1; min-width: 0; gap: 0; cursor: pointer; }
  .repo-changes-icon { position: relative; display: inline-flex; align-items: center; flex: 0 0 16px; width: 16px; height: 20px; }
  .repo-changes-icon .repository-icon { margin: 0; }
  .repo-changes-label, .repo-changes-head { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-changes-label { flex: 0 1 auto; user-select: none; }
  .repo-changes-ancestry { flex: 0 1 auto; min-width: 0; margin-left: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; opacity: .9; user-select: none; }
  .repo-changes-branch { display: flex; align-items: center; gap: 0; flex: 0 1 auto; min-width: 0; max-width: 45%; height: 24px; padding: 0 4px; border: 0; border-radius: 3px; color: var(--vscode-descriptionForeground); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
  .repo-changes-branch:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .repo-changes-branch:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-changes-head { min-width: 0; }
  .repo-changes-head-dirty { flex: 0 0 auto; }
  /* codicon 右侧留白(字形与字符盒右缘的距离)各不相同:git-commit .2773em、git-branch .125em、git-branch-changes 0。
     把可见笔画到分支名的距离统一为 git-commit 的 .2773em。 */
  .repo-changes-branch .codicon-git-branch { margin-right: .1523em; }
  .repo-changes-branch .codicon-git-branch-changes { margin-right: .2773em; }
  .repo-changes-header .toolbar-icon { flex: 0 0 22px; width: 22px; height: 24px; border: 0; border-radius: 3px; cursor: pointer; }
  .repo-changes-header .repo-sync { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: auto; min-width: 22px; padding: 0 1px; gap: 0; color: var(--vscode-descriptionForeground); font: inherit; font-size: 11px; }
  .repo-changes-header .repo-sync + .repo-sync { margin-left: -2px; }
  .repo-changes-header .repo-sync:hover { color: var(--vscode-foreground); }
  .repo-sync-count { white-space: nowrap; line-height: 1; }
  .repo-sync-count[hidden] { display: none; }
  .repo-changes-toggle:hover, .repo-file:hover { background: var(--vscode-list-hoverBackground); }
  .repo-changes-toggle:focus-visible, .repo-file:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-changes-header { border-radius: 5px; }
  /* 保留标题/正文层级，但用低对比细线替代主题硬边框，减弱上下区域的割裂感。 */
  .repo-changes:has(.repo-changes-body:not([hidden])) > .repo-changes-header { border-radius: 5px 5px 0 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
  /* 列表静止时保留顶部 12px；吸顶后抵消容器 padding，恢复贴顶效果。 */
  .repo-changes > .repo-changes-header.pinned { top: -12px; border-top-left-radius: 0; border-top-right-radius: 0; }
  .repo-changes-body { min-width: 0; padding: 6px 10px 10px; }
  .repo-message-box, .repo-file-groups, .repo-commit-actions { cursor: default; }
  .repo-commit-details { box-sizing: border-box; display: block; width: 100%; min-height: 36px; max-height: calc(7.5em + 18px); resize: none; overflow-y: auto; overflow-x: hidden; margin-bottom: 4px; padding: 8px 9px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
  .repo-commit-details:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-message-box[hidden], .repo-commit-actions[hidden], .repo-commit-details[hidden] { display: none !important; }
  .repo-changes.transitioning .repo-message-box, .repo-changes.transitioning .repo-commit-actions { display: none !important; }
  .repo-changes-body[hidden], .repo-group[hidden], .repo-group-files[hidden], .repo-commit-menu[hidden] { display: none !important; }
  .repo-message-box { position: relative; display: flex; flex-direction: column; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-editorGroup-border))); border-radius: 5px; overflow: hidden; }
  .repo-message-box:focus-within { border-color: var(--vscode-focusBorder); }
  .repo-message { box-sizing: border-box; width: 100%; min-height: 48px; resize: none; overflow: hidden; padding: 8px 9px 4px; border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground); font: inherit; line-height: 1.5; }
  .repo-message::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .repo-commit-actions { display: flex; position: relative; margin: 7px 0 4px; }
  .repo-commit-actions > button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 12px; line-height: normal; cursor: pointer; }
  .repo-commit-actions > button:focus-visible, .repo-commit-menu button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .repo-commit-main { flex: 1; border-radius: 4px 0 0 4px; }
  .repo-commit-more { width: 28px; flex: 0 0 28px; border-left-color: var(--vscode-widget-border) !important; border-radius: 0 4px 4px 0; }
  .repo-commit-actions button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .repo-commit-actions button:disabled { opacity: .5; cursor: default; }
  .repo-commit-menu { position: absolute; top: calc(100% + 2px); right: 0; z-index: 8; padding: 4px; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
  .repo-commit-menu button { display: block; width: 100%; padding: 5px 9px; text-align: left; font: inherit; border: 0; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
  .repo-commit-menu button:hover { background: var(--vscode-list-hoverBackground); }
  .repo-group-header .toolbar-icon { display: inline-grid; place-items: center; flex: 0 0 22px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; }
  .repo-group-header .toolbar-icon:hover:not(:disabled), .repo-file-row .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .repo-group-header .toolbar-icon:disabled { opacity: .32; cursor: default !important; }
  .repo-group-header .toolbar-icon.merge-action-blocked { opacity: .52; cursor: pointer !important; }
  .repo-group-header .toolbar-icon:focus-visible, .repo-file-row .toolbar-icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-group + .repo-group { margin-top: 7px; }
  .repo-group-header { display: flex; height: 28px; align-items: center; gap: 0; min-width: 0; color: var(--vscode-descriptionForeground); }
  .repo-group-toggle { display: flex; flex: 1; gap: 5px; align-items: center; min-width: 0; height: 26px; padding: 0 2px; border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--vscode-font-size, 13px); font-weight: 600; text-align: left; cursor: pointer; }
  .repo-group-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  /* Count pill: a full-radius capsule with the same side padding for 1, 2 and 3 digits; tabular digits keep every 2-digit count the same width. */
  .repo-count { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 5px 1px; border-radius: 8px; font-size: calc(var(--vscode-font-size, 13px) - 2px); line-height: 1; font-variant-numeric: tabular-nums; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .repo-count > span { display: block; line-height: 1; }
  /* Trim the line box to the cap height so the digits are centred as drawn, not as laid out; the 1px bottom padding above is the fallback. */
  @supports (text-box: trim-both cap alphabetic) {
    .repo-count { padding-bottom: 0; }
    .repo-count > span { text-box: trim-both cap alphabetic; }
  }
  .repo-group-toggle .repo-count { flex: none; font-weight: normal; }
  .repo-group-files { min-width: 0; }
  .repo-folder-toggle { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 25px; padding: 0 5px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .repo-folder-toggle:hover { background: var(--vscode-list-hoverBackground); }
  .repo-folder-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-folder-files { padding-left: 16px; }
  .repo-folder-files[hidden] { display: none; }
  .repo-folder-files .repo-file-folder { display: none; }
  .repo-file-row { display: flex; align-items: center; height: 25px; min-width: 0; }
  .repo-file { display: flex; flex: 1; align-items: center; height: 25px; gap: 6px; min-width: 0; padding: 0 5px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .repo-file-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 16px; width: 16px; height: 16px; line-height: 16px; }
  .repo-file-seti-icon { font-family: 'seti'; font-size: 18px; font-style: normal; font-weight: normal; -webkit-font-smoothing: antialiased; }
  .repo-file-name { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-file-folder { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .repo-file-status { flex: 0 0 13px; text-align: center; margin-left: auto; }
  .repo-file-row .toolbar-icon { width: 22px; height: 22px; flex: 0 0 22px; border: 0; cursor: pointer; }
  .repo-file-actions { display: none; align-items: center; align-self: stretch; gap: 0; border-radius: 0 3px 3px 0; }
  .repo-file-row .repo-open-file { display: none; }
  .repo-file-row.selected .repo-open-file, .repo-file-row.multi-selected .repo-open-file { display: inline-grid; place-items: center; }
  .repo-file-row .repo-open-file:disabled { opacity: .32; cursor: default; }
  .repo-file-row:hover .repo-file-actions,
  .repo-file-row.selected .repo-file-actions,
  .repo-file-row.multi-selected .repo-file-actions,
  .repo-file-row.context-target .repo-file-actions { display: flex; }
  .repo-file-row.selected .repo-file-actions,
  .repo-file-row.multi-selected .repo-file-actions,
  .repo-file-row.context-target .repo-file-actions { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .repo-file-row.selected .repo-file-actions .toolbar-icon,
  .repo-file-row.multi-selected .repo-file-actions .toolbar-icon,
  .repo-file-row.context-target .repo-file-actions .toolbar-icon { color: inherit; }
  .repo-file-row:is(.selected, .multi-selected, .context-target) .toolbar-icon:hover:not(:disabled) { background: color-mix(in srgb, currentColor 20%, transparent); border-radius: 3px; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 35%, transparent); }
  #repositoryGroupContextMenu, #repositoryMessageContextMenu { position: fixed; z-index: 20; box-sizing: border-box; width: max-content; min-width: 160px; max-width: calc(100vw - 8px); max-height: calc(100vh - 8px); overflow-y: auto; margin: 0; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  #repositoryGroupContextMenu:not(:popover-open), #repositoryMessageContextMenu:not(:popover-open) { display: none; }
  #repositoryGroupContextMenu button, #repositoryMessageContextMenu button { display: block; box-sizing: border-box; width: 100%; max-width: 100%; padding: 5px 8px; border: 0; border-radius: 3px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; text-align: left; font: inherit; }
  #repositoryGroupContextMenu button:hover, #repositoryMessageContextMenu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground)); }
  #repositoryFileContextMenu .repository-file-change-action { display: flex; align-items: center; gap: 6px; }
  #repositoryFileContextMenu .repository-file-change-action .codicon { flex: 0 0 16px; width: 16px; text-align: center; }
  .repo-file-row:hover { background: var(--vscode-list-hoverBackground); border-radius: 3px; }
  .repo-file-row.selected, .repo-file-row.multi-selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-radius: 3px; }
  .repo-file-row.context-target, .repo-group-header.context-target { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-radius: 3px; outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-file-row.selected .repo-file-folder, .repo-file-row.multi-selected .repo-file-folder { color: inherit; opacity: .8; }
  .repo-file.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
`;
export const REPOSITORY_CHANGES_SCRIPT = String.raw`
  let repositoryChanges = [];
  let selectedRepositoryCommitDetails = null;
  let pendingRepositoryFileSelection = null;
  let highlightedRepositoryFileRow = null;
  const repositoryChangesNodes = new Map();
  const repositoryDisplaySnapshots = new Map();
  let repositoryCardDisplayLocks = new Set();
  let repositoryGroupContextTarget = null;
  let repositoryMessageContextTarget = null;
  let repositoryFileContextTarget = null;
  let repositoryGroupContextHeader = null;
  let repositoryFileContextRow = null;
  const repositoryGroupContextMenu = document.createElement('div');
  repositoryGroupContextMenu.id = 'repositoryGroupContextMenu'; repositoryGroupContextMenu.setAttribute('popover', 'manual'); document.body.append(repositoryGroupContextMenu);
  const repositoryMessageContextMenu = document.createElement('div');
  repositoryMessageContextMenu.id = 'repositoryMessageContextMenu'; repositoryMessageContextMenu.setAttribute('popover', 'manual'); repositoryMessageContextMenu.innerHTML = '<button type="button" data-repository-message-action="cut">剪切</button><button type="button" data-repository-message-action="copy">复制</button><button type="button" data-repository-message-action="paste">粘贴</button><div class="context-menu-separator"></div><button type="button" data-repository-message-action="selectAll">全选</button>'; document.body.append(repositoryMessageContextMenu);
  const repositoryFileContextMenu = createFileContextMenu('repositoryFileContextMenu');
  const repositoryChangesCollapsed = new Set();
  // A collapse wins over in-flight focus snapshots until the host confirms deselection.
  const repositoryChangesBlurPending = new Set();
  const repositoryChangesInitialized = new Set();
  const repositoryGroupsCollapsed = new Set();
  const repositoryFoldersCollapsed = new Set();
  const repositoryDrafts = new Map();
  // Multi-selection belongs to one repository card and one snapshot (the worktree or a single commit); only one card holds it at a time.
  const repositorySelectedFiles = new Map();
  const repositorySelectionAnchors = new Map();
  const repositorySelectionScopes = new Map();
  function repositorySelectionKey(section, filePath) { return section + String.fromCharCode(0) + filePath; }
  function repositorySelectionParts(key) { const separator = key.indexOf(String.fromCharCode(0)); return { section: key.slice(0, separator), path: key.slice(separator + 1) }; }
  // Rows of a group in display order. A Shift range follows what the user sees, and tree mode lists rows folder by folder.
  function repositoryGroupRows(group) {
    return Array.from(group.querySelectorAll('.repo-file-row')).filter(function(row) { return !row.closest('.repo-folder-files[hidden]'); });
  }
  // A file acts together with the selection only when it belongs to it; otherwise it acts alone.
  function repositorySelectedPaths(repositoryPath, section, filePath, group) {
    const selected = repositorySelectedFiles.get(repositoryPath);
    if (!filePath || !selected || !selected.has(repositorySelectionKey(section, filePath))) return filePath ? [filePath] : [];
    return Array.from(group.querySelectorAll('.repo-file-row'))
      .map(function(row) { return row.dataset.filePath; })
      .filter(function(path) { return selected.has(repositorySelectionKey(section, path)); });
  }
  function syncRepositoryMultiSelectionClasses(node, repositoryPath) {
    const selected = repositorySelectedFiles.get(repositoryPath);
    node.groups.querySelectorAll('.repo-file-row').forEach(function(row) {
      const group = row.closest('.repo-group');
      row.classList.toggle('multi-selected', Boolean(selected && group && selected.has(repositorySelectionKey(group.dataset.section, row.dataset.filePath))));
    });
  }
  function clearRepositorySelection(repositoryPath) {
    repositorySelectedFiles.delete(repositoryPath); repositorySelectionAnchors.delete(repositoryPath);
  }
  // A different snapshot (another commit, or worktree vs commit) never inherits the previous selection. Returns whether one was dropped.
  function syncRepositorySelectionScope(repositoryPath, snapshot) {
    const scope = snapshot.kind === 'commit' ? 'commit:' + snapshot.commit.hash : 'worktree';
    if (repositorySelectionScopes.get(repositoryPath) === scope) return false;
    repositorySelectionScopes.set(repositoryPath, scope);
    const hadSelection = repositorySelectedFiles.has(repositoryPath);
    clearRepositorySelection(repositoryPath);
    return hadSelection;
  }
  // Files that left their group (staged, discarded, committed) drop out of the selection.
  function pruneRepositorySelection(repositoryPath, sections) {
    const selected = repositorySelectedFiles.get(repositoryPath);
    if (!selected) return;
    const available = new Set();
    sections.forEach(function(section) { section.files.forEach(function(file) { available.add(repositorySelectionKey(section.key, file.path)); }); });
    selected.forEach(function(key) { if (!available.has(key)) selected.delete(key); });
    const anchor = repositorySelectionAnchors.get(repositoryPath);
    if (anchor && !available.has(anchor)) repositorySelectionAnchors.delete(repositoryPath);
    if (!selected.size) clearRepositorySelection(repositoryPath);
  }
  // Plain click selects one file, Ctrl / Cmd toggles it, Shift selects the range from the last clicked file within the same group.
  function updateRepositoryFileSelection(node, repositoryPath, section, filePath, row, event) {
    repositorySelectedFiles.forEach(function(_selected, otherPath) {
      if (otherPath === repositoryPath) return;
      clearRepositorySelection(otherPath);
      const otherNode = repositoryChangesNodes.get(otherPath);
      if (otherNode) syncRepositoryMultiSelectionClasses(otherNode, otherPath);
    });
    let selected = repositorySelectedFiles.get(repositoryPath);
    if (!selected) { selected = new Set(); repositorySelectedFiles.set(repositoryPath, selected); }
    const key = repositorySelectionKey(section, filePath);
    const additive = event.ctrlKey || event.metaKey;
    const anchorKey = repositorySelectionAnchors.get(repositoryPath);
    const anchor = anchorKey ? repositorySelectionParts(anchorKey) : null;
    const rows = event.shiftKey && anchor && anchor.section === section ? repositoryGroupRows(row.closest('.repo-group')) : [];
    const from = rows.findIndex(function(item) { return item.dataset.filePath === anchor.path; });
    const to = rows.indexOf(row);
    if (from >= 0 && to >= 0) {
      if (!additive) selected.clear();
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++) selected.add(repositorySelectionKey(section, rows[index].dataset.filePath));
    } else if (additive) {
      if (selected.has(key)) selected.delete(key); else selected.add(key);
    } else {
      selected.clear(); selected.add(key);
    }
    repositorySelectionAnchors.set(repositoryPath, key);
    syncRepositoryMultiSelectionClasses(node, repositoryPath);
  }
  function resizeRepositoryTextArea(input, borderHeight) {
    const container = input.parentElement;
    const minHeight = container.style.minHeight;
    // Keep the scroll extent stable while measuring an auto-height editor at the list bottom.
    container.style.minHeight = container.offsetHeight + 'px';
    try {
      input.style.height = 'auto';
      input.style.height = (input.scrollHeight + borderHeight) + 'px';
    } finally {
      container.style.minHeight = minHeight;
    }
  }
  function resizeRepositoryMessage(input) {
    if (!input.isConnected || input.closest('.repo-changes-body').hidden || input.closest('.repo-message-box').hidden) return;
    resizeRepositoryTextArea(input, 0);
  }
  function resizeRepositoryCommitDetails(input) {
    if (!input.isConnected || input.hidden || input.closest('.repo-changes-body').hidden) return;
    resizeRepositoryTextArea(input, 2);
  }
  let focusedRepositoryChangesPath = '';
  let repositoryChangesRevealPath = '';
  function applyRepositoryChangesSelectionSnapshot(paths) {
    selectedRepositoryPaths = paths;
    repositoryChangesBlurPending.forEach(function(repositoryPath) {
      if (!paths.includes(repositoryPath)) repositoryChangesBlurPending.delete(repositoryPath);
    });
  }
  function revealRepositoryChanges(repositoryPath) {
    repositoryChangesBlurPending.delete(repositoryPath);
    repositoryChangesCollapsed.delete(repositoryPath);
    focusedRepositoryChangesPath = repositoryPath;
    repositoryChangesRevealPath = repositoryPath;
    renderRepositoryChanges();
  }
  // A card that is already expanded and showing its worktree Commit editor, for a repository that has
  // changed files, ends on that same editor once the host has selected the repository. Hiding the editor
  // and Commit button meanwhile would only make them blink (and drop focus from a clicked editor).
  // Clean repositories still lock: the host moves them to their latest commit, where no editor is shown.
  function repositoryKeepsCommitControls(node, repository) {
    if (!node || !repository || node.card.classList.contains('transitioning')) return false;
    if ((repository.staged || []).length + (repository.unstaged || []).length === 0) return false;
    return !node.card.querySelector('.repo-changes-body').hidden
      && !node.card.querySelector('.repo-message-box').hidden
      && !node.card.querySelector('.repo-commit-actions').hidden;
  }
  function focusRepositoryChanges(repositoryPath) {
    if (repositoryChangesCollapsed.has(repositoryPath) || focusedRepositoryChangesPath === repositoryPath) return;
    repositoryChangesBlurPending.delete(repositoryPath);
    const keepControls = repositoryKeepsCommitControls(repositoryChangesNodes.get(repositoryPath),
      repositoryChanges.find(function(item) { return item.repositoryPath === repositoryPath; }));
    // Otherwise hide Commit controls in the same event turn as expansion; the host later confirms
    // the lock and preserves it until a complete historical snapshot is available.
    if (!keepControls) repositoryCardDisplayLocks.add(repositoryPath);
    focusedRepositoryChangesPath = repositoryPath;
    repositoryChangesNodes.forEach(function(node, path) {
      node.card.classList.toggle('focused', path === repositoryPath);
      if (path === repositoryPath && !keepControls) node.card.classList.add('transitioning');
    });
    vscode.postMessage({ type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositoryPath });
  }
  function repoChangesIcon(action, icon, title) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toolbar-icon'; button.dataset.repoAction = action;
    button.title = title; button.setAttribute('aria-label', title);
    button.innerHTML = '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span>';
    return button;
  }
  function decorateRepositoryFileChangeActions(menu, section, includeStash) {
    const iconByAction = { stage: 'add', unstage: 'remove', discard: 'discard', stash: 'inbox', restoreStash: 'discard' };
    if (includeStash) {
      const separator = menu.querySelector('[data-file-change-item].context-menu-separator');
      if (separator) {
        const stash = document.createElement('button');
        stash.type = 'button'; stash.dataset.fileChangeAction = 'stash'; stash.setAttribute('data-file-change-item', '');
        stash.textContent = section === 'staged' ? 'Stash 已暂存的更改' : 'Stash 未暂存的更改';
        separator.before(stash);
      }
    }
    menu.querySelectorAll('[data-file-change-action]').forEach(function(button) {
      const icon = iconByAction[button.dataset.fileChangeAction];
      if (!icon) return;
      button.classList.add('repository-file-change-action');
      const glyph = document.createElement('span');
      glyph.className = 'codicon codicon-' + icon; glyph.setAttribute('aria-hidden', 'true');
      button.prepend(glyph);
    });
  }
  function decorateRepositoryStashRestoreAction(menu) {
    const separator = menu.querySelector('.context-menu-separator');
    if (!separator) return;
    const restore = document.createElement('button');
    restore.type = 'button'; restore.dataset.fileChangeAction = 'restoreStash'; restore.setAttribute('data-file-change-item', '');
    restore.classList.add('repository-file-change-action');
    restore.innerHTML = '<span class="codicon codicon-discard" aria-hidden="true"></span><span>还原贮藏</span>';
    separator.before(restore);
  }
  function closeRepositoryGroupContextMenu() { if (repositoryGroupContextMenu.matches(':popover-open')) repositoryGroupContextMenu.hidePopover(); if (repositoryGroupContextHeader) repositoryGroupContextHeader.classList.remove('context-target'); repositoryGroupContextHeader = null; repositoryGroupContextTarget = null; }
  function closeRepositoryMessageContextMenu() { if (repositoryMessageContextMenu.matches(':popover-open')) repositoryMessageContextMenu.hidePopover(); repositoryMessageContextTarget = null; }
  function closeRepositoryFileContextMenu() { if (repositoryFileContextMenu.matches(':popover-open')) repositoryFileContextMenu.hidePopover(); if (repositoryFileContextRow) repositoryFileContextRow.classList.remove('context-target'); repositoryFileContextRow = null; repositoryFileContextTarget = null; }
  function positionRepositoryContextMenu(menu, event) {
    menu.showPopover();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - bounds.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - bounds.height - 4)) + 'px';
  }
  function showRepositoryGroupContextMenu(event, header) {
    const card = header.closest('.repo-changes'); const group = header.closest('.repo-group');
    const section = group?.dataset.section;
    if (!card || (section !== 'unstaged' && section !== 'staged')) return;
    event.preventDefault();
    closeAllContextMenus(repositoryGroupContextMenu);
    repositoryGroupContextHeader = header; header.classList.add('context-target');
    repositoryGroupContextTarget = { repositoryPath: card.dataset.repositoryPath, section: section };
    repositoryGroupContextMenu.innerHTML = section === 'unstaged'
      ? '<button type="button" data-repository-group-action="discard">放弃所有更改</button><button type="button" data-repository-group-action="stage">暂存所有更改</button>'
      : '<button type="button" data-repository-group-action="discardStaged">放弃所有更改</button>';
    positionRepositoryContextMenu(repositoryGroupContextMenu, event);
  }
  function showRepositoryMessageContextMenu(event, input) {
    event.preventDefault(); closeAllContextMenus(repositoryMessageContextMenu);
    repositoryMessageContextTarget = input;
    positionRepositoryContextMenu(repositoryMessageContextMenu, event);
  }
  function showRepositoryFileContextMenu(event, row) {
    const card = row.closest('.repo-changes'); const group = row.closest('.repo-group'); const section = group?.dataset.section;
    if (!card || !section) return;
    const repositoryPath = card.dataset.repositoryPath; const filePath = row.dataset.filePath;
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === repositoryPath; });
    const snapshot = repository && repositoryDisplaySnapshots.get(repositoryPath);
    const historical = section === 'commit' && snapshot?.kind === 'commit';
    const candidates = historical ? snapshot.files : repository && (section === 'staged' ? repository.staged : repository.unstaged);
    const file = candidates && candidates.find(function(item) { return item.path === filePath; });
    if (!file) return;
    // Right-clicking a selected file targets the whole selection of its group; any other file targets itself and keeps the selection.
    const files = repositorySelectedPaths(repositoryPath, section, filePath, group)
      .map(function(path) { return candidates.find(function(item) { return item.path === path; }); }).filter(Boolean);
    const paths = files.map(function(item) { return item.path; });
    const untrackedPaths = files.filter(function(item) { return item.isUntracked; }).map(function(item) { return item.path; });
    event.preventDefault(); closeAllContextMenus(repositoryFileContextMenu);
    repositoryFileContextRow = row; row.classList.add('context-target');
    repositoryFileContextTarget = historical ? { kind: 'commit', hash: snapshot.commit.hash, isStash: snapshot.commit.isStash === true, repositoryPath: repositoryPath, path: filePath, paths: paths }
      : { kind: 'worktree', repositoryPath: repositoryPath, section: section, path: filePath, paths: paths, untrackedPaths: untrackedPaths };
    applyFileContextMenuStateForFiles(repositoryFileContextMenu, files, historical ? 'commit' : section);
    if (!historical && (section === 'unstaged' || section === 'staged')) {
      const hasConflicts = repository.staged.concat(repository.unstaged).some(function(item) { return item.isConflict; });
      decorateRepositoryFileChangeActions(repositoryFileContextMenu, section, !hasConflicts);
    } else if (historical && snapshot.commit.isStash === true) {
      decorateRepositoryStashRestoreAction(repositoryFileContextMenu);
    }
    positionRepositoryContextMenu(repositoryFileContextMenu, event);
  }
  const repositoryFallbackSetiIconDefinitions = {
    default: ['E023', '#d4d7d6'], c: ['E00C', '#519aba'], cHeader: ['E00C', '#a074c4'], cpp: ['E01A', '#519aba'], cppHeader: ['E01A', '#a074c4'],
    objectiveC: ['E00C', '#cbcb41'], objectiveCpp: ['E01A', '#cbcb41'], csharp: ['E00B', '#519aba'], fsharp: ['E02E', '#519aba'],
    kotlin: ['E058', '#e37933'], java: ['E050', '#cc3e44'], groovy: ['E03D', '#8dc149'], gradle: ['E03C', '#519aba'], rust: ['E082', '#6d8086'],
    typescript: ['E099', '#519aba'], react: ['E07D', '#519aba'], javascript: ['E051', '#cbcb41'], python: ['E07B', '#519aba'], go: ['E03A', '#519aba'],
    html: ['E048', '#e37933'], css: ['E01D', '#519aba'], sass: ['E084', '#f55385'], less: ['E059', '#519aba'], vue: ['E09D', '#8dc149'], svelte: ['E090', '#cc3e44'],
    json: ['E055', '#cbcb41'], markdown: ['E060', '#519aba'], image: ['E04C', '#a074c4'], svg: ['E091', '#a074c4'], audio: ['E005', '#a074c4'], video: ['E09B', '#f55385'],
    pdf: ['E06D', '#cc3e44'], zip: ['E0A9', '#6d8086'], archive: ['E0A9', '#cc3e44'], database: ['E022', '#f55385'], shell: ['E089', '#8dc149'],
    powershell: ['E074', '#519aba'], windows: ['E0A2', '#519aba'], hex: ['E047', '#cc3e44'], config: ['E019', '#6d8086'], xml: ['E0A5', '#e37933'], yaml: ['E0A7', '#a074c4'], csv: ['E01E', '#8dc149'],
    docker: ['E025', '#519aba'], makefile: ['E05F', '#e37933'], jenkins: ['E052', '#cc3e44'], info: ['E04D', '#519aba'], license: ['E05A', '#cbcb41'],
    npm: ['E067', '#41535b'], yarn: ['E0A6', '#519aba'], tsconfig: ['E097', '#519aba'], git: ['E034', '#41535b'], dart: ['E021', '#519aba'], php: ['E070', '#a074c4'], ruby: ['E081', '#cc3e44'], swift: ['E092', '#e37933'], lua: ['E05E', '#519aba'],
  };
  let repositorySetiIconDefinitions = repositoryFallbackSetiIconDefinitions;
  const repositorySetiDefinitionsNode = document.getElementById('gitk-seti-icon-definitions');
  if (repositorySetiDefinitionsNode?.textContent) {
    try {
      repositorySetiIconDefinitions = Object.assign({}, repositoryFallbackSetiIconDefinitions, JSON.parse(repositorySetiDefinitionsNode.textContent));
    } catch {
      repositorySetiIconDefinitions = repositoryFallbackSetiIconDefinitions;
    }
  }
  const repositorySetiExtensionIcons = {
    c: 'c', h: 'cHeader', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cppHeader', hh: 'cppHeader', hxx: 'cppHeader', m: 'objectiveC', mm: 'objectiveCpp',
    kt: 'kotlin', kts: 'kotlin', java: 'java', groovy: 'groovy', gradle: 'gradle', rs: 'rust', ts: 'typescript', tsx: 'react', js: 'javascript', jsx: 'react', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyw: 'python', go: 'go', cs: 'csharp', fs: 'fsharp', fsx: 'fsharp', vb: 'csharp', dart: 'dart', php: 'php', rb: 'ruby', swift: 'swift', lua: 'lua',
    html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', css: 'css', scss: 'sass', sass: 'sass', less: 'less',
    json: 'json', jsonc: 'json', 'code-workspace': 'json', md: 'markdown', mdx: 'markdown', markdown: 'markdown', rst: 'markdown', adoc: 'markdown',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image', svg: 'svg',
    mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', mp4: 'video', mov: 'video', webm: 'video', avi: 'video', mkv: 'video',
    pdf: 'pdf', zip: 'zip', '7z': 'zip', rar: 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip', tgz: 'zip', jar: 'archive', war: 'archive',
    db: 'database', sqlite: 'database', sqlite3: 'database', sql: 'database', mdb: 'database', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    ps1: 'powershell', psm1: 'powershell', bat: 'windows', cmd: 'windows', exe: 'hex', dll: 'hex', so: 'hex', dylib: 'hex', bin: 'hex', class: 'hex', o: 'hex', obj: 'hex', a: 'hex',
    yaml: 'yaml', yml: 'yaml', toml: 'config', xml: 'xml', ini: 'config', conf: 'config', cfg: 'config', properties: 'config', env: 'config', csv: 'csv', tsv: 'csv',
  };
  const repositorySetiFileNameIcons = {
    dockerfile: 'docker', makefile: 'makefile', 'cmakelists.txt': 'makefile', jenkinsfile: 'jenkins', gradlew: 'shell', 'gradlew.bat': 'windows',
    readme: 'info', 'readme.md': 'info', license: 'license', 'license.txt': 'license', notice: 'info', authors: 'info', changelog: 'info',
    '.gitignore': 'git', '.gitattributes': 'git', '.editorconfig': 'config', '.clangd': 'config', '.npmrc': 'npm', '.yarnrc': 'yarn',
    'package.json': 'npm', 'package-lock.json': 'npm', 'yarn.lock': 'yarn', 'tsconfig.json': 'tsconfig', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
  };
  function repositoryFileIconHTML(file) {
    if (file.isGitlink) {
      const icon = file.gitlinkHasSubmodules === false ? 'archive' : 'repo';
      return '<span class="repo-file-icon codicon codicon-' + icon + '" data-file-icon="' + icon + '" aria-hidden="true"></span>';
    }
    const path = String(file.path || '').replace(/\\/g, '/');
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot + 1) : '';
    const iconName = repositorySetiFileNameIcons[name] || repositorySetiExtensionIcons[extension] || 'default';
    const definition = repositorySetiIconDefinitions[iconName] || repositorySetiIconDefinitions.default;
    return '<span class="repo-file-icon repo-file-seti-icon" data-file-icon="' + iconName + '" style="color:' + definition[1] + '" aria-hidden="true">&#x' + definition[0] + ';</span>';
  }
  function repoChangesSections(repository) {
    const conflicts = new Map();
    (repository.staged || []).concat(repository.unstaged || []).forEach(function(file) {
      if (file.isConflict) conflicts.set(file.path, file);
    });
    return [
      { key: 'conflict', label: 'Merge Changes', files: Array.from(conflicts.values()) },
      { key: 'unstaged', label: 'Unstaged Changes', files: (repository.unstaged || []).filter(function(file) { return !file.isConflict; }) },
      { key: 'staged', label: 'Staged Changes', files: (repository.staged || []).filter(function(file) { return !file.isConflict; }) }
    ];
  }
  function createRepositoryChangesNode(repository) {
    const card = document.createElement('section'); card.className = 'repo-changes'; card.dataset.repositoryPath = repository.repositoryPath; card.tabIndex = -1;
    card.innerHTML = '<div class="repo-changes-header"><button type="button" class="repo-changes-toggle" data-repo-action="toggle"><span class="codicon codicon-chevron-down repo-chevron"></span></button><div class="repo-changes-title"><span class="repo-changes-icon"></span><span class="repo-changes-label"></span><span class="repo-changes-ancestry" hidden></span></div><button type="button" class="repo-changes-branch" data-repo-action="branch"><span class="codicon codicon-git-branch"></span><span class="repo-changes-head"></span><span class="repo-changes-head-dirty" hidden>*</span></button></div><div class="repo-changes-body"><div class="repo-message-box"><textarea class="repo-message" rows="1" spellcheck="false"></textarea></div><div class="repo-commit-actions"><button type="button" class="repo-commit-main" data-repo-action="commit"><span class="repo-commit-label">Commit</span></button><button type="button" class="repo-commit-more" data-repo-action="menu" title="更多提交操作" aria-label="更多提交操作"><span class="codicon codicon-chevron-down"></span></button><div class="repo-commit-menu" hidden></div></div><div class="repo-file-groups"></div></div>';
    const header = card.querySelector('.repo-changes-header');
    const details = document.createElement('textarea'); details.className = 'repo-commit-details'; details.hidden = true;
    details.readOnly = true; details.rows = 1; details.spellcheck = false;
    details.setAttribute('aria-label', '提交标题与描述');
    card.querySelector('.repo-changes-body').insertBefore(details, card.querySelector('.repo-message-box'));
    [['repoPull', 'repo-pull', 'Pull'], ['repoPush', 'repo-push', 'Push'], ['worktree', 'compare-changes', 'Changed']].forEach(function(item) {
      const button = repoChangesIcon(item[0], item[1], item[2]);
      button.classList.add('repo-sync');
      const count = document.createElement('span'); count.className = 'repo-sync-count'; button.appendChild(count);
      header.append(button);
    });
    header.append(repoChangesIcon('terminal', 'terminal', '在终端中打开此仓库'));
    const menu = card.querySelector('.repo-commit-menu');
    [['commit', 'Commit'], ['amend', 'Commit (Amend)'], ['push', 'Commit & Push'], ['syncCommit', 'Commit & Sync']].forEach(function(item) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.repoAction = item[0]; button.textContent = item[1]; menu.appendChild(button);
    });
    return { card: card, input: card.querySelector('.repo-message'), groups: card.querySelector('.repo-file-groups'), groupsKey: '', rowsByDiffKey: new Map(), message: undefined };
  }
  function repositoryAncestryLabel(ancestry) {
    const labels = (ancestry || []).map(function(ancestor) { return ancestor && ancestor.label; }).filter(Boolean);
    if (labels.length <= 2) return labels.join('/');
    return labels[0] + '/.../' + labels[labels.length - 1];
  }
  function updateRepositoryDisplaySnapshot(state) {
    const commit = state.selectedCommit;
    if (!commit || !commit.repositoryPath || !commit.hash) return;
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === commit.repositoryPath; });
    if (!repository) return;
    if (isWorkingTreeHash(commit.hash)) {
      // A card-click may temporarily select the remembered worktree identity. The host owns
      // the display lock and releases it once the card's final selection is chosen.
      if (repositoryCardDisplayLocks.has(commit.repositoryPath)) return;
      repositoryDisplaySnapshots.set(commit.repositoryPath, { kind: 'worktree' });
      return;
    }
    // Loading/failed reads are not empty commits. File ownership can lag controller selection.
    if (state.filesLoading || state.diffError || !Array.isArray(state.files)) return;
    const identity = state.filesIdentity;
    if (identity && (identity.repositoryPath !== commit.repositoryPath || identity.hash !== commit.hash)) return;
    repositoryDisplaySnapshots.set(commit.repositoryPath, {
      kind: 'commit', commit: { ...commit }, files: state.files.map(function(file) { return { ...file }; })
    });
  }
  function currentRepositorySnapshot(node, repository) {
    // Rendering never mutates historical snapshots; worktrees use their own live repository data.
    const snapshot = repositoryDisplaySnapshots.get(repository.repositoryPath);
    return snapshot && snapshot.kind === 'commit' ? snapshot
      : { kind: 'worktree', staged: repository.staged || [], unstaged: repository.unstaged || [] };
  }
  function renderRepositoryFileGroups(node, repository) {
    const snapshot = currentRepositorySnapshot(node, repository);
    const displayRepository = snapshot.kind === 'worktree'
      ? { ...repository, staged: snapshot.staged || [], unstaged: snapshot.unstaged || [] }
      : repository;
    const stashSnapshot = snapshot.kind === 'commit' && snapshot.commit.isStash === true;
    let sections = snapshot.kind === 'commit'
      ? [{ key: 'commit', label: stashSnapshot ? '贮藏变更' : '提交变更 ' + snapshot.commit.hash.slice(0, 8), files: snapshot.files }]
      : repoChangesSections(displayRepository);
    const hasConflicts = sections.some(function(section) { return section.key === 'conflict' && section.files.length > 0; });
    const key = JSON.stringify([filesMode, repository.mergeOperation, repository.mergeOperationBusy, sections.map(function(section) { return [section.key, section.label, section.files]; })]);
    const selectionDropped = syncRepositorySelectionScope(repository.repositoryPath, snapshot);
    if (key === node.groupsKey) { if (selectionDropped) syncRepositoryMultiSelectionClasses(node, repository.repositoryPath); return; }
    pruneRepositorySelection(repository.repositoryPath, sections);
    node.groupsKey = key; node.groups.replaceChildren(); node.rowsByDiffKey.clear();
    sections.forEach(function(section) {
      if (!section.files.length && !(section.key === 'conflict' && repository.mergeOperation)) return;
      const group = document.createElement('div'); group.className = 'repo-group'; group.dataset.section = section.key;
      const header = document.createElement('div'); header.className = 'repo-group-header';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'repo-group-toggle'; toggle.dataset.repoAction = 'group';
      toggle.innerHTML = '<span class="codicon codicon-chevron-down"></span><span>' + escapeHtml(section.label) + '</span>';
      const badge = document.createElement('span'); badge.className = 'repo-count';
      const badgeText = document.createElement('span'); badgeText.textContent = String(section.files.length); badge.appendChild(badgeText);
      // Every group shows its count right after the title, inside the title button, so it never drifts toward the action icons.
      toggle.appendChild(badge); header.append(toggle);
      if (section.key === 'conflict') {
        const actions = document.createElement('span'); actions.style.cssText = 'display:flex;margin-left:auto;gap:2px';
        const hasMergeOperation = Boolean(repository.mergeOperation);
        const hasUnresolvedConflicts = section.files.length > 0;
        const proceedTitle = !hasMergeOperation ? '未找到可继续的冲突操作记录'
          : hasUnresolvedConflicts ? '请先解决并暂存所有冲突' : '继续当前合并操作';
        const proceed = repoChangesIcon('continue', 'check', proceedTitle);
        const abort = repoChangesIcon('abort', 'close', '中止当前冲突操作');
        proceed.disabled = Boolean(repository.mergeOperationBusy);
        proceed.classList.toggle('merge-action-blocked', (hasUnresolvedConflicts || !hasMergeOperation) && !repository.mergeOperationBusy);
        abort.disabled = Boolean(repository.mergeOperationBusy);
        actions.append(proceed, abort); header.append(actions);
      }
      if (stashSnapshot && section.key === 'commit') header.appendChild(repoChangesIcon('restoreStash', 'discard', '还原全部贮藏变更'));
      // stash 按钮位于“还原”(Unstaged) 和“取消暂存”(Staged) 的左侧。
      if (!hasConflicts && (section.key === 'unstaged' || section.key === 'staged')) header.appendChild(repoChangesIcon('stash', 'archive', section.key === 'staged' ? 'Stash 已暂存的更改' : 'Stash 未暂存的更改'));
      if (section.key === 'unstaged') header.appendChild(repoChangesIcon('discard', 'discard', '还原所有文件'));
      if (section.key !== 'conflict' && section.key !== 'commit') header.appendChild(repoChangesIcon(section.key === 'staged' ? 'unstage' : 'stage', section.key === 'staged' ? 'remove' : 'add', section.key === 'staged' ? '取消暂存全部' : '暂存全部'));
      const rows = document.createElement('div'); rows.className = 'repo-group-files';
      const folderRows = new Map();
      section.files.forEach(function(file) {
        const slash = file.path.lastIndexOf('/');
        const folder = slash < 0 ? '' : file.path.slice(0, slash);
        let container = rows;
        if (filesMode === 'tree' && folder) {
          container = folderRows.get(folder);
          if (!container) {
            const folderKey = JSON.stringify([repository.repositoryPath, section.key, folder]);
            const expanded = !repositoryFoldersCollapsed.has(folderKey);
            const wrapper = document.createElement('div'); wrapper.className = 'repo-folder'; wrapper.dataset.folderKey = folderKey;
            const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'repo-folder-toggle'; toggle.dataset.repoAction = 'folder';
            toggle.title = folder; toggle.setAttribute('aria-expanded', String(expanded));
            toggle.innerHTML = '<span class="codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="repo-folder-name">' + escapeHtml(folder) + '</span>';
            container = document.createElement('div'); container.className = 'repo-folder-files'; container.hidden = !expanded;
            wrapper.append(toggle, container); rows.appendChild(wrapper); folderRows.set(folder, container);
          }
        }
        const row = document.createElement('div'); row.className = 'repo-file-row'; row.dataset.filePath = file.path;
        row.dataset.diffKey = section.key === 'commit' ? (file.diffKey || file.path) : section.key + ':' + file.path;
        node.rowsByDiffKey.set(row.dataset.diffKey, row);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'repo-file'; button.dataset.repoAction = 'file'; button.title = file.path;
        button.innerHTML = repositoryFileIconHTML(file) + '<span class="repo-file-name">' + escapeHtml(file.path.slice(slash + 1)) + '</span><span class="repo-file-folder">' + escapeHtml(slash < 0 ? '' : file.path.slice(0, slash)) + '</span><span class="repo-file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>';
        row.appendChild(button);
        const actions = document.createElement('span'); actions.className = 'repo-file-actions';
        const openFile = repoChangesIcon('openFile', 'go-to-file', '打开文件');
        openFile.classList.add('repo-open-file');
        openFile.disabled = file.status === 'D' || Boolean(file.isGitlink);
        actions.appendChild(openFile);
        if (stashSnapshot && section.key === 'commit') actions.appendChild(repoChangesIcon('restoreStash', 'discard', '还原贮藏'));
        // 与分组头保持相同顺序；stash 与分组头一样在存在冲突时隐藏。
        if (!hasConflicts && (section.key === 'unstaged' || section.key === 'staged')) actions.appendChild(repoChangesIcon('stash', 'archive', section.key === 'staged' ? 'Stash 当前文件的已暂存更改' : 'Stash 当前文件的未暂存更改'));
        if (section.key === 'unstaged') actions.appendChild(repoChangesIcon('discard', 'discard', '放弃此文件变更'));
        if (section.key !== 'commit') actions.appendChild(repoChangesIcon(section.key === 'staged' ? 'unstage' : 'stage', section.key === 'staged' ? 'remove' : 'add', section.key === 'staged' ? '取消暂存' : '暂存'));
        row.appendChild(actions); container.appendChild(row);
      });
      group.append(header, rows); node.groups.appendChild(group);
    });
    syncRepositoryMultiSelectionClasses(node, repository.repositoryPath);
  }
  function updateRepositoryFolderVisibility(folder) {
    const expanded = !repositoryFoldersCollapsed.has(folder.dataset.folderKey);
    const toggle = folder.querySelector('.repo-folder-toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.querySelector('.codicon').className = 'codicon codicon-chevron-' + (expanded ? 'down' : 'right');
    toggle.querySelectorAll('.codicon')[1].className = 'codicon codicon-folder' + (expanded ? '-opened' : '');
    folder.querySelector('.repo-folder-files').hidden = !expanded;
  }
  function updateRepositoryChangesVisibility(node, repository) {
    const expanded = !repositoryChangesCollapsed.has(repository.repositoryPath);
    const toggle = node.card.querySelector('.repo-changes-toggle'); toggle.setAttribute('aria-expanded', String(expanded));
    toggle.querySelector('.repo-chevron').className = 'codicon repo-chevron codicon-chevron-' + (expanded ? 'down' : 'right');
    node.card.querySelector('.repo-changes-body').hidden = !expanded;
    if (expanded) resizeRepositoryMessage(node.input);
    if (expanded) resizeRepositoryCommitDetails(node.card.querySelector('.repo-commit-details'));
    node.card.querySelectorAll('.repo-group').forEach(function(group) {
      const collapsed = repositoryGroupsCollapsed.has(repository.repositoryPath + '\u0000' + group.dataset.section);
      group.querySelector('.repo-group-files').hidden = collapsed;
      group.querySelector('.repo-group-toggle .codicon').className = 'codicon codicon-chevron-' + (collapsed ? 'right' : 'down');
    });
  }
  function syncRepositoryFileSelection(reveal, repositoryPath, diffKey) {
    repositoryPath = repositoryPath === undefined ? selectedCommitRepositoryPath : repositoryPath;
    diffKey = diffKey === undefined ? selectedPath : diffKey;
    const node = repositoryChangesNodes.get(repositoryPath);
    const row = node && node.rowsByDiffKey.get(diffKey);
    if (highlightedRepositoryFileRow && highlightedRepositoryFileRow !== row) {
      highlightedRepositoryFileRow.classList.remove('selected');
      highlightedRepositoryFileRow.querySelector('.repo-file').classList.remove('selected');
    }
    highlightedRepositoryFileRow = row || null;
    if (!row) return;
    // While a multi-selection is active, the host's single selection only shows on a row that belongs to it.
    const showSelected = !repositorySelectionAnchors.has(repositoryPath) || row.classList.contains('multi-selected');
    row.classList.toggle('selected', showSelected); row.querySelector('.repo-file').classList.toggle('selected', showSelected);
    // File-selection feedback can arrive after the user has collapsed and blurred the card.
    // Reveal through this linkage only while repository selection still owns the focus.
    if (!reveal || focusedRepositoryChangesPath !== repositoryPath) return;
    repositoryChangesCollapsed.delete(repositoryPath);
    const group = row.closest('.repo-group');
    repositoryGroupsCollapsed.delete(repositoryPath + String.fromCharCode(0) + group.dataset.section);
    const folder = row.closest('.repo-folder');
    if (folder) {
      repositoryFoldersCollapsed.delete(folder.dataset.folderKey);
      updateRepositoryFolderVisibility(folder);
    }
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === repositoryPath; });
    if (repository) { updateRepositoryChangesVisibility(node, repository); updateRepositoryPinnedHeaders(); }
    // Scroll only the file-list viewport; MultiDiff feedback must not steal keyboard focus.
    const list = document.getElementById('repositoryChangesList');
    const bounds = list.getBoundingClientRect(); const target = row.getBoundingClientRect();
    if (target.top < bounds.top + list.clientTop) list.scrollTop += target.top - bounds.top - list.clientTop;
    else if (target.bottom > bounds.top + list.clientTop + list.clientHeight) list.scrollTop += target.bottom - bounds.top - list.clientTop - list.clientHeight;
  }
  function renderRepositoryChanges() {
    const list = document.getElementById('repositoryChangesList');
    const selectedRepositoryPath = selectedRepositoryPaths.length === 1 ? selectedRepositoryPaths[0] : '';
    focusedRepositoryChangesPath = repositoryChangesRevealPath
      || (selectedRepositoryPath && !repositoryChangesBlurPending.has(selectedRepositoryPath) ? selectedRepositoryPath : '');
    const paths = new Set(repositoryChanges.map(function(repository) { return repository.repositoryPath; }));
    repositoryChangesNodes.forEach(function(node, repositoryPath) { if (!paths.has(repositoryPath)) { node.card.remove(); repositoryChangesNodes.delete(repositoryPath); } });
    repositoryChanges.forEach(function(repository, index) {
      // Seed only once per repository; refresh and topology reordering preserve the user's choice.
      if (!repositoryChangesInitialized.has(repository.repositoryPath)) {
        repositoryChangesInitialized.add(repository.repositoryPath);
        if (repositoryChangesRevealPath !== repository.repositoryPath) repositoryChangesCollapsed.add(repository.repositoryPath);
      }
      let node = repositoryChangesNodes.get(repository.repositoryPath);
      if (!node) { node = createRepositoryChangesNode(repository); repositoryChangesNodes.set(repository.repositoryPath, node); }
      node.card.querySelector('.repo-changes-label').textContent = repository.repositoryLabel;
      const ancestry = node.card.querySelector('.repo-changes-ancestry');
      const ancestryLabel = repositoryAncestryLabel(repository.repositoryAncestry);
      ancestry.hidden = !ancestryLabel;
      ancestry.textContent = ancestryLabel;
      ancestry.title = ancestryLabel;
      const icon = node.card.querySelector('.repo-changes-icon');
      const iconKey = String(Boolean(repository.hasSubmodules)) + ':' + String(Boolean(repository.isSubmodule));
      if (icon.dataset.kind !== iconKey) {
        icon.dataset.kind = iconKey;
        icon.innerHTML = repositoryIcon(repository.hasSubmodules, repository.isSubmodule);
      }
      icon.title = repository.hasSubmodules ? '包含子仓库' : repository.isSubmodule ? '子仓库（无下级子仓库）' : '独立仓库（无子仓库）';
      const changeCount = new Set((repository.staged || []).concat(repository.unstaged || []).map(function(file) { return file.path; })).size;
      // 图标:游离 HEAD 用 git-commit;具名分支有未提交变更用 git-branch-changes,否则 git-branch。
      // 星号是独立节点,分支名过长被省略时星号仍然保留;变更数与同步状态共用 changeCount。
      const headDirty = changeCount !== 0;
      const headIcon = repository.headDetached ? 'git-commit' : headDirty ? 'git-branch-changes' : 'git-branch';
      const headIconNode = node.card.querySelector('.repo-changes-branch .codicon');
      if (headIconNode.dataset.icon !== headIcon) {
        headIconNode.dataset.icon = headIcon;
        headIconNode.className = 'codicon codicon-' + headIcon;
      }
      node.card.querySelector('.repo-changes-head').textContent = repository.headLabel || 'HEAD';
      node.card.querySelector('.repo-changes-head-dirty').hidden = !headDirty;
      const behindCount = Number.isFinite(repository.behindCount) ? Math.max(0, repository.behindCount) : 0;
      const aheadCount = Number.isFinite(repository.aheadCount) ? Math.max(0, repository.aheadCount) : 0;
      [['repoPull', behindCount, 'Pull：拉取 ' + behindCount + ' 个提交'],
        ['repoPush', aheadCount, 'Push：推送 ' + aheadCount + ' 个提交'],
        ['worktree', changeCount, 'Changed：' + changeCount + ' 个未提交变更文件']].forEach(function(item) {
        const button = node.card.querySelector('[data-repo-action="' + item[0] + '"]');
        button.querySelector('.repo-sync-count').textContent = String(item[1]);
        button.title = item[2];
        button.setAttribute('aria-label', repository.repositoryLabel + '：' + item[2]);
      });
      node.card.querySelector('.repo-changes-branch').title = '切换分支：' + (repository.headLabel || 'HEAD');
      node.card.querySelector('.repo-changes-branch').setAttribute('aria-label', repository.repositoryLabel + '：切换分支');
      node.card.querySelector('.repo-changes-title').title = repository.repositoryPath;
      node.card.querySelector('.repo-changes-toggle').setAttribute('aria-label', repository.repositoryLabel + '：展开或收起');
      node.card.classList.toggle('focused', focusedRepositoryChangesPath === repository.repositoryPath);
      node.input.placeholder = '提交信息';
      node.input.setAttribute('aria-label', repository.repositoryLabel + '：提交信息');
      node.input.title = '提交到 ' + (repository.headLabel || repository.repositoryLabel);
      const snapshot = currentRepositorySnapshot(node, repository);
      const historical = snapshot.kind === 'commit';
      // Evaluated before this pass touches the controls: it reads what the previous pass left on screen.
      const commitControlsLocked = repositoryCardDisplayLocks.has(repository.repositoryPath)
        && !repositoryKeepsCommitControls(node, repository);
      node.card.classList.toggle('transitioning', commitControlsLocked);
      const messageBox = node.card.querySelector('.repo-message-box');
      const actions = node.card.querySelector('.repo-commit-actions');
      const details = node.card.querySelector('.repo-commit-details');
      // Card focus keeps its existing selection flow, but it must not reinterpret an
      // asynchronous uncommitted selection as a request to reveal Commit controls.
      messageBox.hidden = Boolean(historical || commitControlsLocked);
      actions.hidden = Boolean(historical || commitControlsLocked);
      details.hidden = !historical;
      if (historical) {
        const metadata = snapshot.commit || {};
        if (details.dataset.commitHash !== metadata.hash) details.scrollTop = 0;
        details.dataset.commitHash = metadata.hash;
        // Strip terminal line breaks for display only; preserve the Git message and commit draft.
        const raw = typeof metadata.rawMessage === 'string' ? metadata.rawMessage : undefined;
        let value = raw === undefined ? (metadata.message || '') + (metadata.body ? String.fromCharCode(10, 10) + metadata.body : '') : raw;
        while (value.endsWith(String.fromCharCode(10)) || value.endsWith(String.fromCharCode(13))) value = value.slice(0, -1);
        if (details.value !== value) details.value = value;
        node.card.querySelector('.repo-commit-menu').hidden = true;
      }
      if (!repositoryDrafts.has(repository.repositoryPath)
          || (node.message !== repository.message && document.activeElement !== node.input)) {
        repositoryDrafts.set(repository.repositoryPath, repository.message || '');
      }
      node.message = repository.message;
      if (document.activeElement !== node.input) node.input.value = repositoryDrafts.get(repository.repositoryPath);
      const displayRepository = snapshot.kind === 'worktree' ? { ...repository, staged: snapshot.staged || [], unstaged: snapshot.unstaged || [] } : repository;
      const conflicts = repoChangesSections(displayRepository)[0].files.length > 0;
      const displayHasStagedChanges = (displayRepository.staged || []).length > 0;
      const disabled = historical || commitControlsLocked || conflicts || repository.committing || !node.input.value.trim() || !displayHasStagedChanges;
      node.card.querySelectorAll('.repo-commit-main, .repo-commit-menu button').forEach(function(button) { button.disabled = Boolean(disabled); });
      const commitButton = node.card.querySelector('.repo-commit-main');
      commitButton.title = conflicts ? '请先解决合并冲突' : 'Commit (Ctrl / ⌘ + Enter)';
      commitButton.setAttribute('aria-busy', String(Boolean(repository.committing)));
      node.card.querySelector('.repo-commit-label').textContent = repository.committing ? '提交中…' : 'Commit';
      node.card.querySelector('.repo-commit-more').disabled = Boolean(disabled);
      renderRepositoryFileGroups(node, repository); updateRepositoryChangesVisibility(node, repository);
      const at = list.children[index]; if (at !== node.card) list.insertBefore(node.card, at || null);
      resizeRepositoryMessage(node.input);
      resizeRepositoryCommitDetails(details);
    });
    syncRepositoryFileSelection(false);
    const revealed = repositoryChangesNodes.get(repositoryChangesRevealPath);
    if (revealed) {
      revealed.card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      // Focus the repository container, not its editor: navigation must not steal an input cursor.
      revealed.card.focus({ preventScroll: true });
      repositoryChangesRevealPath = '';
    }
    // Pinning reads every card's layout; batch the visibility updates above and measure once.
    updateRepositoryPinnedHeaders();
  }
  function updateRepositoryPinnedHeaders() {
    const list = document.getElementById('repositoryChangesList');
    const top = list.getBoundingClientRect().top + list.clientTop;
    repositoryChangesNodes.forEach(function(node) {
      // Only replace the card top border once it has scrolled completely out of view.
      node.card.querySelector('.repo-changes-header').classList.toggle('pinned', node.card.getBoundingClientRect().top + node.card.clientTop <= top);
    });
  }
  const repositoryChangesList = document.getElementById('repositoryChangesList');
  const repositoryChangesViewport = document.getElementById('repositoryChangesViewport');
  const repositoryChangesScrollbar = document.getElementById('repositoryChangesScrollbar');
  installOverlayScrollbars(repositoryChangesViewport, repositoryChangesList, [repositoryChangesScrollbar]);
  repositoryChangesList.addEventListener('scroll', updateRepositoryPinnedHeaders, { passive: true });
  const repositoryHeaderResizeObserver = new ResizeObserver(updateRepositoryPinnedHeaders);
  repositoryHeaderResizeObserver.observe(repositoryChangesList);
  window.addEventListener('resize', function() {
    repositoryChangesNodes.forEach(function(node) { resizeRepositoryMessage(node.input); resizeRepositoryCommitDetails(node.card.querySelector('.repo-commit-details')); });
    updateRepositoryPinnedHeaders();
  });
  repositoryChangesList.addEventListener('focusin', function(event) {
    const card = event.target.closest('.repo-changes');
    // Header controls manage their own expansion/action; focus inside an expanded body owns history.
    if (card && event.target.closest('button, textarea, input, select, a') && event.target.closest('.repo-changes-body, .repo-changes-branch')) focusRepositoryChanges(card.dataset.repositoryPath);
  });
  repositoryChangesList.addEventListener('pointerdown', function(event) {
    if (event.button !== 0) return;
    const card = event.target.closest('.repo-changes');
    if (card && event.target.closest('button, textarea, input, select, a') && event.target.closest('.repo-changes-body, .repo-changes-branch')) focusRepositoryChanges(card.dataset.repositoryPath);
  });
  document.addEventListener('click', function(event) {
    if (!event.target.closest('.repo-commit-actions')) repositoryChangesList.querySelectorAll('.repo-commit-menu').forEach(function(menu) { menu.hidden = true; });
    if (!event.target.closest('#repositoryGroupContextMenu')) closeRepositoryGroupContextMenu();
    if (!event.target.closest('#repositoryMessageContextMenu')) closeRepositoryMessageContextMenu();
    if (!event.target.closest('#repositoryFileContextMenu')) closeRepositoryFileContextMenu();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') repositoryChangesList.querySelectorAll('.repo-commit-menu').forEach(function(menu) { menu.hidden = true; });
    if (event.key === 'Escape') { closeRepositoryGroupContextMenu(); closeRepositoryMessageContextMenu(); closeRepositoryFileContextMenu(); }
  });
  repositoryChangesList.addEventListener('input', function(event) {
    if (!event.target.matches('.repo-message')) return;
    const repositoryPath = event.target.closest('.repo-changes').dataset.repositoryPath;
    repositoryDrafts.set(repositoryPath, event.target.value);
    vscode.postMessage({ type: 'updateCommitMessage', repositoryPath: repositoryPath, message: event.target.value });
    renderRepositoryChanges();
  });
  function postRepositoryCommit(card, action) {
    const button = card.querySelector('.repo-commit-main'); if (button.disabled || card.querySelector('.repo-message-box').hidden) return;
    vscode.postMessage({ type: 'workingTreeCommit', action: action === 'syncCommit' ? 'sync' : action, repositoryPath: card.dataset.repositoryPath, message: card.querySelector('.repo-message').value });
    card.querySelector('.repo-commit-menu').hidden = true;
  }
  repositoryChangesList.addEventListener('keydown', function(event) {
    if (event.target.matches('.repo-changes') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.target.click(); return;
    }
    if (event.target.matches('.repo-message') && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); postRepositoryCommit(event.target.closest('.repo-changes'), 'commit'); }
  });
  repositoryChangesList.addEventListener('click', function(event) {
    const card = event.target.closest('.repo-changes'); if (!card) return;
    const button = event.target.closest('[data-repo-action]');
    if (button && button.disabled) return;
    // An unfocused header selects first; clicking the focused header again toggles expansion.
    if (!button && event.target.closest('button, textarea, input, select, a, .repo-message-box, .repo-commit-details, .repo-file-row, .repo-group-header, .repo-commit-menu')) return;
    const repositoryPath = card.dataset.repositoryPath;
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === repositoryPath; }); if (!repository) return;
    const headerToggle = !button && event.target.closest('.repo-changes-header')
      && focusedRepositoryChangesPath === repositoryPath && !repositoryChangesCollapsed.has(repositoryPath);
    const action = button ? button.dataset.repoAction : headerToggle ? 'toggle' : 'select'; const node = repositoryChangesNodes.get(repositoryPath);
    if (action === 'folder') {
      const folder = button.closest('.repo-folder'); const key = folder.dataset.folderKey;
      if (repositoryFoldersCollapsed.has(key)) repositoryFoldersCollapsed.delete(key); else repositoryFoldersCollapsed.add(key);
      updateRepositoryFolderVisibility(folder); updateRepositoryPinnedHeaders(); return;
    }
    if (action === 'select') {
      repositoryChangesCollapsed.delete(repositoryPath);
      focusRepositoryChanges(repositoryPath);
      updateRepositoryChangesVisibility(node, repository);
      updateRepositoryPinnedHeaders();
      node.card.focus({ preventScroll: true });
      return;
    }
    if (action === 'toggle') {
      if (repositoryChangesCollapsed.has(repositoryPath)) repositoryChangesCollapsed.delete(repositoryPath); else repositoryChangesCollapsed.add(repositoryPath);
      if (repositoryChangesCollapsed.has(repositoryPath)) repositoryChangesBlurPending.add(repositoryPath);
      if (repositoryChangesCollapsed.has(repositoryPath) && focusedRepositoryChangesPath === repositoryPath) {
        focusedRepositoryChangesPath = '';
        repositoryChangesNodes.forEach(function(node) { node.card.classList.remove('focused'); });
        // Clear immediately, then confirm through the authoritative repository-selection pipeline.
        selectedRepositoryPaths = []; selectedBranches = []; commits = []; workingTreeRowsState = [];
        selectedCommitHash = ''; selectedCommitRepositoryPath = ''; isCommitLoading = false;
        hasMoreCommits = false; isLoadingMoreCommits = false;
        render(); hideLoadingProgress(); updateCountLabel();
      }
      if (repositoryChangesCollapsed.has(repositoryPath)) {
        // Any card collapse clears its repository-scoped branch cache, even when another card is focused.
        vscode.postMessage({ type: 'repositoryChangesAction', action: 'blur', repositoryPath: repositoryPath });
      }
      if (!repositoryChangesCollapsed.has(repositoryPath)) focusRepositoryChanges(repositoryPath);
      updateRepositoryChangesVisibility(node, repository); updateRepositoryPinnedHeaders(); return;
    }
    if (action === 'group') {
      const key = repositoryPath + '\u0000' + button.closest('.repo-group').dataset.section;
      if (repositoryGroupsCollapsed.has(key)) repositoryGroupsCollapsed.delete(key); else repositoryGroupsCollapsed.add(key);
      updateRepositoryChangesVisibility(node, repository); updateRepositoryPinnedHeaders(); return;
    }
    if (action === 'menu') { const menu = card.querySelector('.repo-commit-menu'); menu.hidden = !menu.hidden; return; }
    if (['commit', 'amend', 'push', 'syncCommit'].includes(action)) { postRepositoryCommit(card, action); return; }
    if (action === 'worktree') {
      card.classList.remove('transitioning');
      repositoryChangesBlurPending.delete(repositoryPath);
      repositoryChangesCollapsed.delete(repositoryPath);
      focusedRepositoryChangesPath = repositoryPath;
      repositoryChangesNodes.forEach(function(node, path) { node.card.classList.toggle('focused', path === repositoryPath); });
      updateRepositoryChangesVisibility(node, repository);
      updateRepositoryPinnedHeaders();
      vscode.postMessage({ type: 'repositoryChangesAction', action: 'worktree', repositoryPath: repositoryPath });
      return;
    }
    if (['repoPull', 'repoPush', 'branch', 'terminal'].includes(action)) { vscode.postMessage({ type: 'repositoryChangesAction', action: action, repositoryPath: repositoryPath }); return; }
    if (action === 'continue' || action === 'abort') { vscode.postMessage({ type: 'repositoryChangesAction', action: action, repositoryPath: repositoryPath }); return; }
    const group = button.closest('.repo-group'); const section = group.dataset.section;
    const fileRow = button.closest('.repo-file-row'); const filePath = fileRow && fileRow.dataset.filePath;
    if (action === 'file') {
      card.classList.remove('transitioning');
      const diffKey = fileRow.dataset.diffKey;
      updateRepositoryFileSelection(node, repositoryPath, section, filePath, fileRow, event);
      pendingRepositoryFileSelection = { repositoryPath: repositoryPath, diffKey: diffKey };
      pendingLocalFileSelectionPath = diffKey;
      if (selectedCommitRepositoryPath === repositoryPath) selectedPath = diffKey;
      syncRepositoryFileSelection(false, repositoryPath, diffKey);
      if (section === 'commit') vscode.postMessage({ type: 'selectFile', path: diffKey });
      else vscode.postMessage({ type: 'repositoryChangesFile', repositoryPath: repositoryPath, section: section, path: filePath });
      return;
    }
    const snapshot = currentRepositorySnapshot(node, repository);
    if (action === 'openFile') {
      const message = section === 'commit'
        ? { type: 'commitFileAction', action: 'openFile', hash: snapshot.commit.hash, repositoryPath: repositoryPath, path: filePath }
        : { type: 'repositoryChangesFileAction', action: 'openFile', repositoryPath: repositoryPath, section: section, path: filePath };
      vscode.postMessage(message);
      return;
    }
    if (action === 'restoreStash' && snapshot.kind === 'commit' && snapshot.commit.isStash === true && section === 'commit') {
      const paths = filePath
        ? repositorySelectedPaths(repositoryPath, section, filePath, group)
        : snapshot.files.map(function(file) { return file.path; });
      vscode.postMessage({ type: 'repositoryChangesAction', repositoryPath: repositoryPath, action: 'restoreStash', hash: snapshot.commit.hash, paths: paths });
      return;
    }
    const sectionFiles = repoChangesSections(repository).find(function(item) { return item.key === section; }).files;
    // A file button acts on the current selection when the clicked row belongs to it; otherwise it acts alone.
    const fileActionPaths = filePath
      ? repositorySelectedPaths(repositoryPath, section, filePath, group)
      : sectionFiles.map(function(file) { return file.path; });
    const selectedFileStash = action === 'stash' && Boolean(filePath);
    const untrackedScope = selectedFileStash ? sectionFiles.filter(function(file) { return fileActionPaths.indexOf(file.path) >= 0; }) : sectionFiles;
    const untrackedPaths = untrackedScope.filter(function(file) { return file.isUntracked; }).map(function(file) { return file.path; });
    vscode.postMessage({ type: 'repositoryChangesAction', repositoryPath: repositoryPath, action: action, section: section, path: selectedFileStash ? filePath : undefined, paths: fileActionPaths, untrackedPaths: untrackedPaths });
  });
  repositoryChangesList.addEventListener('contextmenu', function(event) {
    const row = event.target.closest('.repo-file-row');
    if (row) { showRepositoryFileContextMenu(event, row); return; }
    const header = event.target.closest('.repo-group-header');
    if (header) { showRepositoryGroupContextMenu(event, header); return; }
    const input = event.target.closest('.repo-message');
    if (input) { showRepositoryMessageContextMenu(event, input); return; }
    if (event.target.closest('.repo-changes')) event.preventDefault();
  });
  repositoryGroupContextMenu.addEventListener('click', function(event) {
    const button = event.target.closest('[data-repository-group-action]');
    if (!button || !repositoryGroupContextTarget) return;
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === repositoryGroupContextTarget.repositoryPath; });
    const files = repository && (repositoryGroupContextTarget.section === 'staged' ? repository.staged : repository.unstaged);
    if (files) vscode.postMessage({ type: 'repositoryChangesAction', repositoryPath: repositoryGroupContextTarget.repositoryPath, action: button.dataset.repositoryGroupAction, section: repositoryGroupContextTarget.section, paths: files.filter(function(file) { return !file.isConflict; }).map(function(file) { return file.path; }), untrackedPaths: files.filter(function(file) { return file.isUntracked; }).map(function(file) { return file.path; }) });
    closeRepositoryGroupContextMenu();
  });
  repositoryMessageContextMenu.addEventListener('click', function(event) {
    const button = event.target.closest('[data-repository-message-action]');
    if (!button || !repositoryMessageContextTarget) return;
    repositoryMessageContextTarget.focus();
    const action = button.dataset.repositoryMessageAction;
    if (action === 'selectAll') repositoryMessageContextTarget.select();
    else document.execCommand(action);
    closeRepositoryMessageContextMenu();
  });
  repositoryFileContextMenu.addEventListener('click', function(event) {
    const changeButton = event.target.closest('[data-file-change-action]');
    if (changeButton && repositoryFileContextTarget && repositoryFileContextTarget.isStash === true && changeButton.dataset.fileChangeAction === 'restoreStash') {
      vscode.postMessage({ type: 'repositoryChangesAction', repositoryPath: repositoryFileContextTarget.repositoryPath, action: 'restoreStash',
        hash: repositoryFileContextTarget.hash, paths: repositoryFileContextTarget.paths });
      closeRepositoryFileContextMenu();
      return;
    }
    if (changeButton && repositoryFileContextTarget && repositoryFileContextTarget.kind === 'worktree') {
      // Same intent as the row and group buttons, so the host confirms a discard and re-reads the group; it covers the whole selection.
      vscode.postMessage({ type: 'repositoryChangesAction', repositoryPath: repositoryFileContextTarget.repositoryPath, action: changeButton.dataset.fileChangeAction,
        section: repositoryFileContextTarget.section, paths: repositoryFileContextTarget.paths, untrackedPaths: repositoryFileContextTarget.untrackedPaths });
      closeRepositoryFileContextMenu();
      return;
    }
    const button = event.target.closest('[data-file-action]');
    if (!button || button.disabled || !repositoryFileContextTarget) return;
    const action = button.dataset.fileAction;
    const message = repositoryFileContextTarget.kind === 'commit'
      ? { type: 'commitFileAction', action: action, hash: repositoryFileContextTarget.hash, repositoryPath: repositoryFileContextTarget.repositoryPath, path: repositoryFileContextTarget.path }
      : { type: 'repositoryChangesFileAction', action: action, repositoryPath: repositoryFileContextTarget.repositoryPath, section: repositoryFileContextTarget.section, path: repositoryFileContextTarget.path };
    if (repositoryFileContextTarget.paths && repositoryFileContextTarget.paths.length > 1) message.paths = repositoryFileContextTarget.paths;
    vscode.postMessage(message);
    closeRepositoryFileContextMenu();
  });
`;
