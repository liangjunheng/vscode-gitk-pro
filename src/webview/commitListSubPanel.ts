/**
 * Commit 列表子面板: 承载 webview 左侧提交图区域的样式、结构与交互脚本。
 * 三段片段按原样迁移自 GitkViewProvider 的内联 webview, 仅"描述"列表头改为"Commit列表";
 * 脚本片段与宿主片段、changedFilesSubPanel 片段拼接在同一个 IIFE 内, 共享同一作用域。
 */

/** Commit 列表子面板的样式片段。 */
export const COMMIT_LIST_SUB_PANEL_STYLES = `
  #commitGraphViewport { flex: 1 1 auto; min-width: 0; min-height: 0; }
  #commitSection #commitGraphViewport > #graph { height: 100%; }
  /* 提交区的自定义滚动条只覆盖提交内容，避开标题栏和搜索栏。 */
  #commitSection .overlay-scroll-track.vertical { top: 2px; }
  #graph { --graph-lane-width: 22px; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; overflow-anchor: none; display: flex; flex-direction: column; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif); font-size: var(--vscode-font-size, 13px); }
  /* 竖向铺满: 列表吃掉表头以外的剩余高度。flex-shrink 必须为 0, 否则内容超高时会被压扁而无法滚动。 */
  #commitList { flex: 1 0 auto; width: 100%; min-width: 0; }
  #commitWorkingTreeRows, #commitVirtualRows { width: 100%; min-width: 0; }
  .commit-virtual-spacer { width: 1px; min-height: 0; pointer-events: none; }
  /* 搜索/计数/刷新都是提交列表的能力, 随面板一起放在列头之上并吸顶。 */
  .count { opacity: 0.7; font-size: calc(var(--vscode-font-size, 13px) - 1px); white-space: nowrap; }
  #searchBox { display: flex; align-items: center; position: relative; }
  #searchInput { width: 100px; padding: 3px 22px 3px 24px; font-family: inherit; font-size: inherit; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, inherit); border-radius: 4px; transition: border-color 0.15s, box-shadow 0.15s; }
  #searchInput:focus { outline: none; border-color: var(--vscode-focusBorder, #007acc); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc); }
  #searchInput::placeholder { color: var(--vscode-inputPlaceholderForeground, #888); }
  #searchIcon { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; opacity: 0.5; pointer-events: none; color: var(--vscode-input-foreground, inherit); }
  #searchClear { position: absolute; right: 4px; top: 0; bottom: 0; margin: auto 0; width: 16px; height: 16px; border: none; background: transparent; color: var(--vscode-descriptionForeground, #888); cursor: pointer; display: none; font-size: 14px; line-height: 16px; padding: 0; border-radius: 3px; align-items: center; justify-content: center; }
  #searchClear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-input-foreground, inherit); }
  #searchClear.visible { display: flex; }
  /* 单列内容始终铺满容器，右侧分支徽章覆盖在同一列上。 */
  .commit-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; width: 100%; min-width: 0; }
  /* 提交列表只保留 Commit 列表单列；右侧分支徽章覆盖在这一列上。 */
  #commitHeaderColumns { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; min-width: 0; align-items: center; }
  /* top 让出工具条 30px, 与工具条一起吸顶; z-index 高于提交行、低于工具条。 */
  /* 列头与提交行使用同一宽度，避免产生横向滚动区域。 */
  /* 独立工具条行已并入列头, 列头直接吸在 top: 0; z-index 高于提交行。 */
  .commit-header { flex: 0 0 auto; position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 30px; margin: 0; padding: 0 10px; color: var(--vscode-tab-activeForeground); background: var(--commit-title-background); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); box-sizing: border-box; font-size: inherit; font-weight: 600; }
  /* 同步操作固定在标题行右侧。 */
  #commitHeaderSearch { display: flex; align-items: center; gap: 6px; margin-left: auto; padding-left: 8px; position: sticky; right: 10px; z-index: 1; background: var(--commit-title-background); }
  .commit-row { min-height: 26px; height: auto; box-sizing: border-box; cursor: pointer; align-items: start; font-size: inherit; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  /* 外层 Grid 的所有内容显式共用第 1 行；标签覆盖其上而不占出第 2 行。 */
  .commit-row > .col-main { grid-column: 1; grid-row: 1; width: 100%; }
  /* 分支图与描述合并为 col-main 单列: SVG 画泳道(左), 摘要行与描述(右)在同一字段内竖排。 */
  .col-main { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: 26px; align-items: center; min-width: 0; overflow: hidden; }
  .commit-row.expanded .col-main { grid-template-rows: 26px auto; }
  .col-main .graph-svg { grid-column: 1; grid-row: 1 / -1; align-self: stretch; flex: 0 0 auto; }
  /* 搜索结果不展示拓扑，泳道和占位一起移除。 */
  #graph.without-lanes .graph-svg { display: none; }
  #graph.without-lanes .col-main { grid-template-columns: minmax(0, 1fr); }
  #graph.without-lanes .col-main-summary, #graph.without-lanes .commit-description { grid-column: 1; }
  #graph.without-lanes { --main-width: 60ch; }
  .col-main-summary { grid-column: 2; grid-row: 1; display: flex; align-items: center; min-width: 0; overflow: hidden; padding: 0 calc(var(--commit-row-refs-width, 0px) + 5px) 0 0; }
  .col-main-summary .commit-message-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--vscode-foreground, inherit); }
  .commit-row.selected .commit-message-text { font-weight: 600; }
  .commit-description { display: none; grid-column: 2; grid-row: 2; padding: 0 10px 10px 0; color: var(--vscode-descriptionForeground); cursor: text; }
  .commit-row.expanded .commit-description { display: block; }
  .commit-description:empty { display: none; }
  .commit-description-body { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-editor-foreground, inherit); line-height: 19px; }
  .commit-description-meta { display: grid; grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .commit-description.has-body .commit-description-meta { margin-top: 10px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  .commit-detail-item { display: grid; grid-template-columns: 14px 58px minmax(0, 1fr); column-gap: 3px; align-items: start; min-width: 0; }
  .commit-detail-item .codicon { grid-column: 1; grid-row: 1; padding-top: 2px; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1; }
  .commit-detail-label { grid-column: 2; grid-row: 1; color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 17px; }
  .commit-detail-value { grid-column: 3; grid-row: 1; min-width: 0; overflow-wrap: anywhere; color: var(--vscode-editor-foreground, inherit); line-height: 17px; }
  .commit-detail-value--hash, .commit-detail-value--parents { font-family: var(--vscode-editor-font-family, monospace); font-size: calc(var(--vscode-font-size, 13px) - 1px); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground, #094771); outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: -1px; }
  .commit-row.context-target { background: var(--vscode-list-activeSelectionBackground, #094771); outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: -1px; }
  .commit-row.working-tree:hover { background: var(--vscode-list-hoverBackground); }
  /* 空分组虚拟行置灰: 降透明度 + 默认光标; 不用 pointer-events:none(曾导致点击完全不触发无法排查), 点击拦截由 JS 的 classList.contains('disabled') 负责。 */
  .commit-row.working-tree.disabled { opacity: .5; cursor: default; }
  .commit-row.working-tree.disabled:hover { background: transparent; }
  .working-tree-label { color: var(--vscode-textLink-foreground); font-weight: 600; }
  /* staged 与 unstaged/changes 统一用白色文字。 */
  .working-tree-label--staged { color: #ffffff; }
  .working-tree-label--changes { color: #ffffff; }
  .working-tree-count { color: var(--vscode-descriptionForeground); }
  #commitHeaderColumns > div { position: relative; min-width: 0; padding: 5px 14px 5px 0; overflow: hidden; white-space: nowrap; text-align: left; }
  /* 扁平化图标按钮(fetch/pull/push): 只有图标, 无描边无圆角无底色, 悬停才给浅底。 */
  #commitHeader .toolbar-icon { display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--vscode-icon-foreground); font: inherit; cursor: pointer; vertical-align: middle; }
  #commitHeader .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  #commitHeader .toolbar-icon .codicon { font-size: 14px; line-height: 1; }
  #commitHeader .toolbar-icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .commit-header .resize-handle { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
  .commit-header .resize-handle:hover { background: var(--vscode-focusBorder); }
  .col-main { min-width: 0; overflow: hidden; white-space: nowrap; text-align: left; }
  .graph-svg { flex: 0 0 auto; }
  /* 各分组独立成圆形图标位，并与描述共用第 1 行；悬浮列固定在可视区右缘，点击展开时向左覆盖提交标题。 */
  .commit-row-refs { position: sticky; z-index: 1; right: 12px; grid-row: 1; grid-column: 1 / -1; align-self: start; justify-self: end; display: flex; flex-wrap: nowrap; align-items: center; justify-content: flex-end; gap: 2px; height: 20px; margin-top: 3px; pointer-events: auto; }
  .commit-row-ref { display: inline-flex; align-items: center; justify-content: center; gap: 0; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 999px; box-sizing: border-box; color: #17212b; font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 20px; white-space: nowrap; cursor: pointer; user-select: none; transition: gap 80ms ease-out; }
  .commit-row-ref--current { background: #5aa7e8; }
  .commit-row-ref--tag { background: #f3d77b; }
  .commit-row-ref--local { background: #69c58f; }
  .commit-row-ref--remote { background: #c9a227; }
  #graph.commit-floating-current-expanded .commit-row-ref--current,
  #graph.commit-floating-tag-expanded .commit-row-ref--tag,
  #graph.commit-floating-local-expanded .commit-row-ref--local,
  #graph.commit-floating-remote-expanded .commit-row-ref--remote { gap: 3px; }
  .commit-row-ref-label { display: inline-block; max-width: 0; overflow: hidden; opacity: 0; line-height: 16px; transition: max-width 120ms ease-out, opacity 80ms ease-out; }
  #graph.commit-floating-current-expanded .commit-row-ref--current .commit-row-ref-label,
  #graph.commit-floating-tag-expanded .commit-row-ref--tag .commit-row-ref-label,
  #graph.commit-floating-local-expanded .commit-row-ref--local .commit-row-ref-label,
  #graph.commit-floating-remote-expanded .commit-row-ref--remote .commit-row-ref-label { max-width: 100vw; opacity: 1; }
  .commit-row-info { display: inline-flex; align-items: center; justify-content: center; gap: 0; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 999px; box-sizing: border-box; overflow: hidden; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #ffffff); font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 20px; white-space: nowrap; cursor: pointer; user-select: none; transition: gap 80ms ease-out; }
  .commit-row-info .codicon { display: inline-flex; flex: 0 0 12px; align-items: center; justify-content: center; width: 12px; height: 20px; font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 20px; }
  .commit-row-info-label { display: inline-block; max-width: 0; overflow: hidden; opacity: 0; line-height: 16px; transition: max-width 120ms ease-out, opacity 80ms ease-out; }
  #graph.commit-floating-author-expanded .commit-row-info--author,
  #graph.commit-floating-time-expanded .commit-row-info--time { gap: 3px; }
  #graph.commit-floating-author-expanded .commit-row-info--author .codicon,
  #graph.commit-floating-time-expanded .commit-row-info--time .codicon { display: none; }
  #graph.commit-floating-author-expanded .commit-row-info--author .commit-row-info-label,
  #graph.commit-floating-time-expanded .commit-row-info--time .commit-row-info-label { max-width: 100vw; opacity: 1; }
  /* 选择器需两级以压过 codicon.css 的 .codicon[class*='codicon-']，否则其 16px/1 行高会让图标与标签文本错位。 */
  .commit-row-ref .codicon { display: inline-flex; flex: 0 0 12px; align-items: center; justify-content: center; width: 12px; height: 20px; font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 20px; }
  svg { display: block; }
  .ref-head { font-weight: 600; }
  .dot { stroke: var(--vscode-editor-background); stroke-width: 1; }
  /* 提交列表加载态有两种呈现, 由后端下发的 loadingMode 决定:
       bar     —— 已选列表不变、只是就地重读, 只亮列头底边的细进度条, 列表保持可见;
       overlay —— 选择变化要重建列表, 期间旧列表没有参考价值, 用整块蒙版盖住。 */
  #loading { flex: 0 0 auto; padding: 20px; text-align: center; display: none; }
  #loadingText { opacity: 0.8; margin-bottom: 10px; }
  #progressBar { width: 80%; height: 4px; background: var(--vscode-panel-border, #444); border-radius: 2px; margin: 0 auto 4px; overflow: hidden; }
  #progressBarFill { height: 100%; background: var(--vscode-textLink-foreground, #007acc); width: 0%; transition: width 0.3s ease; border-radius: 2px; }
  #progressBarFill.indeterminate { width: 30%; animation: indeterminate 1s ease-in-out infinite alternate; }
  @keyframes indeterminate { from { transform: translateX(-150%); } to { transform: translateX(350%); } }
  #progressStep { font-size: calc(var(--vscode-font-size, 13px) - 1px); color: var(--vscode-descriptionForeground); opacity: 0.7; }
  /* 顶部进度条贴在搜索行底边: 搜索行是 sticky 定位(top: 30px), 是绝对定位子元素的包含块,
     所以进度条随搜索行一起吸在列头下方, 滚动时始终在列表顶部, 且不占布局不会顶动列表。 */
  #commitProgress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; z-index: 2; overflow: hidden; }
  /* [hidden] 必须显式写出: 本文件里带 display 的规则会盖掉浏览器默认的 [hidden]{display:none}。 */
  #commitProgress[hidden] { display: none; }
  #commitProgressFill { height: 100%; width: 0%; background: var(--vscode-progressBar-background, #007acc); transition: width 0.3s ease; }
  #commitProgressFill.indeterminate { width: 30%; animation: commit-progress 1s ease-in-out infinite alternate; }
  @keyframes commit-progress { from { transform: translateX(-150%); } to { transform: translateX(350%); } }
  #commitEmpty { padding: 8px 10px; color: var(--vscode-descriptionForeground); }
  #commitFooter { flex: 0 0 auto; min-width: max-content; padding: 8px 10px; text-align: center; color: var(--vscode-descriptionForeground); }
  #commitFooter button { border: 0; color: var(--vscode-textLink-foreground); background: transparent; cursor: pointer; text-decoration: underline; }
  /* 搜索独占一行: 紧跟列头下方, 滚动时粘在列头下面(列头高 30px、z-index 2, 故这里 top: 30px、z-index 1)。
     left: 0 让它横向也吸在可视区左边缘: 提交图变宽需要横向滚动时, 搜索行不能随内容滚出视野,
     否则挂在它底边的加载进度条会一起看不见。
     不能照列头那样用 min-width: max-content 撑满滚动宽 —— 列头撑得开是因为 #commitHeaderColumns 是与提交行
     同模板的 grid, 而四列宽变量由 setColumnWidth 同时写到 #graph 上(max-content 因此等于整行宽);
     搜索行没有这些列, 搜索框又是 flex: 1 1 auto + min-width: 0, 整行 max-content 远小于列表, 撑不出滚动宽。
     所以这里用横向 sticky 吸附, 任何滚动位置都可见, 且搜索框不会被拉宽到滚动宽。搜索行层级必须高于提交行的 sticky 浮动按钮。 */
  #commitSearchRow { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 5px 10px; position: sticky; top: var(--commit-search-top, 60px); left: 0; z-index: 3; background: var(--commit-title-background); border-bottom: 1px solid var(--vscode-panel-border); }
  #commitSearchRow #searchBox { flex: 1 1 auto; min-width: 0; }
  #commitSearchRow .count { flex: 0 0 auto; }
  #commitSearchRow #searchInput { width: 100%; }
`;

/** Commit 列表子面板的结构片段。 */
export const COMMIT_LIST_SUB_PANEL_MARKUP = `
    <div id="commitGraphViewport" class="overlay-scroll-viewport">
    <div id="graph">
      <div id="commitHeader" class="commit-header"><div id="commitHeaderColumns"><div>Commit列表</div></div><div id="commitHeaderSearch"><button class="toolbar-icon" id="fetchBtn" title="Fetch" aria-label="Fetch"><span class="codicon codicon-repo-fetch" aria-hidden="true"></span></button><button class="toolbar-icon" id="pullBtn" title="Pull" aria-label="Pull"><span class="codicon codicon-repo-pull" aria-hidden="true"></span></button><button class="toolbar-icon" id="pushBtn" title="Push" aria-label="Push"><span class="codicon codicon-repo-push" aria-hidden="true"></span></button></div></div>
      <!-- commit-selectors -->
      <div id="commitSearchRow"><div class="selector" id="searchBox"><svg id="searchIcon" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 .96-.96l3.04 3.03-1.06 1.06-2.94-3.13z"/></svg><input type="text" id="searchInput" placeholder="搜索提交..." title="输入关键词搜索, 支持作者/邮箱/消息/Hash/日期, 多个关键词用空格隔开, 回车开始搜索"><button id="searchClear" title="清除搜索">&times;</button></div><span class="count" id="countLabel"></span><div id="commitProgress" hidden><div id="commitProgressFill"></div></div></div>
      <div id="loading">
        <div id="loadingText">加载中...</div>
        <div id="progressBar"><div id="progressBarFill"></div></div>
        <div id="progressStep"></div>
      </div>
      <div id="commitList"><div id="commitEmpty">提交记录将在此显示</div></div>
      <div id="commitFooter" hidden></div>
    </div>
    <div id="commitVerticalScrollbar" class="overlay-scroll-track vertical" role="scrollbar" aria-label="纵向滚动提交列表" aria-controls="graph" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" tabindex="0" hidden><div class="overlay-scroll-thumb"></div></div>
    </div>
`;

/** Commit 列表子面板的交互脚本片段。 */
export const COMMIT_LIST_SUB_PANEL_SCRIPT = `
  var commitGraphViewport = document.getElementById('commitGraphViewport');
  var commitGraph = document.getElementById('graph');
  var commitHeader = document.getElementById('commitHeader');
  var commitSelectors = document.getElementById('commitSelectors');
  var commitSearchRow = document.getElementById('commitSearchRow');
  var commitVerticalScrollbar = document.getElementById('commitVerticalScrollbar');
  function updateCommitChromeLayout() {
    var searchTop = (commitHeader ? commitHeader.offsetHeight : 0) + (commitSelectors ? commitSelectors.offsetHeight : 0);
    var scrollbarTop = searchTop + (commitSearchRow ? commitSearchRow.offsetHeight : 0);
    if (commitSearchRow) commitSearchRow.style.setProperty('--commit-search-top', searchTop + 'px');
    if (commitVerticalScrollbar) commitVerticalScrollbar.style.top = scrollbarTop + 'px';
  }
  installOverlayScrollbars(commitGraphViewport, commitGraph, [commitVerticalScrollbar]);
  updateCommitChromeLayout();
  if (typeof ResizeObserver !== 'undefined') {
    var commitChromeObserver = new ResizeObserver(updateCommitChromeLayout);
    [commitHeader, commitSelectors, commitSearchRow].forEach(function(element) { if (element) commitChromeObserver.observe(element); });
  }
  window.addEventListener('resize', updateCommitChromeLayout);
  ['fetch', 'pull', 'push'].forEach(function(action) {
    document.getElementById(action + 'Btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'gitSync', action: action });
    });
  });
  var searchDebounceTimer = null;
  function triggerSearch() {
    var input = document.getElementById('searchInput');
    vscode.postMessage({ type: 'search', keywords: input.value });
  }
  function debounceSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function() {
      searchDebounceTimer = null;
      triggerSearch();
    }, 500);
  }
  function triggerSearchImmediately() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    triggerSearch();
  }
  document.getElementById('searchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerSearchImmediately();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.value = '';
      document.getElementById('searchClear').classList.remove('visible');
      triggerSearchImmediately();
    }
  });
  document.getElementById('searchInput').addEventListener('input', function() {
    var clearBtn = document.getElementById('searchClear');
    if (this.value.length > 0) { clearBtn.classList.add('visible'); } else { clearBtn.classList.remove('visible'); }
    debounceSearch();
  });
  document.getElementById('searchClear').addEventListener('click', function() {
    var input = document.getElementById('searchInput');
    input.value = '';
    input.focus();
    this.classList.remove('visible');
    triggerSearchImmediately();
  });
  let commits = [];
  // 工作区虚拟提交行(changes/staged)由后端下发, webview 循环渲染, 不再写死单行。
  let workingTreeRowsState = [];
  let selectedCommitHash = '';
  let selectedCommitRepositoryPath = '';
  let hasMoreCommits = false;
  let commitListRevision = 0;
  let isLoadingMoreCommits = false;
  let commitPageError = '';
  let isCommitLoading = false;
  let commitLoadRequestPending = false;
  let commitLoadRequestCount = 0;
  // 加载态呈现方式, 由后端每轮快照下发:
  //   'bar'     —— 已选列表不变、就地重读, 只亮顶部进度条;
  //   'overlay' —— 选择变化要重建列表, 用全屏蒙版。
  let commitLoadingMode = 'bar';
  let commitLoadObserver = null;
  let commitListModelKey = '';
  let workingTreeModelKey = '';
  const columnWidths = {};
  let resizing = null;
  const persistedCommitListState = vscode.getState() || {};
  const legacyRefExpanded = persistedCommitListState.commitRefLabelsExpanded === true;
  const persistedFloatingButtons = persistedCommitListState.commitFloatingButtons || {};
  const floatingExpanded = {
    current: persistedFloatingButtons.current === true || (!Object.keys(persistedFloatingButtons).length && legacyRefExpanded),
    tag: persistedFloatingButtons.tag === true || (!Object.keys(persistedFloatingButtons).length && legacyRefExpanded),
    local: persistedFloatingButtons.local === true || (!Object.keys(persistedFloatingButtons).length && legacyRefExpanded),
    remote: persistedFloatingButtons.remote === true || (!Object.keys(persistedFloatingButtons).length && legacyRefExpanded),
    author: persistedFloatingButtons.author === true,
    time: persistedFloatingButtons.time === true,
  };
  const graph = document.getElementById('graph');
  Object.keys(floatingExpanded).forEach(function(kind) {
    graph.classList.toggle('commit-floating-' + kind + '-expanded', floatingExpanded[kind]);
  });

    const ROW_H = 26;
    const COMMIT_OVERSCAN = 50;
    const COMMIT_LOAD_THRESHOLD = 20;
    const LANE_W = 12;
    const expandedCommits = new Set();
    const expandedCommitRowHeights = new Map();
    let commitLayoutPrefix = [];
    let commitLayoutTotal = 0;
    let commitLayoutDirty = true;
    let commitVirtualStart = -1;
    let commitVirtualEnd = -1;
    let commitVirtualFrame = 0;
  const DOT_R = 5;
  let graphViewportWidth = 0;
  // 增量渲染状态
  let currentMaxLane = 0;
  let currentGraphW = LANE_W + 10;
  function showLoadingProgress(phase, message, current, total) {
    isCommitLoading = true;
    var c = current || 0;
    var t = total || 0;
    // 两种呈现互斥: 每次切换都要把另一种收起来, 否则会同时出现蒙版和顶部条。
    if (commitLoadingMode === 'overlay') {
      showLoadingOverlay(message, c, t);
      return;
    }
    showLoadingBar(message, c, t);
  }

  /** 全屏蒙版: 盖住提交列表, 阶段文案 / 进度 / 计数都可见。 */
  function showLoadingOverlay(message, c, t) {
    var overlay = document.getElementById('loading');
    var overlayFill = document.getElementById('progressBarFill');
    var step = document.getElementById('progressStep');
    if (message) { document.getElementById('loadingText').textContent = message; }
    if (t > 0) {
      overlayFill.classList.remove('indeterminate');
      overlayFill.style.width = Math.round(c / t * 100) + '%';
      step.textContent = c + ' / ' + t;
      step.style.display = 'block';
    } else {
      overlayFill.classList.add('indeterminate');
      overlayFill.style.width = '';
      step.textContent = '';
      step.style.display = 'none';
    }
    document.getElementById('commitList').style.display = 'none';
    document.getElementById('commitFooter').hidden = true;
    document.getElementById('countLabel').hidden = true;
    document.getElementById('commitProgress').hidden = true;
    overlay.style.display = 'block';
  }

  /** 顶部进度条: 列表照常可见, total>0 走确定比例, 否则走不定长滑动; 文案挂到 title 上。 */
  function showLoadingBar(message, c, t) {
    var overlay = document.getElementById('loading');
    var progress = document.getElementById('commitProgress');
    var fill = document.getElementById('commitProgressFill');
    overlay.style.display = 'none';
    if (message) { progress.title = message; }
    if (t > 0) {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.round(c / t * 100) + '%';
    } else {
      fill.classList.add('indeterminate');
      fill.style.width = '';
    }
    progress.hidden = false;
  }

  function hideLoadingProgress() {
    isCommitLoading = false;
    document.getElementById('loading').style.display = 'none';
    var progress = document.getElementById('commitProgress');
    var fill = document.getElementById('commitProgressFill');
    progress.hidden = true;
    progress.removeAttribute('title');
    fill.classList.remove('indeterminate');
    fill.style.width = '';
  }

  // 与仓库卡片历史编辑框保持一致: 使用完整原文, 去掉末尾换行后按第一行拆分。
  function splitCommitMessage(commit) {
    var raw = typeof commit.rawMessage === 'string' ? commit.rawMessage : '';
    while (raw.endsWith(String.fromCharCode(10)) || raw.endsWith(String.fromCharCode(13))) raw = raw.slice(0, -1);
    var lineEnd = raw.indexOf(String.fromCharCode(10));
    if (lineEnd < 0) {
      if (raw.charCodeAt(raw.length - 1) === 13) raw = raw.slice(0, -1);
      return { title: raw, body: '' };
    }
    var title = raw.slice(0, lineEnd);
    if (title.charCodeAt(title.length - 1) === 13) title = title.slice(0, -1);
    var body = raw.slice(lineEnd + 1);
    return { title: title, body: body };
  }

  document.getElementById('commitSection').addEventListener('contextmenu', function(event) {
    if (event.target.closest('#searchInput')) {
      showRepositoryMessageContextMenu(event, document.getElementById('searchInput'));
      return;
    }
    event.preventDefault();
    if (!event.target.closest('#commitList .commit-row:not(.working-tree)[data-hash][data-repository-path]')) closeAllContextMenus();
  });

  document.getElementById('commitList').addEventListener('contextmenu', function(event) {
    var row = event.target.closest('.commit-row');
    if (!row || row.classList.contains('working-tree')) return;
    event.preventDefault();
    var hash = row.getAttribute('data-hash');
    var repositoryPath = row.getAttribute('data-repository-path');
    if (!hash || !repositoryPath) { closeAllContextMenus(); return; }
    setCommitContextTarget(row, hash, repositoryPath);
    var menu = document.getElementById('commitContextMenu');
    closeAllContextMenus(menu);
    var toggle = menu.querySelector('[data-commit-action="toggleDescription"]');
    var expanded = row.classList.contains('expanded');
    toggle.querySelector('span').textContent = expanded ? '关闭描述' : '展开描述';
    var toggleIcon = menu.querySelector('#toggleDescriptionIcon');
    toggleIcon.setAttribute('d', expanded ? 'M3 10.5 8 6l5 4.5' : 'M3 5.5 8 10l5-4.5');
    // 先按初始位置展示到 top-layer, 取得真实尺寸后再按视口边界翻转定位, 避免被裁剪。
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.showPopover();
    var menuWidth = menu.offsetWidth;
    var menuHeight = menu.offsetHeight;
    var left = event.clientX + menuWidth + 4 > window.innerWidth ? Math.max(4, event.clientX - menuWidth) : event.clientX;
    var top = event.clientY + menuHeight + 4 > window.innerHeight ? Math.max(4, event.clientY - menuHeight) : event.clientY;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  });

  var commitContextTarget = null;
  function setCommitContextTarget(row, hash, repositoryPath) {
    clearCommitContextTarget();
    commitContextTarget = { row: row, hash: hash, repositoryPath: repositoryPath };
    row.classList.add('context-target');
  }
  function clearCommitContextTarget() {
    if (commitContextTarget?.row) commitContextTarget.row.classList.remove('context-target');
    commitContextTarget = null;
  }

  function refClass(ref) {
    if (ref === 'HEAD') return 'ref-head';
    if (ref.includes('/')) return 'ref-remote';
    if (ref.startsWith('tag: ')) return 'ref-tag';
    return 'ref-branch';
  }

  function renderCommitFooter() {
    const footer = document.getElementById('commitFooter');
    if (isCommitLoading && commitLoadingMode === 'overlay') {
      footer.hidden = true;
      footer.textContent = '';
      if (commitLoadObserver) commitLoadObserver.disconnect();
      return;
    }
    if (!commits.length) {
      footer.hidden = true;
      if (commitLoadObserver) commitLoadObserver.disconnect();
      return;
    }
    footer.hidden = false;
    if (commitLoadObserver) commitLoadObserver.disconnect();
    if (commitPageError) {
      footer.innerHTML = '加载更多提交失败，<button type="button" id="retryLoadMore">点击重试</button>';
      document.getElementById('retryLoadMore').addEventListener('click', function() {
        commitPageError = '';
        vscode.postMessage({ type: 'loadMoreCommits' });
      });
      return;
    }
    if (isLoadingMoreCommits) {
      footer.textContent = '正在加载更多提交...';
      return;
    }
    if (!hasMoreCommits) {
      footer.textContent = '已加载全部 ' + commits.length + ' 条提交';
      return;
    }
    footer.textContent = '继续滚动以加载更多提交';
    requestLoadMoreIfNeeded();
  }

  function requestLoadMoreIfNeeded() {
    if (!hasMoreCommits || isLoadingMoreCommits || commitLoadRequestPending) return;
    var graph = document.getElementById('graph');
    var topSpacer = document.getElementById('commitVirtualTop');
    if (!graph || !topSpacer || !commits.length) return;
    if (commitLayoutDirty) rebuildCommitLayout();
    var graphRect = graph.getBoundingClientRect();
    var regionTop = topSpacer.getBoundingClientRect().top - graphRect.top + graph.scrollTop;
    var stickyHeight = document.getElementById('commitHeader').offsetHeight
      + document.getElementById('commitSearchRow').offsetHeight;
    var viewportBottom = Math.max(0, graph.scrollTop + graph.clientHeight - regionTop);
    var lastExclusive = Math.max(1, commitUpperBound(Math.max(stickyHeight, viewportBottom)));
    var lastVisibleIndex = Math.min(commits.length - 1, lastExclusive - 1);
    if (lastVisibleIndex < commits.length - COMMIT_LOAD_THRESHOLD) return;
    commitLoadRequestPending = true;
    commitLoadRequestCount = commits.length;
    vscode.postMessage({ type: 'loadMoreCommits' });
  }
  // 标签和轨道共用官方泳道索引，确保横线始终从当前提交点向右连接。
  function rowMaxSwimlane(c) {
    var inputCount = (c.inputSwimlanes || []).length;
    var outputCount = (c.outputSwimlanes || []).length;
    var inputIndex = (c.inputSwimlanes || []).findIndex(function(lane) { return lane.hash === c.hash; });
    var circleIndex = inputIndex >= 0 ? inputIndex : inputCount;
    return Math.max(circleIndex, inputCount - 1, outputCount - 1, 0);
  }

  // 单行 SVG 宽度 = 该行实际泳道所需宽度; 描述随每行泳道紧贴, 泳道少的行不再留全表最大空白。
  // 坐标系与 width 同值保证 1:1 不缩放; (max+1)*LANE_W + 6 含节点半径余量。
  function rowGraphW(c) {
    return (rowMaxSwimlane(c) + 1) * LANE_W + 6;
  }

  // 每类 ref 最多渲染一个图标位：当前分支、Tag、本地分支、远程分支。
  // 分支分类严格来自 branches 元数据；Tag 来自原生层规范化后的 "tag: " 前缀。
  function categorizedRefs(refs, repositoryPath) {
    var categories = [
      { kind: 'current', icon: 'target', labels: [] },
      { kind: 'tag', icon: 'tag', labels: [] },
      { kind: 'local', icon: 'device-desktop', labels: [] },
      { kind: 'remote', icon: 'cloud', labels: [] },
    ];
    var byKind = {};
    categories.forEach(function(category) { byKind[category.kind] = category; });
    refs.forEach(function(ref) {
      var kind = ref.startsWith('tag: ') ? 'tag' : undefined;
      var label = ref;
      if (!kind) {
        var matches = branches.filter(function(branch) {
          return branch.repoOption.path === repositoryPath && branch.label === ref;
        });
        var current = matches.find(function(branch) { return branch.kind === 'current'; });
        if (current) { kind = 'current'; label = current.label; }
        else if (matches.some(function(branch) { return branch.kind === 'local'; })) kind = 'local';
        else if (matches.some(function(branch) { return branch.kind === 'remote'; })) kind = 'remote';
      }
      if (kind && !byKind[kind].labels.includes(label)) byKind[kind].labels.push(label);
    });
    return categories.filter(function(category) { return category.labels.length > 0; });
  }


  // 提交节点颜色由其所在泳道决定；分支图标签与描述标签共用该颜色。
  function commitLaneColor(c) {
    var inputSwimlanes = c.inputSwimlanes || [];
    var outputSwimlanes = c.outputSwimlanes || [];
    var inputIndex = inputSwimlanes.findIndex(function(lane) { return lane.hash === c.hash; });
    var circleIndex = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
    return (outputSwimlanes[circleIndex] || inputSwimlanes[circleIndex] || {}).color || c.laneColor || '#888';
  }

  function setFloatingExpanded(kind, expanded, persist) {
    floatingExpanded[kind] = expanded;
    graph.classList.toggle('commit-floating-' + kind + '-expanded', expanded);
    document.querySelectorAll('[data-floating-kind="' + kind + '"]').forEach(function(item) {
      item.setAttribute('aria-expanded', String(expanded));
    });
    requestAnimationFrame(syncVisibleCommitRowRefReservations);
    if (!persist) return;
    var state = vscode.getState() || {};
    state.commitFloatingButtons = Object.assign({}, floatingExpanded);
    vscode.setState(state);
  }

  // 标题和右侧悬浮按钮处于同一行；按每行实际按钮宽度预留标题尾部，避免文字落在按钮下方。
  function reserveCommitRowRefs(row) {
    var refGroup = row.querySelector('.commit-row-refs');
    var main = row.querySelector('.col-main');
    if (!main) return;
    main.style.setProperty('--commit-row-refs-width', refGroup ? (refGroup.offsetWidth + 16) + 'px' : '0px');
  }

  function syncVisibleCommitRowRefReservations() {
    document.querySelectorAll('#commitVirtualRows .commit-row, #commitWorkingTreeRows .commit-row').forEach(reserveCommitRowRefs);
  }

  // 描述列的分支标签: 仅标注当前分支 HEAD 与其 upstream 远程分支 HEAD。
  // upstream 取自 for-each-ref 的 %(upstream), 不按 origin/<name> 命名约定猜测。
  function headBranchLabels(c) {
    var repositoryPath = c.gitBranchOption.repoOption.path;
    var sameRepo = branches.filter(function(branch) {
      return branch.repoOption.path === repositoryPath;
    });
    var current = sameRepo.find(function(branch) { return branch.kind === 'current'; });
    if (!current) return [];
    // 当前分支由 HEAD watcher 提供时不带 upstream, 回落到同名 local ref 记录。
    var localRef = sameRepo.find(function(branch) {
      return branch.kind === 'local' && branch.name === current.name;
    });
    var upstreamName = current.upstreamName || (localRef && localRef.upstreamName);
    var upstream = upstreamName ? sameRepo.find(function(branch) {
      return branch.kind === 'remote' && branch.name === upstreamName;
    }) : undefined;
    // 当前分支用靶子图标, 远程分支用云图标, 图标由 kind 决定而非标签文本。
    var labels = [];
    if (current.hash === c.hash) labels.push({ label: current.label, icon: 'target' });
    if (upstream && upstream.hash === c.hash) labels.push({ label: upstream.label, icon: 'cloud' });
    return labels;
  }

  // 构建单行提交 HTML
  function buildCommitRowHTML(i, graphW) {
    var c = commits[i];
    var commitKey = c.gitBranchOption.repoOption.path + ':' + c.hash;
    var selected = selectedCommitHash === c.hash && c.gitBranchOption.repoOption.path === selectedCommitRepositoryPath;
    // 描述只能在当前高亮 commit 上显示。
    var expanded = selected && expandedCommits.has(commitKey);
    var html = '<div class="commit-row' + (expanded ? ' expanded' : '') + (selected ? ' selected' : '') + '" data-hash="' + escapeAttr(c.hash) + '" data-repository-path="' + escapeAttr(c.gitBranchOption.repoOption.path) + '" data-row="' + i + '" data-has-description="true">';
    var repositoryPath = c.gitBranchOption.repoOption.path;
    var commitMessage = splitCommitMessage(c);
    // 每个分支类别独立展开；Commit 详情由行悬浮卡与展开描述提供。
    var refChipsHtml = categorizedRefs(c.refs || [], repositoryPath).map(function(category) {
      var label = category.labels.join(', ');
      return '<span class="commit-row-ref commit-row-ref--' + category.kind + '" data-floating-kind="' + category.kind + '" role="button" tabindex="0" aria-expanded="' + String(floatingExpanded[category.kind]) + '" title="' + escapeAttr(label) + '">'
        + '<span class="codicon codicon-' + category.icon + '" aria-hidden="true"></span>'
        + '<span class="commit-row-ref-label">' + escapeHtml(label) + '</span></span>';
    }).join('');
    var floatingInfoHtml = [
      { kind: 'author', icon: 'account', label: c.author, title: c.author },
      { kind: 'time', icon: 'calendar', label: c.authorDateLabel, title: c.authorDateLabel },
    ].filter(function(info) { return Boolean(info.label); }).map(function(info) {
      return '<span class="commit-row-info commit-row-info--' + info.kind + '" data-floating-kind="' + info.kind + '" role="button" tabindex="0" aria-expanded="' + String(floatingExpanded[info.kind]) + '" title="' + escapeAttr(info.title || info.label) + '">'
        + '<span class="codicon codicon-' + info.icon + '" aria-hidden="true"></span>'
        + '<span class="commit-row-info-label">' + escapeHtml(info.label) + '</span></span>';
    }).join('');
    // col-main: SVG(仅泳道, 按本行泳道宽) + 摘要行 + 展开后的描述, 同属一个字段。
    var rowW = rowGraphW(c);
    html += '<div class="col-main">';
    html += '<svg class="graph-svg" width="' + rowW + '" height="' + ROW_H + '" viewBox="0 0 ' + rowW + ' ' + ROW_H + '"></svg>';
    html += '<div class="col-main-summary"><span class="commit-message-text">' + escapeHtml(commitMessage.title) + '</span></div>';
    var parentList = (c.parents || []).map(function(parent) { return parent.slice(0, 12); }).join(' ');
    var detailItem = function(icon, label, value, valueClass) {
      if (!value) return '';
      return '<div class="commit-detail-item"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span><span class="commit-detail-label">' + escapeHtml(label) + '</span><span class="commit-detail-value' + (valueClass ? ' ' + valueClass : '') + '">' + escapeHtml(value) + '</span></div>';
    };
    var detailMeta = detailItem('account', '作者', c.authorEmail ? c.author + ' <' + c.authorEmail + '>' : c.author)
      + detailItem('git-branch', '分支', categorizedRefs(c.refs || [], repositoryPath).map(function(category) {
        return category.labels.join(', ');
      }).join(' · '))
      + detailItem('calendar', '时间', c.authorDate ? new Date(c.authorDate).toString() : c.authorDateLabel)
      + detailItem('git-commit', 'Commit', c.shortHash || c.hash, 'commit-detail-value--hash')
      + detailItem('git-merge', '父提交', parentList, 'commit-detail-value--parents');
    var bodyHtml = commitMessage.body ? '<div class="commit-description-body">' + escapeHtml(commitMessage.body) + '</div>' : '';
    html += '<div class="commit-description' + (bodyHtml ? ' has-body' : '') + '">' + bodyHtml
      + '<div class="commit-description-meta">' + detailMeta + '</div></div>';
    html += '</div>';
    if (refChipsHtml || floatingInfoHtml) html += '<span class="commit-row-refs">' + refChipsHtml + floatingInfoHtml + '</span>';
    html += '</div>';
    return html;
  }

  // 仅更新提交选择，避免无关状态改变时重绘整张提交图。
  function applyCommitSelection(hash, repositoryPath) {
    var selectedKey = (repositoryPath || '') + ':' + (hash || '');
    var collapsedExpandedCommit = false;
    expandedCommits.forEach(function(key) {
      if (key !== selectedKey) { expandedCommits.delete(key); collapsedExpandedCommit = true; }
    });
    if (collapsedExpandedCommit) { commitLayoutDirty = true; scheduleCommitVirtualWindow(); }
    // 不重建列表，避免 Store 确认前的旧快照撤销乐观高亮。
    document.querySelectorAll('.commit-row.expanded').forEach(function(row) {
      var rowKey = (row.getAttribute('data-repository-path') || '') + ':' + (row.getAttribute('data-hash') || '');
      if (rowKey === selectedKey) return;
      row.classList.remove('expanded');
      var svg = row.querySelector('svg');
      var index = Number(row.getAttribute('data-row'));
      if (svg && Number.isInteger(index) && commits[index]) {
        var rowW = rowGraphW(commits[index]);
        svg.setAttribute('width', String(rowW));
        svg.setAttribute('height', String(ROW_H));
        svg.setAttribute('viewBox', '0 0 ' + rowW + ' ' + ROW_H);
        drawSvg(svg, index, rowW, ROW_H, LANE_W, DOT_R);
      }
    });
    document.querySelectorAll('.commit-row.selected').forEach(function(row) {
      var rowHash = row.getAttribute('data-hash');
      var rowRepositoryPath = row.getAttribute('data-repository-path') || '';
      if (rowHash !== hash || rowRepositoryPath !== repositoryPath) {
        row.classList.remove('selected');
      }
    });
    if (!hash) return;
    document.querySelectorAll('.commit-row').forEach(function(row) {
      if (row.getAttribute('data-hash') !== hash) return;
      var rowRepositoryPath = row.getAttribute('data-repository-path') || '';
      if (rowRepositoryPath === repositoryPath
          || (!repositoryPath && isWorkingTreeHash(hash))) {
        row.classList.add('selected');
      }
    });
  }

  function applySelectedCommit() {
    applyCommitSelection(selectedCommitHash, selectedCommitRepositoryPath);
  }

  // 为单行设置 SVG 和点击监听

  function setupRow(row, graphW) {
    // 工作区虚拟行(changes/staged)的 SVG 由 workingTreeGraphSvg 在模板中直接生成, 不走 commit 的 drawSvg。
    var isWorkingTree = row.classList.contains('working-tree');
    var svg = row.querySelector('svg');
    if (svg && !isWorkingTree) {
      var idx = Number(row.getAttribute('data-row'));
      // 每行按自身泳道宽度绘制, 使描述紧贴泳道; graphW 仅作无对应 commit 时的兜底。
      var rowW = commits[idx] ? rowGraphW(commits[idx]) : graphW;
      svg.setAttribute('width', String(rowW));
      svg.setAttribute('height', String(ROW_H));
      svg.setAttribute('viewBox', '0 0 ' + rowW + ' ' + ROW_H);
      drawSvg(svg, idx, rowW, ROW_H, LANE_W, DOT_R);
    }
    var refGroup = row.querySelector('.commit-row-refs');
    if (refGroup) {
      var toggleRefGroup = function(event) {
        var button = event.target && event.target.closest('[data-floating-kind]');
        if (!button || !refGroup.contains(button)) return;
        var kind = button.getAttribute('data-floating-kind');
        if (!kind || !Object.prototype.hasOwnProperty.call(floatingExpanded, kind)) return;
        event.preventDefault();
        event.stopPropagation();
        setFloatingExpanded(kind, !floatingExpanded[kind], true);
      };
      refGroup.addEventListener('click', toggleRefGroup);
      refGroup.addEventListener('keydown', function(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        toggleRefGroup(event);
      });
      refGroup.addEventListener('transitionend', function(event) {
        if (event.propertyName !== 'max-width') return;
        if (!event.target.matches('.commit-row-ref-label, .commit-row-info-label')) return;
        reserveCommitRowRefs(row);
      });
    }
    reserveCommitRowRefs(row);
    row.addEventListener('click', function(event) {
      if (row.classList.contains('disabled')) return;
      if (event.target && event.target.closest('.commit-description')) return;
      var hash = row.getAttribute('data-hash');
      var repositoryPath = row.getAttribute('data-repository-path');
      var commitKey = repositoryPath + ':' + hash;
      var wasSelected = row.classList.contains('selected');
      var wasExpanded = expandedCommits.has(commitKey);
      // 展开属于本地展示细节；提交选择只通过 intent 更新 Store。
      if (!hash || !repositoryPath || row.dataset.hasDescription !== 'true') {
      if (isWorkingTreeHash(hash)) {
        var virtualRepositoryPath = row.getAttribute('data-repository-path') || selectedRepositoryPaths[0] || '';
        applyCommitSelection(hash, virtualRepositoryPath);
        vscode.postMessage({ type: 'selectCommit', hash: hash });
        } else if (hash && repositoryPath) {
          applyCommitSelection(hash, repositoryPath);
          vscode.postMessage({ type: 'selectCommit', hash: hash, repositoryPath: repositoryPath });
        }
        return;
      }
      if (wasSelected) {
        if (wasExpanded) expandedCommits.delete(commitKey);
        else expandedCommits.add(commitKey);
        commitLayoutDirty = true;
        render();
        return;
      }
      applyCommitSelection(hash, repositoryPath);
      vscode.postMessage({ type: 'selectCommit', hash: hash, repositoryPath: repositoryPath });
    });
  }

  // 计算官方输入/输出泳道的最大列索引。
  function calcMaxLane(startIndex) {
    var maxLane = startIndex > 0 ? currentMaxLane : 0;
    for (var i = startIndex; i < commits.length; i++) {
      maxLane = Math.max(maxLane, rowMaxSwimlane(commits[i]));
    }
    return maxLane;
  }

  function updateCountLabel() {
    var label = document.getElementById('countLabel');
    // 蒙版模式计数随列表一起让位; 进度条模式下列表可见, 计数也要留住,
    //   只有"首轮尚未读出任何提交"才隐藏, 避免显示 —/0。
    if (isCommitLoading && (commitLoadingMode === 'overlay' || commits.length === 0)) {
      label.hidden = true;
      label.textContent = '';
      return;
    }
    var total = commits.length;
    if (selectedCommitHash && !isWorkingTreeHash(selectedCommitHash)) {
      var idx = commits.findIndex(function(c) { return c.hash === selectedCommitHash; });
      if (idx >= 0) {
        label.textContent = (idx + 1) + '/' + total;
        return;
      }
    }
    label.textContent = '—/' + total;
  }

  // 虚拟行泳道: 与首个 commit 对齐(cx = LANE_W/2 + 5 = 11), 画空心圆节点,
  //   并向下用虚线连接到下方节点(HEAD), 表示合并后的 Uncommitted Changes 行仍处在历史链条上。
  function workingTreeGraphSvg(hash) {
    const cx = LANE_W / 2 + 5;
    const cy = ROW_H / 2;
    const r = DOT_R;
    const width = LANE_W + 10;
    const color = 'var(--vscode-descriptionForeground, #999)';
    let inner = '';
    if (hash === 'uncommitted') {
      inner += '<path d="M ' + cx + ' ' + (cy + r) + ' V ' + ROW_H + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="2 2" stroke-linecap="round"/>';
    }
    inner += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--vscode-editor-background)" stroke="' + color + '" stroke-width="1.5"/>';
    return '<svg width="' + width + '" height="' + ROW_H + '" viewBox="0 0 ' + width + ' ' + ROW_H + '">' + inner + '</svg>';
  }

  function workingTreeRowHTML(hash, label, enabled) {
    const selectedBranch = getSelectedCurrentBranch();
    const repositoryPath = selectedBranch?.repoOption.path || selectedCommitRepositoryPath || selectedRepositoryPaths[0] || '';
    const selected = selectedCommitHash === hash ? ' selected' : '';
    const disabled = enabled ? '' : ' disabled';
    return '<div class="commit-row working-tree' + selected + disabled + '" data-hash="' + hash + '" data-repository-path="' + escapeHtml(repositoryPath) + '" aria-disabled="' + String(!enabled) + '">' +
      '<div class="col-main"><span class="graph-svg">' + workingTreeGraphSvg(hash) + '</span><div class="col-main-summary working-tree-label working-tree-label--' + hash + '">' + label + '</div></div></div>';
  }

  function getSelectedCurrentBranch() {
    return branches.find(function(branch) {
      return branch.kind === 'current'
        && selectedBranches.includes(branch.name)
        && selectedRepositoryPaths.includes(branch.repoOption.path);
    });
  }

  function isWorkingTreeHash(hash) {
    return hash === 'uncommitted';
  }

  function workingTreeRowsHTML() {
    // 只有单一行(uncommitted), 但 insertAdjacentHTML('afterbegin') 仍需与后端下发顺序一致, 此处保留倒序拼接以兼容多行情形。
    return workingTreeRowsState.slice().reverse().map(function(row) {
      return workingTreeRowHTML(row.hash, row.label, row.enabled);
    }).join('');
  }

  function updateWorkingTreeRows() {
    const host = document.getElementById('commitWorkingTreeRows');
    if (!host) return;
    const branch = getSelectedCurrentBranch();
    host.innerHTML = branch ? workingTreeRowsHTML() : '';
    host.querySelectorAll('.working-tree').forEach(function(row) { setupRow(row, currentGraphW); });
    scheduleCommitVirtualWindow();
  }

  function commitKeyAt(index) {
    const commit = commits[index];
    return commit ? commit.gitBranchOption.repoOption.path + ':' + commit.hash : '';
  }

  function commitLogicalHeight(index) {
    const key = commitKeyAt(index);
    return key && expandedCommits.has(key) ? (expandedCommitRowHeights.get(key) || ROW_H) : ROW_H;
  }

  function rebuildCommitLayout() {
    commitLayoutPrefix = new Array(commits.length + 1);
    commitLayoutPrefix[0] = 0;
    for (let index = 0; index < commits.length; index++) {
      commitLayoutPrefix[index + 1] = commitLayoutPrefix[index] + commitLogicalHeight(index);
    }
    commitLayoutTotal = commitLayoutPrefix[commits.length] || 0;
    commitLayoutDirty = false;
  }

  function commitLowerBound(offset) {
    let low = 0, high = commits.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (commitLayoutPrefix[middle + 1] > offset) high = middle; else low = middle + 1;
    }
    return Math.min(low, Math.max(0, commits.length - 1));
  }

  function commitUpperBound(offset) {
    let low = 0, high = commits.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (commitLayoutPrefix[middle] < offset) low = middle + 1; else high = middle;
    }
    return Math.min(low, commits.length);
  }

  function commitVirtualRange(graph) {
    if (commitLayoutDirty) rebuildCommitLayout();
    const topSpacer = document.getElementById('commitVirtualTop');
    if (!topSpacer || !commits.length) return { start: 0, end: 0 };
    const graphRect = graph.getBoundingClientRect();
    const regionTop = topSpacer.getBoundingClientRect().top - graphRect.top + graph.scrollTop;
    const stickyHeight = document.getElementById('commitHeader').offsetHeight + document.getElementById('commitSelectors').offsetHeight + document.getElementById('commitSearchRow').offsetHeight;
    const viewportTop = Math.max(0, graph.scrollTop + stickyHeight - regionTop);
    const viewportBottom = Math.max(viewportTop, graph.scrollTop + graph.clientHeight - regionTop);
    const first = commitLowerBound(viewportTop);
    const lastExclusive = Math.max(first + 1, commitUpperBound(viewportBottom));
    return {
      start: Math.max(0, first - COMMIT_OVERSCAN),
      end: Math.min(commits.length, lastExclusive + COMMIT_OVERSCAN),
    };
  }

  function measureExpandedCommitRows() {
    let changed = false;
    document.querySelectorAll('#commitVirtualRows .commit-row.expanded[data-row]').forEach(function(row) {
      const index = Number(row.getAttribute('data-row'));
      const key = Number.isInteger(index) ? commitKeyAt(index) : '';
      const height = row.getBoundingClientRect().height;
      if (!key || height <= 0 || Math.abs((expandedCommitRowHeights.get(key) || ROW_H) - height) < .5) return;
      expandedCommitRowHeights.set(key, height);
      changed = true;
    });
    if (!changed) return;
    commitLayoutDirty = true;
    rebuildCommitLayout();
    const top = document.getElementById('commitVirtualTop');
    const bottom = document.getElementById('commitVirtualBottom');
    if (top) top.style.height = (commitLayoutPrefix[commitVirtualStart] || 0) + 'px';
    if (bottom) bottom.style.height = Math.max(0, commitLayoutTotal - (commitLayoutPrefix[commitVirtualEnd] || 0)) + 'px';
    scheduleCommitVirtualWindow();
  }

  function renderCommitVirtualWindow(force) {
    const graph = document.getElementById('graph');
    const rowsHost = document.getElementById('commitVirtualRows');
    const top = document.getElementById('commitVirtualTop');
    const bottom = document.getElementById('commitVirtualBottom');
    if (!graph || !rowsHost || !top || !bottom || !commits.length) return;
    const range = commitVirtualRange(graph);
    if (!force && range.start === commitVirtualStart && range.end === commitVirtualEnd) return;
    // 原生滚动锚定会把顶部 spacer 的增长再次累加到 scrollTop，形成“越渲染越往下”的正反馈。
    // 虚拟列表的总高度和行位置已由上下 spacer 保持，这里只允许用户滚动改变 scrollTop。
    const stableScrollTop = graph.scrollTop;
    commitVirtualStart = range.start;
    commitVirtualEnd = range.end;
    top.style.height = (commitLayoutPrefix[range.start] || 0) + 'px';
    bottom.style.height = Math.max(0, commitLayoutTotal - (commitLayoutPrefix[range.end] || 0)) + 'px';
    let html = '';
    for (let index = range.start; index < range.end; index++) html += buildCommitRowHTML(index, currentGraphW);
    rowsHost.innerHTML = html;
    rowsHost.querySelectorAll('.commit-row').forEach(function(row) { setupRow(row, currentGraphW); });
    measureExpandedCommitRows();
    renderCommitFooter();
    if (Math.abs(graph.scrollTop - stableScrollTop) >= .5) graph.scrollTop = stableScrollTop;
  }

  function scheduleCommitVirtualWindow() {
    if (commitVirtualFrame) return;
    commitVirtualFrame = requestAnimationFrame(function() {
      commitVirtualFrame = 0;
      renderCommitVirtualWindow(false);
    });
  }

  document.getElementById('graph').addEventListener('scroll', function() {
    scheduleCommitVirtualWindow();
    requestLoadMoreIfNeeded();
  }, { passive: true });

  function captureVisibleCommitAnchor(graph, list) {
    if (!graph || !list) return null;
    var graphTop = graph.getBoundingClientRect().top;
    var rows = list.querySelectorAll('.commit-row[data-hash][data-repository-path]');
    for (var index = 0; index < rows.length; index++) {
      var row = rows[index];
      var top = row.getBoundingClientRect().top - graphTop;
      var bottom = row.getBoundingClientRect().bottom - graphTop;
      if (bottom > 0 && top < graph.clientHeight) {
        return {
          hash: row.getAttribute('data-hash'),
          repositoryPath: row.getAttribute('data-repository-path'),
          top: top
        };
      }
    }
    return null;
  }

  function restoreVisibleCommitAnchor(graph, list, anchor, fallbackScrollTop) {
    if (!graph) return;
    if (!anchor) {
      graph.scrollTop = fallbackScrollTop;
      return;
    }
    var selector = '.commit-row[data-hash="' + CSS.escape(anchor.hash || '') + '"][data-repository-path="' + CSS.escape(anchor.repositoryPath || '') + '"]';
    var row = list.querySelector(selector);
    if (!row) {
      graph.scrollTop = fallbackScrollTop;
      return;
    }
    var top = row.getBoundingClientRect().top - graph.getBoundingClientRect().top;
    graph.scrollTop = Math.max(0, graph.scrollTop + top - anchor.top);
  }

  function render() {
    if (selectedRepositoryPaths.length === 0) {
      const list = document.getElementById('commitList');
      list.style.display = 'block';
      list.innerHTML = '<div id="commitEmpty">暂未选中仓库</div>';
      commitVirtualStart = -1; commitVirtualEnd = -1;
      document.getElementById('commitFooter').hidden = true;
      document.getElementById('countLabel').hidden = true;
      return;
    }
    // 蒙版模式下旧列表已经没有参考价值, 直接让位给蒙版; 进度条模式下列表必须继续渲染。
    if (isCommitLoading && commitLoadingMode === 'overlay') {
      document.getElementById('commitList').style.display = 'none';
      document.getElementById('commitFooter').hidden = true;
      document.getElementById('countLabel').hidden = true;
      return;
    }
    const graph = document.getElementById('graph');
    const scrollTop = graph ? graph.scrollTop : 0;
    const list = document.getElementById('commitList');
    const visibleCommitAnchor = captureVisibleCommitAnchor(graph, list);
    if (commits.length === 0) {
      list.style.display = 'block';
      list.innerHTML = '<div id="commitEmpty">暂无提交记录</div>';
      commitVirtualStart = -1;
      commitVirtualEnd = -1;
      renderCommitFooter();
      return;
    }
    list.style.display = 'block';

    // 分支图 SVG 宽度 = 全列表最大泳道数所需宽度; 分支标签已迁出 SVG 不参与。
    var laneCount = calcMaxLane(0) + 1;
    currentMaxLane = laneCount - 1;
    var naturalGraphW = laneCount * LANE_W + 10;
    graphViewportWidth = graph ? graph.clientWidth : 0;
    var graphW = naturalGraphW;
    currentGraphW = graphW;
    // 只重建四列表头; 搜索住在 #commitHeaderSearch 里, 用 commitHeader.innerHTML 会把它一起冲掉。
    document.getElementById('commitHeaderColumns').innerHTML = '<div>Commit列表</div>';
    var selectedBranch = getSelectedCurrentBranch();
    var workingTreeHtml = selectedBranch ? workingTreeRowsState.map(function(row) {
      return workingTreeRowHTML(row.hash, row.label, row.enabled);
    }).join('') : '';

    commitLayoutDirty = true;
    rebuildCommitLayout();
    commitVirtualStart = -1;
    commitVirtualEnd = -1;
    // 工作区虚拟行始终保留；普通提交只挂载可视范围与前后各 50 条。
    list.innerHTML = '<div id="commitWorkingTreeRows">' + workingTreeHtml + '</div>'
      + '<div id="commitVirtualTop" class="commit-virtual-spacer"></div>'
      + '<div id="commitVirtualRows"></div>'
      + '<div id="commitVirtualBottom" class="commit-virtual-spacer" style="height:' + commitLayoutTotal + 'px"></div>';

    // SVG 泳道子列宽随泳道数变化; col-main 总宽由 --main-width (默认 = 泳道宽 + 60ch) 决定。
    graph.style.setProperty('--graph-lane-width', naturalGraphW + 'px');
    list.style.setProperty('--graph-lane-width', naturalGraphW + 'px');
    document.querySelectorAll('#commitWorkingTreeRows .commit-row').forEach(function(row) { setupRow(row, graphW); });
    renderCommitVirtualWindow(true);

    updateCountLabel();
    restoreVisibleCommitAnchor(graph, list, visibleCommitAnchor, scrollTop);
  }

  function drawSvg(svg, idx, graphW, rowH, laneW, dotR) {
    const c = commits[idx];
    const expanded = selectedCommitHash === c.hash
      && selectedCommitRepositoryPath === c.gitBranchOption.repoOption.path
      && expandedCommits.has(c.gitBranchOption.repoOption.path + ':' + c.hash);
    const svgH = expanded ? svg.closest('.commit-row').getBoundingClientRect().height : rowH;
    const y = rowH / 2;
    const detailsBottom = Math.max(rowH, svgH);
    svg.setAttribute('height', String(svgH));
    svg.setAttribute('viewBox', '0 0 ' + graphW + ' ' + svgH);
    let content = '';

    const inputSwimlanes = c.inputSwimlanes || [];
    const outputSwimlanes = c.outputSwimlanes || [];
    const inputIndex = inputSwimlanes.findIndex(function(lane) { return lane.hash === c.hash; });
    const circleIndex = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
    const cx = circleIndex * laneW + laneW / 2 + 5;
    const commitColor = commitLaneColor(c);
    const laneX = function(index) { return index * laneW + laneW / 2 + 5; };

    let outputIndex = 0;

    // 主 lane 替换为第一父时才消耗输出槽位；同 hash 的其余 lane 在当前节点汇入。
    for (let index = 0; index < inputSwimlanes.length; index++) {
      const inputLane = inputSwimlanes[index];
      if (inputLane.hash === c.hash) {
        if (index === inputIndex) {
          if (c.parents.length > 0) { outputIndex++; }
        } else {
          const x1 = laneX(index);
          const curveHeight = y;
          content += '<path d="M ' + x1 + ' 0 C ' + x1 + ' ' + (curveHeight * 0.45) + ' ' + cx + ' ' + (curveHeight * 0.75) + ' ' + cx + ' ' + y + '" fill="none" stroke="' + inputLane.color + '" stroke-width="1.5" stroke-linecap="round"/>';
        }
        continue;
      }
      if (outputIndex >= outputSwimlanes.length || inputLane.hash !== outputSwimlanes[outputIndex].hash) {
        continue;
      }
      const x1 = laneX(index);
      const x2 = laneX(outputIndex);
      if (index === outputIndex) {
        content += '<path d="M ' + x1 + ' 0 V ' + detailsBottom + '" fill="none" stroke="' + inputLane.color + '" stroke-width="1.5" stroke-linecap="round"/>';
      } else {
        const radius = 5;
        const direction = x2 > x1 ? 1 : -1;
        content += '<path d="M ' + x1 + ' 0 V ' + (y - radius) + ' A ' + radius + ' ' + radius + ' 0 0 ' + (direction > 0 ? 1 : 0) + ' ' + (x1 + direction * radius) + ' ' + y + ' H ' + (x2 - direction * radius) + ' A ' + radius + ' ' + radius + ' 0 0 ' + (direction > 0 ? 0 : 1) + ' ' + x2 + ' ' + (y + radius) + ' V ' + detailsBottom + '" fill="none" stroke="' + inputLane.color + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
      outputIndex++;
    }

    // 当前节点到父提交的边：已在输入泳道的节点只连后续父；新分支首节点连全部父。
    // 后续父可能与既有轨道同 hash，按 VS Code 连接最后追加的输出泳道。
    const firstConnectedParent = inputIndex >= 0 ? 1 : 0;
    for (let parentIndex = firstConnectedParent; parentIndex < c.parents.length; parentIndex++) {
      let parentOutputIndex = -1;
      for (let index = outputSwimlanes.length - 1; index >= 0; index--) {
        if (outputSwimlanes[index].hash === c.parents[parentIndex]) {
          parentOutputIndex = index;
          break;
        }
      }
      if (parentOutputIndex < 0) { continue; }
      const parentX = laneX(parentOutputIndex);
      const color = inputIndex < 0 ? commitColor : outputSwimlanes[parentOutputIndex].color;
      if (parentX === cx) {
        content += '<path d="M ' + cx + ' ' + y + ' V ' + detailsBottom + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
      } else {
        const curveHeight = detailsBottom - y;
        content += '<path d="M ' + cx + ' ' + y + ' C ' + cx + ' ' + (y + curveHeight * 0.35) + ' ' + parentX + ' ' + (y + curveHeight * 0.65) + ' ' + parentX + ' ' + detailsBottom + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
    }

    if (inputIndex >= 0) {
      content += '<path d="M ' + cx + ' 0 V ' + y + '" fill="none" stroke="' + inputSwimlanes[inputIndex].color + '" stroke-width="1.5" stroke-linecap="round"/>';
      if (c.parents.length > 0) {
        content += '<path d="M ' + cx + ' ' + y + ' V ' + detailsBottom + '" fill="none" stroke="' + commitColor + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
    }

    // 工作区虚拟行插在列表最前(afterbegin), 其正下方就是 commits[0]。Uncommitted Changes 行向下垂一段虚线,
    //   需在该首行 commit 节点上方补一段虚线衔接, 使 Uncommitted Changes 与节点视觉连通。
    //   判定用 idx===0(布局上紧邻虚拟行)而非 refs 含 'HEAD'(部分仓库首行 refs 无字面量 HEAD, 导致永不命中)。
    var hasUncommittedRow = workingTreeRowsState.some(function(row) { return row.hash === 'uncommitted'; });
    if (idx === 0 && hasUncommittedRow && inputIndex < 0) {
      content += '<path d="M ' + cx + ' 0 V ' + y + '" fill="none" stroke="var(--vscode-descriptionForeground, #999)" stroke-width="1.5" stroke-dasharray="2 2" stroke-linecap="round"/>';
    }

    if (cx !== undefined) {
      // 分支标签已迁至描述字段的摘要行(chip), SVG 只保留泳道与节点。
      const isHead = c.refs && c.refs.some(function(r) { return r === 'HEAD'; });
      const isJoin = (c.parents && c.parents.length > 1) || inputSwimlanes.filter(function(lane) { return lane.hash === c.hash; }).length > 1;
      const r = isHead ? dotR + 2 : dotR;
      if (isJoin) {
        const outerR = r + 1;
        const innerR = Math.max(2, r - 3);
        content += '<circle class="join-dot" cx="' + cx + '" cy="' + y + '" r="' + outerR + '" fill="var(--vscode-editor-background)" stroke="' + commitColor + '" stroke-width="1.5"/>';
        content += '<circle class="join-dot" cx="' + cx + '" cy="' + y + '" r="' + innerR + '" fill="' + commitColor + '" stroke="none"/>';
      } else {
        content += '<circle class="dot" cx="' + cx + '" cy="' + y + '" r="' + r + '" fill="' + commitColor + '"/>';
      }
      if (isHead) {
        content += '<circle class="dot" cx="' + cx + '" cy="' + y + '" r="' + (r + 3) + '" fill="none" stroke="' + commitColor + '" stroke-width="1.5"/>';
      }
    }

    svg.innerHTML = content;
  }

  function setColumnWidth(list, key, width, force) {
    if (force || columnWidths[key] === undefined) {
      columnWidths[key] = width;
    }
    const graph = document.getElementById('graph');
    if (graph) graph.style.setProperty('--' + key + '-width', columnWidths[key]);
    list.style.setProperty('--' + key + '-width', columnWidths[key]);
  }

  function applyColumnWidths() {
    const list = document.getElementById('commitList');
    const graph = document.getElementById('graph');
    for (const key in columnWidths) {
      if (graph) graph.style.setProperty('--' + key + '-width', columnWidths[key]);
      if (list) list.style.setProperty('--' + key + '-width', columnWidths[key]);
    }
  }
`;
