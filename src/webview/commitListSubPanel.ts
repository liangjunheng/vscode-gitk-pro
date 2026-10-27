/**
 * Commit 列表子面板: 承载 webview 左侧提交图区域的样式、结构与交互脚本。
 * 三段片段按原样迁移自 GitkViewProvider 的内联 webview;
 * 脚本片段与宿主片段、changedFilesSubPanel 片段拼接在同一个 IIFE 内, 共享同一作用域。
 */

/** Commit 列表子面板的样式片段。 */
export const COMMIT_LIST_SUB_PANEL_STYLES = `
  #commitGraphViewport { flex: 1 1 auto; min-width: 0; min-height: 0; }
  #commitSection #commitGraphViewport > #graph { height: 100%; }
  /* 提交区的自定义滚动条只覆盖提交内容，避开选择器与搜索栏。 */
  #commitSection .overlay-scroll-track.vertical { top: 2px; }
  #graph { --graph-lane-width: 22px; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; overflow-anchor: none; display: flex; flex-direction: column; font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif); font-size: var(--vscode-font-size, 13px); }
  /* 竖向铺满: 列表吃掉表头以外的剩余高度。flex-shrink 必须为 0, 否则内容超高时会被压扁而无法滚动。 */
  #commitList { flex: 1 0 auto; width: 100%; min-width: 0; }
  #commitWorkingTreeRows, #commitVirtualRows { width: 100%; min-width: 0; }
  .commit-virtual-spacer { width: 1px; min-height: 0; pointer-events: none; }
  /* 搜索/计数/刷新都是提交列表的能力, 随面板一起放在列头之上并吸顶。 */
  .count { opacity: 0.7; font-size: calc(var(--vscode-font-size, 13px) - 1px); white-space: nowrap; }
  #searchBox { display: flex; align-items: center; position: relative; }
  #searchInput { width: 100px; height: 26px; box-sizing: border-box; padding: 3px 22px 3px 24px; font-family: inherit; font-size: inherit; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, inherit); border-radius: 4px; transition: border-color 0.15s, box-shadow 0.15s; }
  #searchInput:focus { outline: none; border-color: var(--vscode-focusBorder, #007acc); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc); }
  #searchInput::placeholder { color: var(--vscode-inputPlaceholderForeground, #888); }
  #searchIcon { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; opacity: 0.5; pointer-events: none; color: var(--vscode-input-foreground, inherit); }
  #searchClear { position: absolute; right: 4px; top: 0; bottom: 0; margin: auto 0; width: 16px; height: 16px; border: none; background: transparent; color: var(--vscode-descriptionForeground, #888); cursor: pointer; display: none; font-size: 14px; line-height: 16px; padding: 0; border-radius: 3px; align-items: center; justify-content: center; }
  #searchClear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-input-foreground, inherit); }
  #searchClear.visible { display: flex; }
  /* 单列内容始终铺满容器，右侧分支徽章覆盖在同一列上。 */
  .commit-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; width: 100%; min-width: 0; }
  /* 提交列表只保留内容单列；右侧分支徽章覆盖在这一列上。 */
  .commit-row { min-height: 26px; height: auto; box-sizing: border-box; cursor: pointer; align-items: start; font-size: inherit; user-select: none; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  /* 外层 Grid 的所有内容显式共用第 1 行；标签覆盖其上而不占出第 2 行。 */
  .commit-row > .col-main { grid-column: 1; grid-row: 1; width: 100%; }
  /* 分支图与描述合并为 col-main 单列: SVG 画泳道(左), 摘要行与描述(右)在同一字段内竖排。 */
  .col-main { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: 26px; align-items: center; min-width: 0; overflow: hidden; }
  .commit-row.expanded .col-main { grid-template-rows: minmax(26px, auto) auto; }
  /* 只有展开的提交行允许选中文字；折叠行的点击只负责选中/展开。泳道与悬浮按钮不参与文字选择。 */
  .commit-row.expanded { user-select: text; }
  .commit-row.expanded .graph-svg { user-select: none; }
  .col-main .graph-svg { grid-column: 1; grid-row: 1 / -1; align-self: stretch; flex: 0 0 auto; }
  /* Stash 的文字决定行高；泳道不参与 Grid 的固有尺寸计算，避免固定 SVG 高度反过来撑高文字行。 */
  .commit-row.stash .col-main { position: relative; grid-template-columns: var(--stash-lane-width) minmax(0, 1fr); }
  .commit-row.stash svg.graph-svg { position: absolute; top: 0; left: 0; height: 100%; min-height: 0; }
  /* 普通提交的泳道不参与 Grid 固有尺寸计算；展开后的高度由实际文字布局决定。 */
  .commit-row.expanded:not(.stash):not(.cloud) .col-main { position: relative; grid-template-columns: var(--commit-lane-width) minmax(0, 1fr); }
  .commit-row.expanded:not(.stash):not(.cloud) svg.graph-svg { position: absolute; top: 0; left: 0; height: 100%; min-height: 0; }
  /* 2px 实线允许 1px 边界补偿；竖直实线按像素绘制，相邻行既不断开也不叠出亮缝。 */
  .commit-row[data-row] .col-main { overflow: clip; overflow-clip-margin: 1px; }
  .commit-row[data-row] svg.graph-svg { overflow: visible; }
  .commit-row[data-row] svg.graph-svg path:not([stroke-dasharray]) { stroke-linecap: square; }
  .commit-row[data-row] svg.graph-svg path.lane-straight, .commit-row[data-row] svg.graph-svg line.lane-straight { shape-rendering: crispEdges; }
  /* 曲线保持平滑，但与像素对齐的竖线使用相同的设备像素粗细。 */
  .commit-row[data-row] svg.graph-svg .lane-curve { stroke-width: var(--commit-lane-curve-width, 2px); shape-rendering: geometricPrecision; }
  /* 曲线和延长线在同一透明组内合成，接头的抗锯齿覆盖相加，不产生暗缝或重复描边。 */
  .commit-row[data-row] svg.graph-svg .lane-curve-join { isolation: isolate; }
  .commit-row[data-row] svg.graph-svg .lane-curve-join > .lane-curve { mix-blend-mode: plus-lighter; stroke-linecap: butt; }
  /* 搜索结果不展示拓扑，泳道和占位一起移除。 */
  #graph.without-lanes .graph-svg { display: none; }
  #graph.without-lanes .col-main { grid-template-columns: minmax(0, 1fr); }
  #graph.without-lanes .col-main-summary, #graph.without-lanes .commit-description { grid-column: 1; }
  #graph.without-lanes { --main-width: 60ch; }
  .col-main-summary { grid-column: 2; grid-row: 1; display: flex; align-items: center; min-width: 0; overflow: hidden; padding: 0 calc(var(--commit-row-refs-width, 0px) + 5px) 0 0; }
  .col-main-summary .commit-message-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--vscode-foreground, inherit); }
  .commit-row.selected .commit-message-text { font-weight: 600; }
  /* 展开后标题完整显示并自动换行；20px 行高加上下各 3px 内边距，使单行时仍是 26px，与右侧悬浮按钮对齐。 */
  .commit-row.expanded .col-main-summary .commit-message-text { overflow: visible; text-overflow: clip; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 20px; padding: 3px 0; cursor: text; }
  .commit-description { display: none; grid-column: 2; grid-row: 2; padding: 0 10px 10px 0; color: var(--vscode-descriptionForeground); cursor: text; }
  .commit-row.expanded .commit-description { display: block; }
  .commit-description:empty { display: none; }
  .commit-description-body { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-editor-foreground, inherit); line-height: 19px; }
  .commit-description-meta { display: grid; grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .commit-description.has-body .commit-description-meta { margin-top: 10px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  .commit-detail-item { display: grid; grid-template-columns: 14px 58px minmax(0, 1fr); column-gap: 3px; align-items: start; min-width: 0; }
  .commit-detail-item .codicon { grid-column: 1; grid-row: 1; padding-top: 2px; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1; }
  .commit-detail-label { grid-column: 2; grid-row: 1; color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 17px; }
  .commit-detail-value { grid-column: 3; grid-row: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; color: var(--vscode-editor-foreground, inherit); line-height: 17px; }
  .commit-detail-item .codicon { user-select: none; }
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
  /* 搜索独占一行：紧跟选择器下方并随选择器一起吸顶。
     横向 sticky 让搜索行始终停留在可视区左边缘，同时避免被列表宽度拉伸。 */
  #commitSearchRow { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 5px 10px; position: sticky; top: var(--commit-search-top, 60px); left: 0; z-index: 3; background: var(--commit-title-background); border-bottom: 1px solid var(--vscode-panel-border); }
  #commitSearchRow #searchBox { flex: 1 1 auto; min-width: 0; }
  #commitSearchRow .count { flex: 0 0 auto; }
  #commitSearchRow #searchInput { width: 100%; }
  /* 云端提交折叠条: 紧贴搜索行下方、占满宽度、随搜索行一起吸顶(top = 选择器 + 搜索行高度)。 */
  #cloudCommitBars { flex: 0 0 auto; position: sticky; top: var(--commit-cloud-top, 90px); left: 0; z-index: 3; width: 100%; background: var(--commit-title-background); }
  #cloudCommitBars:empty { display: none; }
  .cloud-commit-bar { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; padding: 4px 10px; border: 0; border-bottom: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; }
  .cloud-commit-bar:hover { background: var(--vscode-list-hoverBackground); }
  .cloud-commit-bar:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: -1px; }
  .cloud-commit-bar .codicon { flex: 0 0 auto; font-size: 14px; color: var(--vscode-descriptionForeground); }
  .cloud-commit-bar-text { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 云端提交行: 只读展示, 不可选中, 文字用弱化颜色以区别于本地提交。 */
  #commitCloudRows { width: 100%; min-width: 0; }
  /* 云端行与普通提交行共用同一套行模板(选中、悬浮按钮、描述展开、右键菜单); 只是标题用弱化颜色。 */
  .commit-row.cloud .commit-message-text { color: var(--vscode-descriptionForeground); }
  .cloud-commit-group-title { padding: 2px 10px; color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size, 13px) - 1px); }
  /* Stash 用独立的灰色空心菱形侧枝展示；只加宽这一行，不改变任何真实提交的泳道或缩进。 */
  .commit-row.stash .commit-message-text { color: var(--vscode-descriptionForeground); }
  /* stash@{n} 徽章 (标题前): 移除图标，仅保留紧凑的引用名标签。 */
  .stash-badge { display: inline-flex; flex: 0 0 auto; align-items: stretch; height: 20px; margin-right: 6px; box-sizing: border-box; border: 1px solid var(--stash-badge-border, #696969); border-radius: 4px; overflow: hidden; font-size: calc(var(--vscode-font-size, 13px) - 1px); line-height: 18px; user-select: none; }
  .stash-badge-text { display: inline-flex; align-items: center; padding: 0 4px; background: var(--stash-badge-background, #222324); color: var(--stash-badge-foreground, #bbbebf); font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; }
`;

/** Commit 列表子面板的结构片段。 */
export const COMMIT_LIST_SUB_PANEL_MARKUP = `
    <div id="commitGraphViewport" class="overlay-scroll-viewport">
    <div id="graph">
      <!-- commit-selectors -->
      <div id="commitSearchRow"><div class="selector" id="searchBox"><svg id="searchIcon" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 .96-.96l3.04 3.03-1.06 1.06-2.94-3.13z"/></svg><input type="text" id="searchInput" placeholder="搜索提交..." title="输入关键词搜索, 支持作者/邮箱/消息/Hash/日期, 多个关键词用空格隔开, 回车开始搜索"><button id="searchClear" title="清除搜索">&times;</button></div><!-- branch-selector --><!-- stash-toggle --><span class="count" id="countLabel"></span><div id="commitProgress" hidden><div id="commitProgressFill"></div></div></div>
      <div id="cloudCommitBars"></div>
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
  var commitSelectors = document.getElementById('commitSelectors');
  var commitSearchRow = document.getElementById('commitSearchRow');
  var commitCloudBars = document.getElementById('cloudCommitBars');
  var commitVerticalScrollbar = document.getElementById('commitVerticalScrollbar');
  function updateCommitChromeLayout() {
    var searchTop = commitSelectors ? commitSelectors.offsetHeight : 0;
    var cloudTop = searchTop + (commitSearchRow ? commitSearchRow.offsetHeight : 0);
    var scrollbarTop = cloudTop + (commitCloudBars ? commitCloudBars.offsetHeight : 0);
    if (commitSearchRow) commitSearchRow.style.setProperty('--commit-search-top', searchTop + 'px');
    if (commitCloudBars) commitCloudBars.style.setProperty('--commit-cloud-top', cloudTop + 'px');
    if (commitVerticalScrollbar) commitVerticalScrollbar.style.top = scrollbarTop + 'px';
  }
  installOverlayScrollbars(commitGraphViewport, commitGraph, [commitVerticalScrollbar]);
  updateCommitChromeLayout();
  if (typeof ResizeObserver !== 'undefined') {
    var commitChromeObserver = new ResizeObserver(updateCommitChromeLayout);
    [commitSelectors, commitSearchRow, commitCloudBars].forEach(function(element) { if (element) commitChromeObserver.observe(element); });
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
  // 云端提交(HEAD..upstream): 每个已选仓库当前分支一组; 折叠状态只存在内存里, 默认全部折叠。
  let cloudGroupsState = [];
  // Stash 分组: 后端按开关与搜索状态决定是否下发, 这里只负责渲染。
  const expandedCloudGroups = new Set();
  let cloudBarsKey = '';
  let cloudRowsKey = '';
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
    // VS Code Source Control Graph 的官方几何常量。
    const LANE_W = 11;
    const LANE_CURVE_R = 5;
    const LANE_STROKE_W = 2;
    const NODE_STROKE_W = 2;
  function updateCommitLaneCurveWidth() {
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const width = Math.max(1, Math.round(LANE_STROKE_W * ratio)) / ratio;
    document.documentElement.style.setProperty('--commit-lane-curve-width', width + 'px');
  }
  updateCommitLaneCurveWidth();
  window.addEventListener('resize', updateCommitLaneCurveWidth);
    const expandedCommits = new Set();
    const expandedCommitRowHeights = new Map();
    let commitLayoutPrefix = [];
    let commitLayoutTotal = 0;
    let commitLayoutDirty = true;
    let commitVirtualStart = -1;
    let commitVirtualEnd = -1;
    let commitVirtualFrame = 0;
  const DOT_R = 5;
  // Stash 菱形独立于泳道线宽；10px 外接尺寸已包含 1px 描边。
  const STASH_NODE_SIZE = 10;
  const STASH_NODE_STROKE_W = 1;
  const STASH_NODE_R = (STASH_NODE_SIZE - STASH_NODE_STROKE_W) / 2;
  // Merge 节点: 背景遮罩 + 泳道色圆环 + 中心实心点，外层遮罩与普通圆点一致。
  const MERGE_RING_R = DOT_R - 0.25;
  const MERGE_RING_W = 1.5;
  const MERGE_CENTER_R = 2.25;
  // 描述与泳道之间额外的空隙: 所有行(普通提交、云端提交、未提交行)的泳道 SVG 统一加宽这么多, 描述整体右移。
  // 云端提交的泳道节点: codicon "cloud" 的矢量轮廓(16x16 视窗, 墨迹横向占 14/16); 14px 是确认过的显示大小。
  const CLOUD_NODE_SIZE = 14;
  // 泳道虚线的唯一样式来源: 云端行、未提交行、stash 行, 折叠或展开, 全部走这里。
  // 不再按线段长度去"凑"步长 —— 那样每段步长都不同 (实测 2.0/2.5/2.6 并存), 疏密看起来就不一致。
  // 相邻段能首尾相接靠 stroke-dashoffset: 用线段在本行内的起点做相位偏移, 让所有段共享同一条
  // 无限延伸虚线的相位; 展开行把高度拉长也同样成立, 不会在行底出现断口。
  // butt 端点: 墨迹长度就等于 LANE_DASH_ON, round 会让两端各多出半个线宽。
  const LANE_DASH_ON = 2;
  const LANE_DASH_GAP = 2;
  const laneDashAttrs = function(startY, strokeWidth = LANE_STROKE_W) {
    const period = LANE_DASH_ON + LANE_DASH_GAP;
    const phase = ((Number(startY) || 0) % period + period) % period;
    return 'stroke-width="' + strokeWidth + '" stroke-dasharray="' + LANE_DASH_ON + ' ' + LANE_DASH_GAP
      + '" stroke-dashoffset="' + phase.toFixed(3) + '" stroke-linecap="butt"';
  };
  // 云图标比圆形节点宽出的那部分: 把云端行的泳道列加宽同样的量, 描述与泳道的间隔就和普通提交一致, 图标本身不缩放。
  const CLOUD_NODE_EXTRA = Math.max(0, CLOUD_NODE_SIZE * 14 / 16 / 2 - DOT_R);
  const CLOUD_NODE_PATH = 'M8 4C6.34315 4 5 5.34315 5 7C5 7.27614 4.77614 7.5 4.5 7.5H4.25C3.00736 7.5 2 8.50736 2 9.75C2 10.9926 3.00736 12 4.25 12H11.75C12.9926 12 14 10.9926 14 9.75C14 8.50736 12.9926 7.5 11.75 7.5H11.5C11.2239 7.5 11 7.27614 11 7C11 5.34315 9.65685 4 8 4ZM4.03004 6.50733C4.27283 4.53062 5.95767 3 8 3C10.0423 3 11.7272 4.53063 11.97 6.50733C13.6623 6.62043 15 8.029 15 9.75C15 11.5449 13.5449 13 11.75 13H4.25C2.45507 13 1 11.5449 1 9.75C1 8.029 2.33769 6.62043 4.03004 6.50733Z';
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

  var commitTagStateRequestId = 0;
  function commitRowLocalTags(row) {
    try {
      var tags = JSON.parse(row.getAttribute('data-local-tags') || '[]');
      return Array.isArray(tags) ? tags.filter(function(tag) { return typeof tag === 'string'; }) : [];
    } catch (_) {
      return [];
    }
  }
  function setCommitTagActionAvailability(menu, state) {
    var deleteTagButton = menu.querySelector('[data-commit-action="deleteTag"]');
    var deleteRemoteTagButton = menu.querySelector('[data-commit-action="deleteRemoteTag"]');
    var pushTagButton = menu.querySelector('[data-commit-action="pushTag"]');
    if (!deleteTagButton || !deleteRemoteTagButton || !pushTagButton) return;
    deleteTagButton.disabled = !(state.localTagCount > 0);
    deleteRemoteTagButton.disabled = !(state.remoteTagCount > 0);
    pushTagButton.disabled = !(state.pushableTagCount > 0);
    var remoteLoadingSuffix = state.remoteLoading === true ? '（查询中…）' : '';
    deleteRemoteTagButton.querySelector('span').textContent = 'delete remote tag' + remoteLoadingSuffix;
    pushTagButton.querySelector('span').textContent = 'push tag' + remoteLoadingSuffix;
    var errorTitle = state.remoteError ? '读取远程 Tag 失败：' + state.remoteError : '';
    deleteRemoteTagButton.title = deleteRemoteTagButton.disabled ? errorTitle : '';
    pushTagButton.title = pushTagButton.disabled ? errorTitle : '';
  }
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || msg.type !== 'commitTagState') return;
    var menu = document.getElementById('commitContextMenu');
    if (!menu.matches(':popover-open') || !commitContextTarget) return;
    if (String(msg.requestId) !== menu.dataset.tagStateRequestId
        || msg.hash !== commitContextTarget.hash || msg.repositoryPath !== commitContextTarget.repositoryPath) return;
    setCommitTagActionAvailability(menu, msg);
  });

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
    // stash 行只提供 apply / pop / drop 以及展开描述、复制 hash；普通提交行相反，不显示 stash 动作。
    var isStashRow = row.classList.contains('stash');
    menu.querySelectorAll('.commit-only').forEach(function(item) { item.hidden = isStashRow; });
    menu.querySelectorAll('.stash-only').forEach(function(item) { item.hidden = !isStashRow; });
    if (!isStashRow) {
      var localTags = commitRowLocalTags(row);
      var requestId = ++commitTagStateRequestId;
      menu.dataset.tagStateRequestId = String(requestId);
      setCommitTagActionAvailability(menu, { localTagCount: localTags.length, remoteTagCount: 0, pushableTagCount: 0, remoteLoading: true, remoteError: '' });
      vscode.postMessage({ type: 'requestCommitTagState', requestId: requestId, hash: hash, repositoryPath: repositoryPath });
    }
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
    var stickyHeight = document.getElementById('commitSelectors').offsetHeight
      + document.getElementById('commitSearchRow').offsetHeight
      + document.getElementById('cloudCommitBars').offsetHeight;
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

  // VS Code Source Control Graph: 每行 SVG 宽度 = (max(inputSwimlanes, outputSwimlanes, 1) + 1) * 11px。
  // 最后的 +1 是标题前保留的一个完整泳道槽；不再按 indentDepth 追加宽度，因此同一段 merge 的四行标题严格对齐。
  function laneColumnWidth(laneCount) {
    return (Math.max(1, laneCount) + 1) * LANE_W;
  }
  function stashBranchColumn(c) {
    return Math.max((c.inputSwimlanes || []).length, (c.outputSwimlanes || []).length, (Number(c.lane) || 0) + 1, 1);
  }
  function rowGraphW(c) {
    var inputCount = (c.inputSwimlanes || []).length;
    var outputCount = (c.outputSwimlanes || []).length;
    var laneCount = Math.max(inputCount, outputCount, 1);
    // 展示侧枝只占 stash 自己的一列；普通提交仍使用真实泳道宽度。
    if (c.isStash) laneCount = stashBranchColumn(c) + 1;
    return laneColumnWidth(laneCount);
  }
  function localTagNames(refs) {
    return refs.filter(function(ref) { return ref.startsWith('tag: '); })
      .map(function(ref) { return ref.slice(5); });
  }

  // 每类 ref 最多渲染一个图标位：当前分支、Tag、本地分支、远程分支。
  // 分支分类严格来自 branches 元数据；Tag 来自原生层规范化后的 "tag: " 前缀。
  function categorizedRefs(refs, repositoryPath) {
    var categories = [
      { kind: 'current', icon: 'target', labels: [] },
      { kind: 'tag', icon: 'tag', labels: [] },
      { kind: 'local', icon: 'git-branch', labels: [] },
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
    document.querySelectorAll('#commitVirtualRows .commit-row, #commitWorkingTreeRows .commit-row, #commitCloudRows .commit-row').forEach(reserveCommitRowRefs);
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

  // 构建单行提交 HTML。options.cloud: 云端提交(泳道由 cloudRowSvg 画虚线, 标题前带云图标, 行内不带 data-row)。
  function buildCommitRowHTML(i, graphW, options) {
    options = options || {};
    var cloud = options.cloud;
    var c = cloud ? cloud.commit : commits[i];
    var stash = Boolean(c.isStash);
    var repositoryPath = cloud ? cloud.repositoryPath : c.gitBranchOption.repoOption.path;
    var commitKey = repositoryPath + ':' + c.hash;
    var selected = selectedCommitHash === c.hash && repositoryPath === selectedCommitRepositoryPath;
    // 描述只能在当前高亮 commit 上显示。
    var expanded = selected && expandedCommits.has(commitKey);
    var localTags = stash ? [] : localTagNames(c.refs || []);
    var html = '<div class="commit-row' + (cloud ? ' cloud' : '') + (stash ? ' stash' : '') + (expanded ? ' expanded' : '') + (selected ? ' selected' : '') + '" data-hash="' + escapeAttr(c.hash) + '" data-repository-path="' + escapeAttr(repositoryPath) + '" data-local-tags="' + escapeAttr(JSON.stringify(localTags)) + '"' + (cloud ? '' : ' data-row="' + i + '"') + ' data-has-description="true">';
    var commitMessage = splitCommitMessage(c);
    // 每个分支类别独立展开；Commit 详情由行悬浮卡与展开描述提供。
    var refChipsHtml = (stash ? [] : categorizedRefs(c.refs || [], repositoryPath)).map(function(category) {
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
    html += '<div class="col-main"' + (!cloud ? ' style="' + (stash ? '--stash-lane-width' : '--commit-lane-width') + ':' + rowGraphW(c) + 'px"' : '') + '>';
    if (cloud) {
      html += '<span class="graph-svg">' + cloudRowSvg(cloud.layout, cloud.isLastOfGroup, cloud.connectsDown) + '</span>';
      html += '<div class="col-main-summary"><span class="commit-message-text">' + escapeHtml(commitMessage.title) + '</span></div>';
    } else {
      var rowW = rowGraphW(c);
      html += stash ? stashRowSvg(c, rowW, i)
        : '<svg class="graph-svg" width="' + rowW + '" height="' + ROW_H + '"></svg>';
      // stash 行: 标题前加紧凑的 stash@{n} 引用名徽章; 其他行没有前缀。
      var stashBadge = stash
        ? '<span class="stash-badge" title="' + escapeAttr(c.stashRef || '') + '"><span class="stash-badge-text">' + escapeHtml(c.stashRef || '') + '</span></span>'
        : '';
      html += '<div class="col-main-summary">' + stashBadge + '<span class="commit-message-text">' + escapeHtml(commitMessage.title) + '</span></div>';
    }
    var parentList = (c.parents || []).map(function(parent) { return parent.slice(0, 12); }).join(' ');
    var detailItem = function(icon, label, value, valueClass) {
      if (!value) return '';
      return '<div class="commit-detail-item"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span><span class="commit-detail-label">' + escapeHtml(label) + '</span><span class="commit-detail-value' + (valueClass ? ' ' + valueClass : '') + '">' + escapeHtml(value) + '</span></div>';
    };
    var detailMeta = detailItem('account', '作者', c.authorEmail ? c.author + ' <' + c.authorEmail + '>' : c.author)
      + detailItem('git-branch', '分支', (stash ? [] : categorizedRefs(c.refs || [], repositoryPath)).map(function(category) {
        return category.labels.join(', ');
      }).join(' · '))
      + detailItem('archive', 'Stash', stash ? c.stashRef : '')
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
      if (svg && Number.isInteger(index) && commits[index] && !commits[index].isStash) {
        var rowW = rowGraphW(commits[index]);
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

  // 展开行内正在拖选文字时，抬起鼠标产生的 click 属于选择操作，不能当作“再次点击折叠”。
  function rowHasTextSelection(row) {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    return selection.getRangeAt(0).intersectsNode(row);
  }

  // 为单行设置 SVG 和点击监听

  function setupRow(row, graphW) {
    // 工作区虚拟行(changes/staged)的 SVG 由 workingTreeGraphSvg 在模板中直接生成, 不走 commit 的 drawSvg。
    var isWorkingTree = row.classList.contains('working-tree');
    var isCloud = row.classList.contains('cloud');
    var svg = row.querySelector('svg');
    if (svg && !isWorkingTree && !isCloud && !row.classList.contains('stash')) {
      var idx = Number(row.getAttribute('data-row'));
      // 每行按自身泳道宽度绘制, 使描述紧贴泳道; graphW 仅作无对应 commit 时的兜底。
      var rowW = commits[idx] ? rowGraphW(commits[idx]) : graphW;
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
      if (row.classList.contains('expanded') && rowHasTextSelection(row)) return;
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
        if (row.classList.contains('cloud')) {
          updateCloudRows(true);
          return;
        }
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

  // 虚拟行泳道: 与首个 commit 对齐(cx = LANE_W/2 + 5 = 11), Uncommitted Changes 用虚线圆节点,
  //   并向下用虚线连接到下方节点(HEAD), 表示合并后的 Uncommitted Changes 行仍处在历史链条上。
  function workingTreeGraphSvg(hash) {
    const cx = LANE_W;
    const cy = ROW_H / 2;
    // 所有圆形泳道节点统一使用 DOT_R；Uncommitted Changes 用 8 段圆角弧组成虚线圆，其余虚拟行保持空心圆。
    // 这是节点图标而非泳道连线，不使用泳道 dasharray，避免 round cap 把短段连成实心圆。
    const r = DOT_R;
    const dashedCircle = function() {
      const segmentAngle = (2.4 - 1.5) / r;
      let d = '';
      for (let i = 0; i < 8; i++) {
        const center = i * Math.PI / 4, start = center - segmentAngle / 2, end = center + segmentAngle / 2;
        d += 'M ' + (cx + r * Math.cos(start)).toFixed(3) + ' ' + (cy + r * Math.sin(start)).toFixed(3)
          + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r * Math.cos(end)).toFixed(3) + ' ' + (cy + r * Math.sin(end)).toFixed(3) + ' ';
      }
      return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--vscode-editor-background)"/>'
        + '<path class="working-tree-dashed-node" d="' + d.trim() + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
    };
    // 未提交行与普通提交首列同宽(同一个函数), 描述与泳道的间隔因此完全一致。
    const width = laneColumnWidth(1);
    const color = 'var(--vscode-descriptionForeground, #999)';
    let inner = '';
    if (hash === 'uncommitted') {
      // 云端提交展开时, 云端泳道从上方用虚线接入这个节点。
      if (cloudConnectsToWorkingTree()) {
        inner += '<path d="M ' + cx + ' 0 V ' + (cy - r) + '" fill="none" stroke="' + color + '" ' + laneDashAttrs(0) + '/>';
      }
      inner += '<path d="M ' + cx + ' ' + (cy + r) + ' V ' + ROW_H + '" fill="none" stroke="' + color + '" ' + laneDashAttrs(cy + r) + '/>';
    }
    inner += hash === 'uncommitted' ? dashedCircle()
      : '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--vscode-editor-background)" stroke="' + color + '" stroke-width="1.5"/>';
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

  // ---- 云端提交: 折叠条(搜索行下方) + 只读行(未提交行之上, 同一个列表) ----
  function visibleCloudGroups() {
    var workingTreePath = workingTreeRowsState.length ? workingTreeRowsState[0].repositoryPath : '';
    // 与未提交行同仓库的那组放最后, 使它的虚线刚好落进紧邻的未提交节点。
    return cloudGroupsState
      .filter(function(group) { return expandedCloudGroups.has(group.repositoryPath); })
      .sort(function(left, right) { return (left.repositoryPath === workingTreePath ? 1 : 0) - (right.repositoryPath === workingTreePath ? 1 : 0); });
  }

  function lastVisibleCloudGroup() {
    var groups = visibleCloudGroups();
    var last = groups[groups.length - 1];
    return last && last.commits.length > 0 ? last : undefined;
  }

  function cloudConnectsToWorkingTree() {
    var last = lastVisibleCloudGroup();
    var row = workingTreeRowsState.find(function(item) { return item.hash === 'uncommitted'; });
    return Boolean(last && row && row.repositoryPath === last.repositoryPath);
  }

  function cloudConnectsToFirstCommit() {
    var last = lastVisibleCloudGroup();
    if (!last || !commits.length) return false;
    if (workingTreeRowsState.some(function(item) { return item.hash === 'uncommitted'; })) return false;
    return commits[0].gitBranchOption.repoOption.path === last.repositoryPath;
  }

  // 与 GitCommitController.buildGraph 同一个输入/输出泳道状态机, 只是颜色统一为弱化灰色并全部画成虚线。
  function cloudGroupLayout(group) {
    var lanes = [];
    return group.commits.map(function(commit) {
      var input = lanes.slice();
      var parents = commit.parents || [];
      var inputIndex = input.indexOf(commit.hash);
      var lane = inputIndex >= 0 ? inputIndex : input.length;
      var next = [], pass = [], mergeIn = [], fromNode = [];
      for (var i = 0; i < input.length; i++) {
        if (input[i] === commit.hash) {
          if (i === inputIndex && parents.length > 0) { fromNode.push(next.length); next.push(parents[0]); }
          else if (i !== inputIndex) { mergeIn.push(i); }
          continue;
        }
        pass.push({ from: i, to: next.length });
        next.push(input[i]);
      }
      for (var p = (inputIndex >= 0 && parents.length > 0) ? 1 : 0; p < parents.length; p++) {
        fromNode.push(next.length);
        next.push(parents[p]);
      }
      lanes = next;
      return { commit: commit, lane: lane, inputIndex: inputIndex, input: input, next: next, pass: pass, mergeIn: mergeIn, fromNode: fromNode };
    });
  }

  function cloudRowSvg(row, isLastOfGroup, connectsDown, rowHeight) {
    var height = Math.max(ROW_H, rowHeight || ROW_H);
    var y = ROW_H / 2;
    var color = 'var(--vscode-descriptionForeground, #999)';
    var maxLane = Math.max(row.lane, row.input.length - 1, row.next.length - 1, 0);
    var width = laneColumnWidth(maxLane + 1) + CLOUD_NODE_EXTRA;
    var laneX = function(index) { return (index + 1) * LANE_W; };
    var cx = laneX(row.lane);
    var dash = ' fill="none" stroke="' + color + '" ' + laneDashAttrs(0);
    var edge = function(x1, y1, x2, y2) {
      if (x1 === x2) return '<path d="M ' + x1 + ' ' + y1 + ' V ' + y2 + '"' + dash + '/>';
      var half = (y2 - y1) / 2;
      return '<path d="M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + half) + ' ' + x2 + ' ' + (y2 - half) + ' ' + x2 + ' ' + y2 + '"' + dash + '/>';
    };
    var inner = '';
    if (row.inputIndex >= 0) inner += edge(cx, 0, cx, y);
    row.mergeIn.forEach(function(index) { inner += edge(laneX(index), 0, cx, y); });
    row.pass.forEach(function(item) { inner += edge(laneX(item.from), 0, laneX(item.to), y); });
    row.next.forEach(function(hash, k) {
      // 组内最后一行只有在紧邻未提交行/首个本地提交时才继续向下; 否则下面是空白或另一仓库的标题, 不画指向它们的虚线。
      if (isLastOfGroup && !connectsDown) return;
      var startX = row.fromNode.indexOf(k) >= 0 ? cx : laneX(k);
      // 组内最后一行: 所有仍向下延伸的泳道收拢到第 0 道, 再接入本地的未提交/首个提交节点。
      var endX = isLastOfGroup && k > 0 ? laneX(0) : laneX(k);
      inner += edge(startX, y, endX, height);
    });
    // 节点画成 codicon 的 cloud 轮廓, 底色填成编辑器背景先遮住穿过它的虚线, 再画图标本体。
    var scale = CLOUD_NODE_SIZE / 16;
    var nodeTransform = 'translate(' + (cx - 8 * scale) + ' ' + (y - 8 * scale) + ') scale(' + scale + ')';
    inner += '<g data-cloud-node transform="' + nodeTransform + '"><path d="' + CLOUD_NODE_PATH + '" fill="var(--vscode-editor-background)" stroke="var(--vscode-editor-background)" stroke-width="2" stroke-linejoin="round"/>'
      + '<path d="' + CLOUD_NODE_PATH + '" fill="' + color + '"/></g>';
    return '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + inner + '</svg>';
  }

  // 云端行与普通行同一模板: 选中、悬浮按钮(分支/作者/时间)、描述展开、右键菜单都走同一条路径。
  function cloudRowHTML(group, row, isLastOfGroup, connectsDown) {
    return buildCommitRowHTML(-1, currentGraphW, {
      cloud: { commit: row.commit, repositoryPath: group.repositoryPath, layout: row, isLastOfGroup: isLastOfGroup, connectsDown: connectsDown },
    });
  }

  // 展开描述后行高大于 ROW_H: 按真实行高重画云端泳道, 虚线才能贯穿整行。
  var cloudRowLayouts = new Map();
  function stretchCloudRowLanes(host) {
    host.querySelectorAll('.commit-row.cloud.expanded').forEach(function(row) {
      var entry = cloudRowLayouts.get(row.getAttribute('data-repository-path') + ':' + row.getAttribute('data-hash'));
      var holder = row.querySelector('.graph-svg');
      if (!entry || !holder) return;
      holder.innerHTML = cloudRowSvg(entry.layout, entry.isLastOfGroup, entry.connectsDown, row.getBoundingClientRect().height);
    });
  }

  function updateCloudRows(force) {
    var host = document.getElementById('commitCloudRows');
    if (!host) return;
    var groups = visibleCloudGroups();
    var key = JSON.stringify(groups.map(function(group) {
      return [group.repositoryPath, group.count, group.commits.map(function(commit) { return commit.hash; })];
    }));
    if (!force && key === cloudRowsKey) return;
    cloudRowsKey = key;
    var html = '';
    var connecting = (cloudConnectsToWorkingTree() || cloudConnectsToFirstCommit()) ? lastVisibleCloudGroup() : undefined;
    groups.forEach(function(group) {
      if (groups.length > 1) {
        html += '<div class="cloud-commit-group-title">' + escapeHtml(group.repositoryLabel + (group.branchLabel ? '（' + group.branchLabel + '）' : '')) + '</div>';
      }
      if (group.commits.length < group.count) {
        html += '<div class="cloud-commit-group-title">' + (group.commits.length > 0
          ? '仅显示最新 ' + group.commits.length + ' 条，共 ' + group.count + ' 条'
          : '云端提交暂时无法读取') + '</div>';
      }
      var layout = cloudGroupLayout(group);
      layout.forEach(function(row, index) {
        var last = index === layout.length - 1, down = group === connecting;
        cloudRowLayouts.set(group.repositoryPath + ':' + row.commit.hash, { layout: row, isLastOfGroup: last, connectsDown: down });
        html += cloudRowHTML(group, row, last, down);
      });
    });
    host.innerHTML = html;
    host.querySelectorAll('.commit-row').forEach(function(row) { setupRow(row, currentGraphW); });
    stretchCloudRowLanes(host);
    scheduleCommitVirtualWindow();
  }

  function updateStashToggle(visible, hiddenCount) {
    var button = document.getElementById('stashListToggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(visible));
    var description = '在commit列表中显示stash提交（当前状态： ' + (visible ? '开' : '关') + '）';
    button.setAttribute('aria-label', description);
    // 基线提交还没加载(或不在已选分支上)的 stash 无法穿插进图, 在这里如实告知。
    button.title = hiddenCount > 0 ? description + '；另有 ' + hiddenCount + ' 个 Stash 的基线提交尚未加载，加载更多提交后显示' : description;
    button.dataset.hidden = hiddenCount > 0 ? String(hiddenCount) : '';
  }

  document.getElementById('stashListToggle').addEventListener('click', function() {
    var next = this.getAttribute('aria-pressed') !== 'true';
    // 乐观更新按钮状态; stash 行是否出现由宿主重建的提交图决定。
    updateStashToggle(next, 0);
    vscode.postMessage({ type: 'toggleStashes', visible: next });
  });

  function updateCloudBars() {
    var host = document.getElementById('cloudCommitBars');
    if (!host) return;
    // 蒙版加载期间旧列表没有参考价值, 折叠条一起让位。
    host.hidden = isCommitLoading && commitLoadingMode === 'overlay';
    var multi = cloudGroupsState.length > 1;
    var key = JSON.stringify([
      cloudGroupsState.map(function(group) { return [group.repositoryPath, group.repositoryLabel, group.branchLabel, group.count]; }),
      Array.from(expandedCloudGroups),
    ]);
    if (key === cloudBarsKey) return;
    cloudBarsKey = key;
    host.innerHTML = cloudGroupsState.map(function(group) {
      var expanded = expandedCloudGroups.has(group.repositoryPath);
      var text = (multi ? group.repositoryLabel + '：' : '') + group.count + ' 条提交待拉取';
      var title = '云端' + (group.branchLabel ? ' ' + group.branchLabel : '') + ' 比本地多 ' + group.count + ' 条提交，点击' + (expanded ? '收起' : '展开');
      return '<button type="button" class="cloud-commit-bar" data-cloud-repository-path="' + escapeAttr(group.repositoryPath) + '" aria-expanded="' + String(expanded) + '" aria-controls="commitCloudRows" title="' + escapeAttr(title) + '">'
        + '<span class="codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '" aria-hidden="true"></span>'
        + '<span class="codicon codicon-cloud" aria-hidden="true"></span>'
        + '<span class="cloud-commit-bar-text">' + escapeHtml(text) + '</span></button>';
    }).join('');
    updateCommitChromeLayout();
  }

  document.getElementById('cloudCommitBars').addEventListener('click', function(event) {
    var button = event.target.closest('.cloud-commit-bar');
    if (!button) return;
    var repositoryPath = button.getAttribute('data-cloud-repository-path') || '';
    if (expandedCloudGroups.has(repositoryPath)) expandedCloudGroups.delete(repositoryPath);
    else expandedCloudGroups.add(repositoryPath);
    updateCloudBars();
    updateCloudRows(true);
    // 虚线衔接依赖云端行是否可见: 未提交行与首个本地提交的节点要跟着重绘。
    updateWorkingTreeRows();
    renderCommitVirtualWindow(true);
  });

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
    const stickyHeight = document.getElementById('commitSelectors').offsetHeight + document.getElementById('commitSearchRow').offsetHeight + document.getElementById('cloudCommitBars').offsetHeight;
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
      // 此测量只维护虚拟列表缓存；真实提交和 stash 的泳道都随布局伸缩，不再测量后重画。
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
    var naturalGraphW = laneColumnWidth(laneCount);
    graphViewportWidth = graph ? graph.clientWidth : 0;
    var graphW = naturalGraphW;
    currentGraphW = graphW;
    var selectedBranch = getSelectedCurrentBranch();
    var workingTreeHtml = selectedBranch ? workingTreeRowsState.map(function(row) {
      return workingTreeRowHTML(row.hash, row.label, row.enabled);
    }).join('') : '';

    commitLayoutDirty = true;
    rebuildCommitLayout();
    commitVirtualStart = -1;
    commitVirtualEnd = -1;
    // 工作区虚拟行始终保留；普通提交只挂载可视范围与前后各 50 条。
    list.innerHTML = '<div id="commitCloudRows"></div>'
      + '<div id="commitWorkingTreeRows">' + workingTreeHtml + '</div>'
      + '<div id="commitVirtualTop" class="commit-virtual-spacer"></div>'
      + '<div id="commitVirtualRows"></div>'
      + '<div id="commitVirtualBottom" class="commit-virtual-spacer" style="height:' + commitLayoutTotal + 'px"></div>';

    // SVG 泳道子列宽随泳道数变化; col-main 总宽由 --main-width (默认 = 泳道宽 + 60ch) 决定。
    graph.style.setProperty('--graph-lane-width', naturalGraphW + 'px');
    list.style.setProperty('--graph-lane-width', naturalGraphW + 'px');
    document.querySelectorAll('#commitWorkingTreeRows .commit-row').forEach(function(row) { setupRow(row, graphW); });
    updateCloudRows(true);
    renderCommitVirtualWindow(true);

    updateCountLabel();
    restoreVisibleCommitAnchor(graph, list, visibleCommitAnchor, scrollTop);
  }

  // 固定节点坐标 + 自适应连线：无 viewBox 的 SVG 直接使用 CSS 像素；y2="100%" 始终是实际行底。
  // SVG 绝对定位，不向 Grid 贡献固有高度。标题换行、作者标签动画、面板缩放都无需重画。
  function isLeadingStashPrefix(index, repositoryPath) {
    for (let previous = 0; previous < index; previous++) {
      const commit = commits[previous];
      if (!commit.isStash || commit.gitBranchOption?.repoOption.path !== repositoryPath) return false;
    }
    return true;
  }

  function stashRowSvg(c, graphW, index) {
    const laneX = function(column) { return (column + 1) * LANE_W; };
    const column = Math.max(0, Number(c.lane) || 0);
    const lanes = c.outputSwimlanes || [];
    const trunkX = laneX(column);
    const branchColumn = stashBranchColumn(c);
    const x = laneX(branchColumn);
    const y = ROW_H / 2;
    const radius = STASH_NODE_R;
    const grey = 'var(--vscode-descriptionForeground, #999)';
    const repositoryPath = c.gitBranchOption?.repoOption.path;
    const leadingStashConnection = isLeadingStashPrefix(index, repositoryPath);
    // 同一基线的 stash 共用展示侧列，根部分叉在基线 commit 自己的圆点上绘制。
    // 百分比终点随实际行高延伸，不需要测量展开详情或重绘连接线。
    const previous = commits[index - 1];
    const continuesBranch = previous?.isStash && previous.parents[0] === c.parents[0]
      && previous.gitBranchOption?.repoOption.path === c.gitBranchOption?.repoOption.path;
    const startY = continuesBranch ? 0 : y;
    let content = '<line class="stash-branch" x1="' + x + '" y1="' + startY + '" x2="' + x
      + '" y2="100%" stroke="' + grey + '" ' + laneDashAttrs(startY - y - radius, LANE_STROKE_W) + '/>';
    const trunk = function(x, color) {
      const baseClass = x === trunkX ? ' stash-base-lane' : '';
      const dashedBaseLane = leadingStashConnection && x === trunkX;
      const strokeAttrs = dashedBaseLane
        ? laneDashAttrs(ROW_H * (index + 1), LANE_STROKE_W)
        : 'stroke-width="' + LANE_STROKE_W + '" stroke-linecap="square"';
      return '<line class="stash-main-lane lane-straight' + baseClass + (dashedBaseLane ? ' stash-prefix-lane' : '') + '" x1="' + x + '" y1="0" x2="' + x + '" y2="100%" stroke="' + color + '" ' + strokeAttrs + '/>';
    };
    // stash 位于列表头部、最新提交之前时，基线泳道使用虚线；历史中间的 stash 仍保持实线。
    lanes.forEach(function(lane, laneIndex) { content += trunk(laneX(laneIndex), lane.color); });
    if (!lanes[column]) {
      // Stash 在分支头之上时，基线还没有输入泳道。连续 stash 后的第一条真实提交就是基线。
      let baseIndex = index + 1;
      while (baseIndex < commits.length && commits[baseIndex].isStash) baseIndex++;
      const base = commits[baseIndex];
      const sameBase = base && base.hash === c.parents[0]
        && base.gitBranchOption?.repoOption.path === c.gitBranchOption?.repoOption.path;
      content += trunk(trunkX, commitLaneColor(sameBase ? base : c));
    }
    // 菱形最后绘制，保留灰色空心样式与 inbox 徽章。
    content += '<path class="stash-node" d="M ' + x + ' ' + (y - radius) + ' L ' + (x + radius) + ' ' + y + ' L ' + x + ' ' + (y + radius) + ' L ' + (x - radius) + ' ' + y + ' Z" fill="var(--vscode-editor-background)" stroke="' + grey + '" stroke-width="' + STASH_NODE_STROKE_W + '" stroke-linejoin="round"/>';
    return '<svg class="graph-svg" width="' + graphW + '" height="100%">' + content + '</svg>';
  }

  function drawSvg(svg, idx, graphW, rowH, laneW, dotR) {
    const c = commits[idx];
    const expanded = svg.closest('.commit-row').classList.contains('expanded');
    const y = rowH / 2;
    // 不使用测量高度或 viewBox：节点/弧线固定在首行的 CSS 像素坐标，直线延伸到实时行底。
    svg.setAttribute('width', String(graphW));
    svg.setAttribute('height', expanded ? '100%' : String(rowH));
    svg.removeAttribute('viewBox');
    let content = '';
    const laneTail = function(x, color) {
      return '<line class="commit-lane-tail lane-curve" x1="' + x + '" y1="' + rowH + '" x2="' + x
        + '" y2="100%" stroke="' + color + '" stroke-width="' + LANE_STROKE_W + '" stroke-linecap="butt"/>';
    };
    const curvedLane = function(d, color, tailX) {
      const path = '<path class="lane-curve" d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + LANE_STROKE_W + '"/>';
      return expanded && tailX !== undefined
        ? '<g class="lane-curve-join">' + path + laneTail(tailX, color) + '</g>' : path;
    };
    const expandedLane = function(x, startY, color) {
      return '<line class="commit-main-lane lane-straight" x1="' + x + '" y1="' + startY + '" x2="' + x
        + '" y2="100%" stroke="' + color + '" stroke-width="' + LANE_STROKE_W + '" stroke-linecap="square"/>';
    };

    const inputSwimlanes = c.inputSwimlanes || [];
    const outputSwimlanes = c.outputSwimlanes || [];
    const inputIndex = inputSwimlanes.findIndex(function(lane) { return lane.hash === c.hash; });
    const circleIndex = inputIndex >= 0 ? inputIndex : inputSwimlanes.length;
    const cx = (circleIndex + 1) * laneW;
    const commitColor = commitLaneColor(c);
    const repositoryPath = c.gitBranchOption?.repoOption.path;
    const laneX = function(index) { return (index + 1) * laneW; };
    // Stash 不改变真实泳道状态；分支头没有输入泳道时，默认用虚线接住上方 stash 行的基线，
    // 只有历史中间的 stash 才沿用真实提交之间的实线。
    const previousCommit = idx > 0 ? commits[idx - 1] : undefined;
    const connectedFromStash = Boolean(previousCommit?.isStash
      && previousCommit.parents && previousCommit.parents[0] === c.hash
      && previousCommit.gitBranchOption?.repoOption.path === repositoryPath);
    const leadingStashConnection = connectedFromStash && inputIndex < 0
      && isLeadingStashPrefix(idx, repositoryPath);
    if (connectedFromStash) {
      const branchX = laneX(stashBranchColumn(previousCommit));
      // 从真实圆点出发，在上边界接住 stash 侧列；先画侧枝，再画原色主干和圆点。
      const fork = 'M ' + cx + ' ' + y + ' C ' + cx + ' ' + (y - LANE_CURVE_R)
        + ' ' + branchX + ' ' + LANE_CURVE_R + ' ' + branchX + ' 0';
      // 第一段虚线从圆点可见外沿开始，不被节点背景描边吞掉。
      content += '<path class="stash-fork" d="' + fork + '" fill="none" stroke="var(--vscode-descriptionForeground, #999)" '
        + laneDashAttrs(-(dotR + NODE_STROKE_W / 2), LANE_STROKE_W) + '/>';
    }
    let outputIndex = 0;

    // VS Code Source Control Graph 的泳道状态机与 SVG 几何。
    // 1. 输入泳道若在输出中保留: 直线或两个 5px 圆弧的左移曲线;
    // 2. 同一提交的额外输入泳道: 11px 圆弧汇入当前节点;
    // 3. merge 的第 2+ 个父提交: 从当前节点水平伸出，再以 11px 圆弧落到父泳道。
    for (let index = 0; index < inputSwimlanes.length; index++) {
      const inputLane = inputSwimlanes[index];
      const x1 = laneX(index);
      if (inputLane.hash === c.hash) {
        if (index !== inputIndex) {
          // VS Code (scmHistory.ts) 的侧枝汇入曲线: 先一段竖线, 再一个标准四分之一圆弧落到节点中线。
          // sweep-flag 必须是 1: 圆心在起点左上方 (x1-laneW, y-laneW), 曲线"先向下、再向左"收进节点。
          // 用 0 会把圆心放到右下方, 画出水平镜像的弧 (先向左、再向下), 也就是弧线方向反了。
          const d = [
            'M ' + x1 + ' 0',
            'V ' + Math.max(0, y - laneW),
            'A ' + laneW + ' ' + laneW + ' 0 0 1 ' + (x1 - laneW) + ' ' + y,
            'H ' + cx,
          ].join(' ');
          content += curvedLane(d, inputLane.color);
        } else if (c.parents.length > 0) {
          outputIndex++;
        }
        continue;
      }
      if (outputIndex >= outputSwimlanes.length || inputLane.hash !== outputSwimlanes[outputIndex].hash) { continue; }
      const x2 = laneX(outputIndex);
      if (index === outputIndex) {
        content += expanded ? expandedLane(x1, 0, inputLane.color)
          : '<path class="lane-straight" d="M ' + x1 + ' 0 V ' + rowH + '" fill="none" stroke="' + inputLane.color + '" stroke-width="' + LANE_STROKE_W + '"/>';
      } else {
        const d = [
          'M ' + x1 + ' 0',
          'V ' + (y - LANE_CURVE_R),
          'A ' + LANE_CURVE_R + ' ' + LANE_CURVE_R + ' 0 0 1 ' + (x1 - LANE_CURVE_R) + ' ' + y,
          'H ' + (x2 + LANE_CURVE_R),
          'A ' + LANE_CURVE_R + ' ' + LANE_CURVE_R + ' 0 0 0 ' + x2 + ' ' + (y + LANE_CURVE_R),
          'V ' + rowH,
        ].join(' ');
        content += curvedLane(d, inputLane.color, x2);
      }
      outputIndex++;
    }

    // merge 的剩余父提交 (第 2+ 个): 与 VS Code 一样，先水平、再用一整个泳道宽度的圆弧落入父泳道。
    for (let parentIndex = 1; parentIndex < c.parents.length; parentIndex++) {
      let parentOutputIndex = -1;
      for (let index = outputSwimlanes.length - 1; index >= 0; index--) {
        if (outputSwimlanes[index].hash === c.parents[parentIndex]) { parentOutputIndex = index; break; }
      }
      if (parentOutputIndex < 0) { continue; }
      const parentX = laneX(parentOutputIndex);
      const curveStartX = parentX - laneW;
      const curveEndY = Math.min(rowH, y + laneW);
      const d = [
        'M ' + curveStartX + ' ' + y,
        'A ' + laneW + ' ' + laneW + ' 0 0 1 ' + parentX + ' ' + curveEndY,
        'V ' + rowH,
        'M ' + curveStartX + ' ' + y,
        'H ' + cx,
      ].join(' ');
      content += curvedLane(d, outputSwimlanes[parentOutputIndex].color, parentX);
    }

    // 真实提交之间保持原色实线；列表头部 stash 前缀到最新提交的连接继续使用虚线。
    if (inputIndex >= 0 || connectedFromStash) {
      const color = inputIndex >= 0 ? inputSwimlanes[inputIndex].color : commitColor;
      content += leadingStashConnection
        ? '<path class="stash-prefix-lane" d="M ' + cx + ' 0 V ' + y + '" fill="none" stroke="' + color + '" ' + laneDashAttrs(ROW_H * (idx + 1), LANE_STROKE_W) + '/>'
        : '<path class="lane-straight" d="M ' + cx + ' 0 V ' + y + '" fill="none" stroke="' + color + '" stroke-width="' + LANE_STROKE_W + '"/>';
    }
    if (c.parents.length > 0) {
      // 主干是一条完整直线，不在 26px 标题边界拆成两个相叠的描边。
      content += expanded ? expandedLane(cx, y, commitColor)
        : '<path class="lane-straight" d="M ' + cx + ' ' + y + ' V ' + rowH + '" fill="none" stroke="' + commitColor + '" stroke-width="' + LANE_STROKE_W + '"/>';
    }
    // 工作区虚拟行插在列表最前(afterbegin), 其正下方就是 commits[0]。Uncommitted Changes 行向下垂一段虚线,
    //   需在该首行 commit 节点上方补一段虚线衔接, 使 Uncommitted Changes 与节点视觉连通。
    //   判定用 idx===0(布局上紧邻虚拟行)而非 refs 含 'HEAD'(部分仓库首行 refs 无字面量 HEAD, 导致永不命中)。
    var hasUncommittedRow = workingTreeRowsState.some(function(row) { return row.hash === 'uncommitted'; });
    if (idx === 0 && (hasUncommittedRow || cloudConnectsToFirstCommit()) && inputIndex < 0) {
      content += '<path d="M ' + cx + ' 0 V ' + y + '" fill="none" stroke="var(--vscode-descriptionForeground, #999)" ' + laneDashAttrs(0) + '/>';
    }

    // 普通提交为实心圆点；merge 提交改为“圆环 + 中心点”图标。颜色始终取所在泳道颜色。
    const isCurrentRef = c.gitBranchOption?.kind === 'current' && c.gitBranchOption.hash === c.hash;
    const isMerge = c.parents && c.parents.length > 1;
    if (isMerge) {
      const haloR = dotR + NODE_STROKE_W / 2;
      // 遮罩用 path 绘制，保证该行第一个 circle 仍是节点本身。
      content += '<path class="merge-node-halo" d="M ' + (cx - haloR) + ' ' + y + ' A ' + haloR + ' ' + haloR + ' 0 1 0 ' + (cx + haloR) + ' ' + y
        + ' A ' + haloR + ' ' + haloR + ' 0 1 0 ' + (cx - haloR) + ' ' + y + ' Z" fill="var(--vscode-editor-background)"/>';
      content += '<circle class="' + (isCurrentRef ? 'current-ref-dot ' : '') + 'merge-dot" cx="' + cx + '" cy="' + y + '" r="' + MERGE_RING_R
        + '" fill="var(--vscode-editor-background)" stroke="' + commitColor + '" stroke-width="' + MERGE_RING_W + '"/>';
      content += '<circle class="merge-dot-center" cx="' + cx + '" cy="' + y + '" r="' + MERGE_CENTER_R + '" fill="' + commitColor + '"/>';
    } else {
      content += '<circle class="' + (isCurrentRef ? 'current-ref-dot' : 'dot') + '" cx="' + cx + '" cy="' + y + '" r="' + dotR + '" fill="' + commitColor + '" stroke="var(--vscode-editor-background)" stroke-width="' + NODE_STROKE_W + '"/>';
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
