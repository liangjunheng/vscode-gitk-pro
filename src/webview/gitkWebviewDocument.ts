import { CHANGED_FILES_SUB_PANEL_MARKUP, CHANGED_FILES_SUB_PANEL_SCRIPT, CHANGED_FILES_SUB_PANEL_STYLES } from './changedFilesSubPanel';
import { COMMIT_LIST_SUB_PANEL_MARKUP, COMMIT_LIST_SUB_PANEL_SCRIPT, COMMIT_LIST_SUB_PANEL_STYLES } from './commitListSubPanel';
import { SELECTOR_BAR_SUB_PANEL_MARKUP, SELECTOR_BAR_SUB_PANEL_SCRIPT, SELECTOR_BAR_SUB_PANEL_STYLES } from './selectorBarSubPanel';

/**
 * gitk webview 页面骨架: 把外壳(全局样式、布局容器、消息分发、拖拽与工具函数)
 * 与三个子面板片段拼成完整 HTML。子面板片段按"谁拥有 DOM 谁持有监听"划分,
 * 所有脚本片段最终拼进同一个 IIFE, 共享作用域。
 */
export function renderGitkWebviewHtml(codiconCssUri: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gitk</title>
<link rel="stylesheet" href="${codiconCssUri}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: var(--vscode-editor-font-family, sans-serif); font-size: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); display: flex; flex-direction: column; height: 100%; }
  #workspace { display: grid; grid-template-rows: minmax(0, 1fr) 5px minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; width: 100%; }
  #panelResizeHandle { cursor: row-resize; background: var(--vscode-panel-border); }
  #panelResizeHandle:hover, #panelResizeHandle.resizing { background: var(--vscode-focusBorder); }
  /* 下半区固定区域共享 Commit 列表标题底色, 避免选择器/标题/搜索行出现色块断层。 */
  #commitSection { --commit-title-background: var(--vscode-editorWidget-background, var(--vscode-tab-activeBackground)); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #commitSection #graph { flex: 1 1 auto; height: auto; min-height: 0; }
  /* 通用图标按钮: 顶部工具栏与 Commit 列表工具条共用, 具体尺寸覆盖写在各自面板里。 */
  .toolbar-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; }
  .toolbar-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .toolbar-icon .codicon { font-size: 16px; line-height: 16px; }
  .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .toolbar-icon.refresh-unchanged { animation: refresh-unchanged 550ms ease-out; }
  @keyframes refresh-unchanged { 0%, 100% { color: var(--vscode-icon-foreground); } 45% { color: var(--vscode-descriptionForeground); } }
${SELECTOR_BAR_SUB_PANEL_STYLES}
${CHANGED_FILES_SUB_PANEL_STYLES}
${COMMIT_LIST_SUB_PANEL_STYLES}
</style>
</head>
<body>
  <main id="workspace">
${CHANGED_FILES_SUB_PANEL_MARKUP}
    <div id="panelResizeHandle" role="separator" aria-label="调整变更文件列表与提交图高度" aria-orientation="horizontal"></div>
    <div id="commitSection">
${SELECTOR_BAR_SUB_PANEL_MARKUP}
${COMMIT_LIST_SUB_PANEL_MARKUP}
    </div>
  </main>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  let panelResizing = null;

  window.addEventListener('focus', function() { vscode.postMessage({ type: 'focus' }); });
  window.addEventListener('blur', function() { closeDropdowns(); closeCommitContextMenu(); vscode.postMessage({ type: 'blur' }); });
  document.addEventListener('visibilitychange', function() { if (document.visibilityState !== 'visible') { closeDropdowns(); closeCommitContextMenu(); } vscode.postMessage({ type: document.visibilityState === 'visible' ? 'focus' : 'blur' }); });

  let resizeFrame = 0;
  window.addEventListener('resize', function() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(function() {
      resizeFrame = 0;
      updateOpenDropdownHeights();
      const graph = document.getElementById('graph');
      if (commits.length > 0 && graph && graph.clientWidth !== graphViewportWidth) {
        render();
      }
    });
  });

  document.getElementById('panelResizeHandle').addEventListener('mousedown', function(event) {
    const workspace = document.getElementById('workspace');
    if (!workspace) return;
    panelResizing = { startY: event.clientY, topHeight: document.getElementById('filesSection').getBoundingClientRect().height, totalHeight: workspace.getBoundingClientRect().height };
    document.getElementById('panelResizeHandle').classList.add('resizing');
    event.preventDefault();
  });

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'stateUpdate') {
      // 每次都以完整 Store 快照替换业务模型；局部变量仅保存 DOM 交互细节。
      var state = msg.state;
      if (!state) return;
      var previousCommitLoading = isCommitLoading;
      isCommitLoading = Boolean(state.isLoading);
      // 加载态呈现方式由后端按"已选是否变化"判定后下发, 前端不再自行猜测。
      commitLoadingMode = state.loadingMode === 'overlay' ? 'overlay' : 'bar';
      commits = state.commits || [];
      document.getElementById('graph').classList.toggle('without-lanes', state.showCommitLanes === false);
      branches = state.branches || [];
      selectedBranches = state.selectedBranches || [];
      var workingTreeRows = state.workingTreeRows || [];
      workingTreeRowsState = workingTreeRows;
      uncommittedEnabled = workingTreeRows.some(function(row) { return row.enabled; });
      var uncommittedRepositoryCount = Number(state.uncommittedRepositoryCount) || 0;
      var uncommittedRepoBadge = document.getElementById('uncommittedRepoBadge');
      // 按钮内还有图标与文案, 只能改计数节点; 对按钮整体赋值 textContent 会抹掉子节点。
      uncommittedRepoBadge.querySelector('.uncommitted-repo-count').textContent = String(uncommittedRepositoryCount);
      uncommittedRepoBadge.title = '打开 Commit 面板（' + uncommittedRepositoryCount + ' 个仓库有未提交文件）';
      stagedCount = Number(state.stagedCount) || 0;
      changesCount = Number(state.changesCount) || 0;
      hasMoreCommits = Boolean(state.hasMoreCommits);
      isLoadingMoreCommits = Boolean(state.isLoadingMoreCommits);
      commitPageError = state.commitPageError || '';
      files = state.files || [];
      stagedFiles = state.stagedFiles || [];
      unstagedFiles = state.unstagedFiles || [];
      filesMode = state.filesMode || 'flat';
      var previousFilesLoading = filesLoading;
      filesLoading = Boolean(state.filesLoading);
      var diffProgress = state.diffProgress || { completed: 0, total: 0 };
      var diffLoading = Boolean(state.diffLoading);
      selectedPath = state.selectedPath || '';
      selectedCommitHash = state.selectedCommit ? state.selectedCommit.hash : '';
      selectedCommitRepositoryPath = state.selectedCommit ? state.selectedCommit.repositoryPath : '';
      workingTreeCommitMessage = typeof state.commitMessage === 'string' ? state.commitMessage : '';
      updateWorkingTreeCommitEditor();
      var nextCommitListModelKey = JSON.stringify([
        commits.map(function(commit) { return commit.key || ((commit.repositoryPath || '') + ':' + commit.hash); }),
        selectedRepositoryPaths,
        selectedBranches,
        workingTreeRows.map(function(row) { return [row.hash, row.repositoryPath, row.label, row.enabled]; }),
        commitListRevision,
      ]);
      var shouldRenderCommitList = nextCommitListModelKey !== commitListModelKey
        || previousCommitLoading !== isCommitLoading;
      commitListModelKey = nextCommitListModelKey;
      currentMaxLane = 0;
      currentGraphW = LANE_W + 10;
      columnWidthChars.hash = 0;
      columnWidthChars.author = 0;
      columnWidthChars.date = 0;
      if (state.commitListRevision !== undefined && state.commitListRevision !== commitListRevision) expandedCommits.clear();
      commitListRevision = state.commitListRevision || 0;
      renderSelectorState(state);
      if (shouldRenderCommitList) {
        render();
      }
      applySelectedCommit();
      updateCountLabel();
      updateFilesCommitHash();
      var nextFilesModelKey = JSON.stringify([
        files.map(function(file) { return file.diffKey || file.path; }),
        filesMode,
        selectedPath,
        selectedCommitHash,
        selectedCommitRepositoryPath,
      ]);
      var shouldRenderFiles = previousFilesLoading !== filesLoading
        || nextFilesModelKey !== filesModelKey;
      filesModelKey = nextFilesModelKey;
      if (filesLoading) {
        var progressText = diffProgress.total > 0 ? '（已加载 ' + diffProgress.completed + ' / ' + diffProgress.total + '）' : '';
        document.getElementById('filesList').innerHTML = '<div id="filesEmpty"><span class="files-loading-spinner"></span><span>正在加载变更文件' + progressText + '...</span></div>';
      } else if (shouldRenderFiles) {
        renderFiles();
      }
      if (isCommitLoading) {
        showLoadingProgress('start', state.loadingMessage || '加载中...', 0, 0);
      } else {
        hideLoadingProgress();
        // 每轮快照都要重算页脚: hasMoreCommits/commitPageError 不进提交列表的渲染判据,
        //   否则加载更多失败后"点击重试"永远不会出现。
        renderCommitFooter();
      }
    } else if (msg.type === 'totalRepoListChanged') {
      updateTotalRepositoryList(msg.repositories || [], msg.selectedRepositoryPaths || []);
    } else if (msg.type === 'totalBranchesListChanged') {
      updateTotalBranchesList(msg.branches || []);
    } else if (msg.type === 'repoLoadingChanged') {
      updateRepositoryLoading(Boolean(msg.loading));
    } else if (msg.type === 'selectedRepoDisplayChanged') {
      updateSelectedRepoDisplay(msg.repository);
    } else if (msg.type === 'selectedBranchDisplayChanged') {
      updateSelectedBranchDisplay(msg.display);
    } else if (msg.type === 'branchLoadingChanged') {
      updateBranchLoading(Boolean(msg.loading));
    } else if (msg.type === 'loadingProgress') {
      // 进度消息先于状态快照到达, 必须自带呈现模式, 不能沿用上一轮的。
      if (msg.loadingMode === 'overlay' || msg.loadingMode === 'bar') { commitLoadingMode = msg.loadingMode; }
      showLoadingProgress(msg.phase || 'start', msg.message || '加载中...', msg.current, msg.total);
    } else if (msg.type === 'refreshing') {
      showLoadingProgress('start', msg.message || '正在刷新...', 0, 0);
    } else if (msg.type === 'filesLoadingProgress') {
      if ((msg.hash || '') !== selectedCommitHash || (msg.repositoryPath || '') !== selectedCommitRepositoryPath) return;
      if (!filesLoading) return; // 只在 loading 状态下更新进度
      var loadingMessage = escapeHtml(msg.message || '正在加载变更文件...');
      var progressText = msg.total > 0 ? ' (' + msg.current + '/' + msg.total + ')' : '';
      document.getElementById('filesList').innerHTML = '<div id="filesEmpty"><span class="files-loading-spinner"></span><span>' + loadingMessage + progressText + '</span></div>';
    } else if (msg.type === 'filesError') {
      if ((msg.hash || '') !== selectedCommitHash || (msg.repositoryPath || '') !== selectedCommitRepositoryPath) return;
      document.getElementById('filesList').innerHTML = '<div id="filesEmpty">无法加载变更文件: ' + escapeHtml(msg.message || '') + '</div>';
    }
  });
  vscode.postMessage({ type: 'webviewReady' });

${SELECTOR_BAR_SUB_PANEL_SCRIPT}
${COMMIT_LIST_SUB_PANEL_SCRIPT}
${CHANGED_FILES_SUB_PANEL_SCRIPT}

  document.addEventListener('mousedown', function(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('resize-handle')) return;
    const key = target.getAttribute('data-column');
    if (!key) return;
    const header = target.parentElement;
    if (!header) return;
    resizing = { key: key, startX: event.clientX, startWidth: header.getBoundingClientRect().width };
    event.preventDefault();
  });

  document.addEventListener('mousemove', function(event) {
    if (resizing) {
      const minimumWidths = { main: LANE_W + 170, author: 80, hash: 80, date: 100 };
      const width = Math.max(minimumWidths[resizing.key] || 40, resizing.startWidth + event.clientX - resizing.startX);
      columnWidths[resizing.key] = width + 'px';
      applyColumnWidths();
      if (resizing.key === 'date') {
        const graph = document.getElementById('graph');
        if (graph) graph.scrollLeft = graph.scrollWidth;
      }
    }
    if (panelResizing) {
      const workspace = document.getElementById('workspace');
      if (!workspace) return;
      const availableHeight = panelResizing.totalHeight - 5;
      const topHeight = Math.max(180, Math.min(availableHeight - 180, panelResizing.topHeight + event.clientY - panelResizing.startY));
      workspace.style.gridTemplateRows = topHeight + 'px 5px minmax(0, 1fr)';
    }
  });

  document.addEventListener('mouseup', function() {
    resizing = null;
    if (panelResizing) {
      panelResizing = null;
      document.getElementById('panelResizeHandle').classList.remove('resizing');
    }
  });

  function truncateMessage(s, maxLength) {
    const value = s == null ? '' : String(s);
    if (value.length <= maxLength) return value;
    return value.slice(0, Math.max(0, maxLength - 3)) + '...';
  }

  function sixCharacterGap() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
    probe.textContent = '000000';
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }

  function columnWidth(values, minimum, maximum) {
    let width = minimum;
    for (const value of values) {
      width = Math.max(width, String(value == null ? '' : value).length);
    }
    return maximum === undefined ? width : Math.min(width, maximum);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
</script>
</body>
</html>`;
}
