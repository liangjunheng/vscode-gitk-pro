import { MONACO_DIFF_LANGUAGES, MONACO_DIFF_OPTIONS } from './monacoDiffConfig';

/**
 * Gitk Diff 面板 webview 页面: Monaco Diff 卡片列表 + 滚动虚拟化 + 全局水平滚动条。
 * 页面整体由 render 函数产出, 面板类只负责准备 CSP / 资源 Uri / nonce。
 */
export function renderMultiDiffHtml(
    cspSource: string,
    codiconCssUri: string,
    monacoUri: string,
    nonce: string,
): string {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}' 'unsafe-eval'; worker-src ${cspSource}; font-src ${cspSource};"><link rel="stylesheet" href="${codiconCssUri}"><style>
/* 吸顶组与文件顶部高亮轮廓对齐，不额外向上偏移。
   --header-cover-bleed 控制标题栏背后不透明盖板向上及向两侧的延展。 */
:root{color-scheme:light dark;--header-surface:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground));--card-radius:9px;--card-border:1px;--card-ring:1px;--header-gap:0px;--header-inset:0px;--header-cover-bleed:8px;--parent-navigation-height:0px}
body.has-parent-navigation{--parent-navigation-height:40px}
*{box-sizing:border-box}
/* 不要给 html/body 设 overflow 或 min-height: 那会改变滚动容器归属, 使 window.scrollY /
   window 的 scroll 事件失效, 并让 sticky 的参照系偏移导致标题栏无法吸顶。保持文档视口滚动。 */
html.programmatic-reveal,html.programmatic-reveal body,html.settled-reveal-anchor,html.settled-reveal-anchor body{overflow-anchor:none}
body{margin:0;padding-bottom:14px;background:color-mix(in srgb, var(--vscode-editor-background) 50%, #000);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
#parent-commit-navigation{position:sticky;z-index:30;top:0;isolation:isolate;display:flex;width:100%;min-width:100%;height:40px;align-items:center;gap:10px;padding:0 10px;background:transparent}
#parent-commit-navigation::before{content:"";position:absolute;z-index:-1;top:0;bottom:0;left:calc(50% - 50vw);right:calc(50% - 50vw);pointer-events:none;border-bottom:1px solid color-mix(in srgb,var(--vscode-focusBorder) 36%,var(--vscode-editorGroup-border));background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editorWidget-background,var(--vscode-editor-background)));box-shadow:0 2px 7px rgba(0,0,0,.2)}
#parent-commit-navigation[hidden]{display:none}
#back-to-parent-commit{display:inline-flex;flex:0 0 auto;height:26px;align-items:center;justify-content:center;padding:0 10px;border:1px solid color-mix(in srgb,var(--vscode-focusBorder) 48%,transparent);border-radius:5px;color:var(--vscode-button-foreground,var(--vscode-foreground));background:color-mix(in srgb,var(--vscode-button-background) 72%,transparent);font:inherit;font-size:calc(var(--vscode-editor-font-size,13px) - 2px);font-weight:600;cursor:pointer}
#back-to-parent-commit:hover{background:var(--vscode-button-hoverBackground,var(--vscode-list-hoverBackground));border-color:var(--vscode-focusBorder)}
#back-to-parent-commit:active{transform:translateY(1px)}
#back-to-parent-commit:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
#parent-commit-info{display:flex;min-width:0;height:22px;flex:1 1 auto;align-items:center;gap:8px;padding-left:10px;border-left:1px solid color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}
#parent-commit-title{min-width:0;overflow:hidden;color:var(--vscode-foreground);font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
#parent-commit-hash{flex:0 0 auto;padding:2px 6px;border:1px solid color-mix(in srgb,var(--vscode-badge-background) 64%,var(--vscode-widget-border));border-radius:10px;color:var(--vscode-badge-foreground,var(--vscode-foreground));background:color-mix(in srgb,var(--vscode-badge-background) 78%,transparent);font-family:var(--vscode-editor-font-family,monospace);font-size:10px;line-height:14px;white-space:nowrap}
#loading{min-height:calc(100vh - var(--parent-navigation-height) - 14px);display:grid;place-items:center;color:var(--vscode-descriptionForeground)}
#loading[hidden]{display:none}
#list{width:100%;padding:8px}.multi-virtual-root{width:100%;min-width:0}.multi-virtual-spacer{width:1px;pointer-events:none}.multi-virtual-cards{display:flow-root;width:100%;min-width:0}
/* 渲染中：卡片已在文档流内（保证 Monaco 拿到真实宽度），仅视觉隐藏，避免逐个跳动。 */
#list.rendering{visibility:hidden}
/* overflow:clip 按圆角裁掉内容溢出, 又不像 overflow:hidden 那样创建滚动容器,
   因此标题栏的 position:sticky 仍然生效(hidden 会直接使 sticky 失效)。
   clip 范围必须容纳标题栏的 8px 不透明盖板；此前仅容纳 1px 外环，盖板延展部分被裁掉，
   无法遮住下层 diff 卡片的高亮线。 */
/* 每张 diff 卡片本身都是独立的定位层；标题栏下方的挡板属于各自 header-layer，
   不依赖 pinned 状态或动态提升整张卡片。 */
.diff{position:relative;width:100%;min-width:0;margin:0 0 14px;border:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius);background:var(--vscode-editor-background);box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:clip;overflow-clip-margin:calc(var(--header-cover-bleed) + var(--card-border) + var(--card-ring))}
.diff:last-child{margin-bottom:0}
.diff.selected{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 var(--card-ring) var(--vscode-focusBorder),0 1px 4px rgba(0,0,0,.08)}
/* 标题栏贴合卡片顶部与两侧内沿并沿用圆角，但不覆盖卡片边框本身。 */
.file-header{display:grid;grid-template-columns:minmax(0,1fr);width:100%;margin:0;padding:4px 8px;border:0;color:var(--vscode-tab-activeForeground);background:var(--header-surface);font:inherit;font-size:calc(var(--vscode-editor-font-size) * .95);text-align:left;cursor:pointer}
.file-header.rename-header{grid-template-columns:calc((100% + 26px)/2) minmax(0,1fr);padding-right:0;padding-left:0}
.file-header.rename-header .title-side-left{padding-left:8px}
.file-header:hover{background:var(--vscode-list-hoverBackground,var(--vscode-editorWidget-background))}
/* 标题栏底边保持常规边框色: 选中高光只体现在卡片外框与顶部预留条, 底部不跟着高亮。 */
.diff.collapsed>.pinned-group>.header-layer>.header-row>.file-header{border-bottom-color:transparent}
.title-side{display:flex;align-items:center;gap:6px;min-width:0}
.title-side-right{padding-right:34px}
.diff-chevron{flex:0 0 auto;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;transition:transform .12s ease}
.diff.collapsed .diff-chevron{transform:rotate(-90deg)}
.working-tree-kind{display:inline-grid;place-items:center;flex:0 0 20px;width:20px;height:20px;box-sizing:border-box}
.working-tree-kind svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.working-tree-kind-conflict{color:var(--vscode-gitDecoration-conflictingResourceForeground,#e51400)}
.working-tree-kind-untracked{color:var(--vscode-gitDecoration-untrackedResourceForeground,var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c))}
.working-tree-kind-untracked .kind-file{stroke-dasharray:1.6 1.6}
.working-tree-kind-unstaged{color:var(--vscode-foreground)}
.working-tree-kind-staged{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.status{flex:0 0 auto;width:14px;text-align:center;font-weight:600}
.status-A{color:var(--vscode-gitDecoration-addedResourceForeground)}
.status-M{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.status-D{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.status-U{color:var(--vscode-gitDecoration-conflictingResourceForeground,#e51400)}
.status-R,.status-C{color:var(--vscode-gitDecoration-renamedResourceForeground)}
.line-stats{flex:0 0 auto;display:none;gap:6px;font-size:calc(var(--vscode-editor-font-size) * .85);font-variant-numeric:tabular-nums}
.line-stats.ready{display:inline-flex}
.line-stat-added{color:var(--vscode-gitDecoration-addedResourceForeground)}
.line-stat-removed{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.file-location{display:flex;align-items:center;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.file-location.is-deleted{text-decoration-line:line-through;text-decoration-thickness:1px}
.file-name{flex:0 0 auto;font-size:calc(var(--vscode-editor-font-size) + 2px);line-height:1.2}
.file-path-gap{flex:0 0 auto;white-space:pre}
.file-folder{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground);opacity:.72;line-height:1.2}
/* 标题栏和 index 栏是同一吸顶组: 顶部与左右边都复刻卡片的 border + ring 宽度。
   负水平 margin 让这三条高亮边精确覆盖卡片的外环和边框；不能用 overflow:hidden 裁圆角，
   否则会改变 sticky 滚动上下文。 */
.pinned-group{position:sticky;top:calc(var(--parent-navigation-height) + var(--header-gap) + var(--header-inset));z-index:2;margin-top:calc((var(--card-border) + var(--card-ring)) * -1);margin-right:calc((var(--card-border) + var(--card-ring)) * -1);margin-bottom:0;margin-left:calc((var(--card-border) + var(--card-ring)) * -1);border-top:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-right:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-left:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;background:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground));box-shadow:0 1px 3px rgba(0,0,0,.18)}
/* 独立标题层在 pinned 组内建立完整的遮罩层叠上下文: 盖板覆盖相邻 diff 内容和其 box-shadow 高亮，
   但低于标题内容与 pinned 轮廓。底边严格等于标题栏底边，上/左/右外延 8px。 */
.diff.selected>.pinned-group{border-color:var(--vscode-focusBorder)}
.header-layer{position:relative;z-index:1}
.header-layer::before{content:'';position:absolute;z-index:0;top:calc(var(--header-cover-bleed) * -1);right:calc(var(--header-cover-bleed) * -1);bottom:0;left:calc(var(--header-cover-bleed) * -1);background:var(--vscode-editor-background);pointer-events:none}
.header-row{position:relative;z-index:1;display:flex;align-items:center}
.header-row>.file-header,.header-row>.diff-actions{position:relative;z-index:1}
/* 轮廓层位于盖板上方：向外延展高亮总宽度，和底层卡片的三边高亮线无缝连接。 */
.pinned-group::after{content:'';position:absolute;z-index:3;top:calc((var(--card-border) + var(--card-ring)) * -1);right:calc((var(--card-border) + var(--card-ring)) * -1);bottom:0;left:calc((var(--card-border) + var(--card-ring)) * -1);border-top:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-right:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-left:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;pointer-events:none}
.diff.selected>.pinned-group::after{border-color:var(--vscode-focusBorder)}
.header-row>.file-header{flex:1 1 auto;min-width:0;border-radius:calc(var(--card-radius) - var(--card-border) - var(--card-ring)) 0 0 0}
.diff-actions{align-self:stretch;flex:0 0 auto;display:flex;align-items:center;gap:2px;margin-right:0;padding-right:4px;background:var(--header-surface)}
.diff-action,.open-file{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;color:var(--vscode-icon-foreground,currentColor);background:transparent;border:0;border-radius:5px;cursor:pointer}
.diff-action:hover,.open-file:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
.diff-action:active,.open-file:active{background:var(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground)))}
.diff-action:focus-visible,.open-file:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.diff-action .codicon,.open-file .codicon{font-size:16px}
.diff.collapsed>.pinned-group{border-radius:var(--card-radius)}
.diff.collapsed>.pinned-group>.header-layer>.header-row>.file-header{border-radius:calc(var(--card-radius) - var(--card-border) - var(--card-ring)) 0 0 calc(var(--card-radius) - var(--card-border) - var(--card-ring))}
/* 标题栏下方的 git 元信息行: index <old>..<new> <mode> 以及重命名来源。 */
.file-meta{position:relative;z-index:1;display:flex;flex-direction:column;gap:1px;padding:0 8px 4px;border-bottom:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));color:var(--vscode-descriptionForeground);background:var(--header-surface);font-family:var(--vscode-editor-font-family,monospace);font-size:calc(var(--vscode-editor-font-size) * .85);line-height:1.45}
.diff.collapsed>.pinned-group>.file-meta{display:none}
.meta-line{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.meta-rename-from{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.meta-rename-to{color:var(--vscode-gitDecoration-addedResourceForeground)}
.gitlink-label{display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--vscode-badge-background,var(--vscode-widget-border));border-radius:3px;color:var(--vscode-badge-foreground,var(--vscode-descriptionForeground));font-size:10px;font-weight:400;line-height:14px;vertical-align:middle}
.meta-gitlink{color:var(--vscode-foreground)}
.gitlink-commits{padding:4px 0;background:var(--vscode-editor-background)}
.gitlink-commit{display:grid;width:100%;grid-template-columns:auto minmax(0,1fr);gap:8px;margin:0;padding:7px 10px;border:0;border-bottom:1px solid var(--vscode-editorWidget-border,var(--vscode-panel-border));color:inherit;background:transparent;font:inherit;font-family:var(--vscode-editor-font-family,monospace);line-height:1.45;text-align:left;cursor:pointer;appearance:none}
.gitlink-commit:hover{background:var(--vscode-list-hoverBackground)}
.gitlink-commit:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}
.gitlink-commit:last-child{border-bottom:0}
.gitlink-commit-hash{color:var(--vscode-textLink-foreground);white-space:nowrap}
.gitlink-commit-message{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
@keyframes gitlink-loading-spin{to{transform:rotate(360deg)}}
.gitlink-loading{display:inline-flex;align-items:center;justify-content:center;gap:8px}
.gitlink-loading-spinner{width:13px;height:13px;border:2px solid var(--vscode-descriptionForeground);border-top-color:var(--vscode-focusBorder);border-radius:50%;animation:gitlink-loading-spin .8s linear infinite}
.diff-body{border-radius:0 0 calc(var(--card-radius) - var(--card-border)) calc(var(--card-radius) - var(--card-border));overflow:hidden}
.diff.collapsed>.diff-body{display:none}
.editor{position:relative;width:100%;min-width:0;height:80px}
/* 二进制文件沿用旧版 Custom Diff 的左右面板展示，而不是压缩成单行空态。 */
.binary-diff{display:grid;width:100%;min-width:0;min-height:80px;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:stretch;background:var(--vscode-editor-background)}
.binary-diff.inline{display:block}
.binary-pane{min-width:0;overflow:hidden;border-right:1px solid var(--vscode-editorGroup-border)}
.binary-pane-right{border-right:0}
.binary-unified-pane{display:none}
.binary-diff.inline>.binary-pane{display:none}
.binary-diff.inline>.binary-unified-pane{display:block}
.binary-pane-title{box-sizing:border-box;display:block;height:25px;padding:4px 8px;overflow:hidden;border-bottom:1px solid var(--vscode-editorGroup-border);color:var(--vscode-editor-foreground);background:color-mix(in srgb,var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground)) 85%,#000 15%);text-overflow:ellipsis;white-space:nowrap}
.binary-empty{min-height:55px}
.empty{padding:16px 8px;color:var(--vscode-descriptionForeground);text-align:center}.diff-loading{min-height:80px;display:grid;place-items:center;color:var(--vscode-descriptionForeground)}
.gitk-diff-link-hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;cursor:pointer}
.gitk-change-flash{position:absolute;z-index:12;right:2px;left:2px;pointer-events:none;border-radius:4px;background:color-mix(in srgb,var(--vscode-focusBorder,#007acc) 30%,transparent);box-shadow:inset 0 0 0 2px var(--vscode-focusBorder,#007acc),0 3px 8px rgba(0,0,0,.38),0 1px 2px rgba(0,0,0,.28);transform:translateY(-1px)}
#global-hscroll{position:fixed;z-index:20;right:0;bottom:0;left:0;height:14px;overflow-x:auto;overflow-y:hidden;background:var(--vscode-scrollbar-shadow,rgba(0,0,0,.18));scrollbar-color:var(--vscode-scrollbarSlider-background) transparent;scrollbar-width:auto}
#global-hscroll[hidden]{display:none}
#global-hscroll-content{height:1px;pointer-events:none}
</style></head><body><div id="parent-commit-navigation" hidden><button id="back-to-parent-commit" type="button" title="回到父提交"><span>回到父提交</span></button><div id="parent-commit-info"><span id="parent-commit-title"></span><span id="parent-commit-hash"></span></div></div><div id="loading">正在准备 Diff...</div><main id="list" hidden></main><div id="global-hscroll" role="scrollbar" aria-label="当前 Diff 水平滚动" aria-orientation="horizontal" hidden><div id="global-hscroll-content"></div></div><script nonce="${nonce}">window.gitkQueue=[];window.addEventListener('message',event=>window.gitkQueue.push(event.data));window.gitkVscode=acquireVsCodeApi();</script><script nonce="${nonce}" src="${monacoUri}/loader.js"></script><script nonce="${nonce}">
self.MonacoEnvironment={getWorker:()=>new Worker('${monacoUri}/base/worker/workerMain.js')};
const parentCommitNavigation=document.getElementById('parent-commit-navigation'),backToParentCommit=document.getElementById('back-to-parent-commit'),parentCommitTitle=document.getElementById('parent-commit-title'),parentCommitHash=document.getElementById('parent-commit-hash'),loading=document.getElementById('loading'),list=document.getElementById('list'),globalHScroll=document.getElementById('global-hscroll'),globalHScrollContent=document.getElementById('global-hscroll-content'),languages=${JSON.stringify(MONACO_DIFF_LANGUAGES)},diffOptions=${JSON.stringify(MONACO_DIFF_OPTIONS)};
const report=message=>{try{window.gitkVscode.postMessage({type:'error',message})}catch(_){}};
const log=message=>{try{window.gitkVscode.postMessage({type:'log',message})}catch(_){}};
const notifyRendered=(revision,identity)=>{try{window.gitkVscode.postMessage({type:'rendered',revision,identity})}catch(_){}};
function setParentCommitNavigation(parentCommit){
  const visible=Boolean(parentCommit&&parentCommit.hash);
  parentCommitNavigation.hidden=!visible;document.body.classList.toggle('has-parent-navigation',visible);
  const fullTitle=visible&&parentCommit.title?String(parentCommit.title):'';
  const title=fullTitle?fullTitle.split(/\\r?\\n/,1)[0]:'父提交';
  parentCommitTitle.textContent=visible?title:'';parentCommitTitle.title=visible?fullTitle:'';
  parentCommitHash.textContent=visible?String(parentCommit.hash).slice(0,8):'';
  backToParentCommit.title=visible?(fullTitle?'回到父提交：'+title:'回到父提交'):'';
  if(programmaticRevealPath)scheduleProgrammaticReveal();else scheduleVirtualization();
}
backToParentCommit.addEventListener('click',function(){try{window.gitkVscode.postMessage({type:'backToParentCommit'})}catch(_){}});
let monacoReady=false,lastRevision=0,lastIdentity='',selectionEpoch=0,pending,pendingRevealPath='',cards=[],cardByPath=new Map(),activePath='',clickedPath='',externalRevealPath='',externalRevealFrame=0,suppressSyncUntil=0,scrollAnimationFrame=0,programmaticRevealPath='',programmaticRevealFrame=0,programmaticRevealStableFrames=0,programmaticRevealTargetReady=false,programmaticRevealTimer=0,virtualJumpAnchorFrame=0,settledRevealAnchorPath='',settledRevealObserver=null,settledRevealAlignFrame=0,revealTailPath='',renderToken=0,editable=false,renderSideBySide=diffOptions.renderSideBySide!==false,virtualFrame=0,editorPool=[],syncingGlobalHScroll=false,hScrollFrame=0,pinnedAnchor=null,virtualRoot=null,virtualTop=null,virtualCardsHost=null,virtualBottom=null,layoutPrefix=[],layoutTotal=0,layoutDirty=true,virtualWindowStart=0,virtualWindowEnd=-1,mountedCardEntries=new Set();
function setRenderSideBySide(nextValue){
  renderSideBySide=nextValue;
  for(const entry of cards){
    if(entry.editor){entry.editor.updateOptions({renderSideBySide:renderSideBySide});entry.fit()}
    const binary=entry.body&&entry.body.querySelector('.binary-diff');if(binary)binary.classList.toggle('inline',!renderSideBySide)
  }
  for(const slot of editorPool)slot.editor.updateOptions({renderSideBySide:renderSideBySide});
  updateGlobalHScroll();
}
function diffKey(diff){return diff.diffKey||diff.path}
let activeChangeIndex=-1,activeChangePage=0;const requestedDiffPaths=new Set(),prioritizedDiffPaths=new Set(),pendingDiffRequestPaths=new Set(),pendingPriorityDiffRequestPaths=new Set();let diffRequestScheduled=false,mountedEntries=new Set(),pendingDiffUpdates=[],editorMountQueue=[],queuedEditorMounts=new Set(),editorMountFrame=0;
function activeEntry(){return activePath&&cardByPath.get(activePath)}
function navigableChanges(entry){
  const changes=entry.editor&&entry.editor.getLineChanges()||[];
  if(changes.length)return changes;
  const diff=entry.diff;
  if(diff.status!=='R'||!diff.oldPath||diff.oldPath===diff.path||!entry.editor)return [];
  const leftCount=entry.editor.getOriginalEditor().getModel().getLineCount();
  const rightCount=entry.editor.getModifiedEditor().getModel().getLineCount();
  return [{originalStartLineNumber:1,originalEndLineNumber:leftCount,modifiedStartLineNumber:1,modifiedEndLineNumber:rightCount,wholeFileRename:true}]
}
function changeBlockGeometry(editor,startLine,endLine){
  const lineCount=editor.getModel().getLineCount();
  const top=editor.getTopForLineNumber(startLine)-editor.getScrollTop();
  const bottom=endLine<lineCount?editor.getTopForLineNumber(endLine+1)-editor.getScrollTop():editor.getTopForLineNumber(endLine)+editor.getOption(monaco.editor.EditorOption.lineHeight)-editor.getScrollTop();
  return {top:top,height:Math.max(2,bottom-top)}
}
function changePageTop(editor,lineNumber,visibleTop){
  const node=editor.getDomNode();
  const lineTop=editor.getTopForLineNumber(lineNumber);
  return node.getBoundingClientRect().top+window.scrollY+lineTop-editor.getScrollTop()-visibleTop
}
function clearChangeFlash(entry){
  if(entry.flashTimer){clearTimeout(entry.flashTimer);entry.flashTimer=0}
  if(entry.flashOverlay){entry.flashOverlay.remove();entry.flashOverlay=null}
}
function changePageInfo(entry,change){
  const left=entry.editor.getOriginalEditor(),right=entry.editor.getModifiedEditor(),blocks=[];
  if(change.originalEndLineNumber>0)blocks.push(changeBlockGeometry(left,change.originalStartLineNumber,change.originalEndLineNumber));
  if(change.modifiedEndLineNumber>0)blocks.push(changeBlockGeometry(right,change.modifiedStartLineNumber,change.modifiedEndLineNumber));
  const top=Math.min.apply(null,blocks.map(function(block){return block.top}));
  const height=Math.max.apply(null,blocks.map(function(block){return block.height}));
  const stickyTop=parseFloat(getComputedStyle(entry.pinnedGroup).top)||0;
  const visibleTop=stickyTop+entry.pinnedGroup.getBoundingClientRect().height;
  const visibleBottom=window.innerHeight-14;
  const navigationTop=visibleTop+(visibleBottom-visibleTop)/5;
  const pageHeight=Math.max(80,visibleBottom-navigationTop);
  return {top:top,height:height,visibleTop:visibleTop,visibleBottom:visibleBottom,navigationTop:navigationTop,pageHeight:pageHeight,pageCount:Math.max(1,Math.ceil(height/pageHeight))}
}
function flashChange(entry,pageInfo,page,wholeFile){
  clearChangeFlash(entry);
  const top=pageInfo.top+page*pageInfo.pageHeight;
  const height=wholeFile?pageInfo.height:Math.min(pageInfo.pageHeight,pageInfo.height-page*pageInfo.pageHeight);
  const overlay=document.createElement('div');overlay.className='gitk-change-flash';
  overlay.style.top=Math.max(0,top)+'px';overlay.style.height=Math.max(2,height)+'px';
  entry.slot.host.append(overlay);entry.flashOverlay=overlay;
  entry.flashTimer=setTimeout(function(){clearChangeFlash(entry)},650)
}
function selectLineChange(entry,index,page){
  const changes=navigableChanges(entry),change=changes[index];
  if(!change)return false;
  const left=entry.editor.getOriginalEditor(),right=entry.editor.getModifiedEditor(),pageInfo=changePageInfo(entry,change);
  const targetPage=Math.max(0,Math.min(pageInfo.pageCount-1,page||0));
  const baseTop=change.originalEndLineNumber>0?changePageTop(left,change.originalStartLineNumber,pageInfo.navigationTop):changePageTop(right,change.modifiedStartLineNumber,pageInfo.navigationTop);
  const targetTop=Math.max(0,baseTop+targetPage*pageInfo.pageHeight);
  const targetHeight=change.wholeFileRename===true?pageInfo.height:Math.min(pageInfo.pageHeight,pageInfo.height-targetPage*pageInfo.pageHeight);
  const targetViewportTop=targetTop+pageInfo.navigationTop-window.scrollY;
  const targetWasVisible=targetViewportTop<pageInfo.visibleBottom&&targetViewportTop+Math.max(2,targetHeight)>pageInfo.visibleTop;
  externalRevealPath='';cancelProgrammaticReveal();clickedPath=entry.path;setActive(entry.path,true);activeChangeIndex=index;activeChangePage=targetPage;
  flashChange(entry,pageInfo,targetPage,change.wholeFileRename===true);
  // 保留原有差异游标状态；仅在目标差异离屏时直接定位，避免大跨度滚动沿途切换文件。
  if(targetWasVisible&&Math.abs(targetTop-window.scrollY)<=Math.max(1200,window.innerHeight*2))animateScrollTo(targetTop,function(){scheduleVirtualization()});
  else{
    if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}
    suppressSyncUntil=performance.now()+120;window.scrollTo({top:targetTop,behavior:'auto'});scheduleVirtualization()
  }
  return true
}
function nextNavigationFrame(){return new Promise(function(resolve){requestAnimationFrame(resolve)})}
async function prepareNavigationEntry(entry,originPath){
  if(!entry||entry.collapsed)return false;
  const deadline=performance.now()+5000;
  if(entry.diff.loaded!==true){
    ensureDiffRequested(entry,true);
    while(entry.diff.loaded!==true&&activePath===originPath&&cardByPath.get(entry.path)===entry&&performance.now()<deadline)await nextNavigationFrame()
  }
  if(activePath!==originPath||cardByPath.get(entry.path)!==entry||entry.diff.loaded!==true||entry.staticContent||entry.collapsed)return false;
  // 虚拟化只在跨文件导航时补齐目标外壳；当前卡片内仍完全沿用原来的差异游标逻辑。
  if(!entry.card||!entry.body)updateVirtualizationAtIndex(entry.index,true,true);
  if(!entry.card||!entry.body)return false;
  if(!entry.mounted&&!entry.mounting)mountEntry(entry,false).catch(function(error){markCardFailed(entry,error)});
  // updateVirtualizationAtIndex 可能已开始异步挂载，等待 Monaco 真正算完差异后再读取游标。
  while(activePath===originPath&&cardByPath.get(entry.path)===entry&&performance.now()<deadline){
    try{if(entry.editor&&entry.editor.getLineChanges()!==null)return true}catch(_){}
    await nextNavigationFrame()
  }
  return false
}
async function findNavigableEntry(start,direction,originPath){
  for(let index=start;index>=0&&index<cards.length;index+=direction){
    if(activePath!==originPath)return null;
    const entry=cards[index];
    if(!await prepareNavigationEntry(entry,originPath))continue;
    const changes=navigableChanges(entry);
    if(changes.length)return {entry:entry,index:direction>0?0:changes.length-1}
  }
  return null
}
async function navigateChange(direction){
  // 差异导航是独立用户操作，先解除 Changed Files 的程序化定位；游标推进规则保持旧版不变。
  externalRevealPath='';
  if(externalRevealFrame){cancelAnimationFrame(externalRevealFrame);externalRevealFrame=0}
  cancelProgrammaticReveal();
  const current=activeEntry();
  if(current&&current.editor){
    const changes=navigableChanges(current);
    if(activeChangeIndex>=0&&activeChangeIndex<changes.length){
      const pageInfo=changePageInfo(current,changes[activeChangeIndex]),nextPage=activeChangePage+direction;
      if(nextPage>=0&&nextPage<pageInfo.pageCount){selectLineChange(current,activeChangeIndex,nextPage);return}
    }
    const candidate=activeChangeIndex<0?(direction>0?0:changes.length-1):activeChangeIndex+direction;
    if(candidate>=0&&candidate<changes.length){
      const pageInfo=changePageInfo(current,changes[candidate]);
      selectLineChange(current,candidate,direction>0?0:pageInfo.pageCount-1);return
    }
  }
  const originPath=activePath;
  const start=current?current.index+direction:(direction>0?0:cards.length-1);
  const target=await findNavigableEntry(start,direction,originPath);
  if(target){
    const changes=navigableChanges(target.entry),pageInfo=changePageInfo(target.entry,changes[target.index]);
    selectLineChange(target.entry,target.index,direction>0?0:pageInfo.pageCount-1)
  }
}

function sideMaxScrollLeft(side){if(!side)return 0;const layout=side.getLayoutInfo();return Math.max(0,side.getScrollWidth()-(layout.contentWidth||0))}
function updateGlobalHScroll(){
  if(hScrollFrame)return;
  hScrollFrame=requestAnimationFrame(function(){
    hScrollFrame=0;
    const entry=activeEntry();
    if(!entry||!entry.mounted||!entry.editor||entry.collapsed){globalHScroll.hidden=true;globalHScroll.scrollLeft=0;return}
    const left=entry.editor.getOriginalEditor(),right=entry.editor.getModifiedEditor();
    const max=Math.max(sideMaxScrollLeft(left),sideMaxScrollLeft(right));
    if(max<1){globalHScroll.hidden=true;globalHScroll.scrollLeft=0;return}
    globalHScroll.hidden=false;
    globalHScrollContent.style.width=(globalHScroll.clientWidth+max)+'px';
    syncingGlobalHScroll=true;globalHScroll.scrollLeft=entry.horizontalLeft||Math.max(left.getScrollLeft(),right.getScrollLeft());syncingGlobalHScroll=false;
  });
}
// 空闲编辑器池覆盖前后 overscan 卡片，避免跨虚拟窗口时销毁后又立即重建同等数量的 Monaco。
const SCROLL_DURATION=150,EDITOR_OVERSCAN_CARDS=10,MAX_IDLE_EDITORS=EDITOR_OVERSCAN_CARDS*2,MAX_EDITOR_MOUNTS_PER_FRAME=2;
function show(message){loading.textContent=message;loading.hidden=false;list.hidden=true;list.classList.remove('rendering')}
function fail(error){const message=error&&error.message||String(error);show('Diff 渲染失败: '+message);report(message)}
function destroySlot(slot){try{slot.editor.setModel(null)}catch(_){}try{slot.editor.dispose()}catch(_){}try{slot.host.remove()}catch(_){}}
function releaseSlot(slot){
  slot.owner=null;slot.generation++;try{slot.editor.setModel(null)}catch(_){}try{slot.host.remove()}catch(_){}
  editorPool.push(slot);while(editorPool.length>MAX_IDLE_EDITORS)destroySlot(editorPool.shift());
}
function acquireSlot(entry){
  const slot=editorPool.pop()||function(){
    const host=document.createElement('div');host.className='editor';
    const editor=monaco.editor.createDiffEditor(host,Object.assign({},diffOptions,{readOnly:!editable,renderSideBySide:renderSideBySide}));
    applyVsCodeFont(editor);return {host:host,editor:editor,owner:null,generation:0};
  }();
  // 对象池中的 host 可能保留上一张卡片的高度；挂载前同步当前逻辑高度，避免首次测量基于旧尺寸。
  const initialHeight=Math.max(80,entry.bodyHeight||80);
  slot.owner=entry;slot.generation++;slot.host.style.height=initialHeight+'px';entry.body.style.height=initialHeight+'px';entry.body.replaceChildren(slot.host);return slot;
}
function disposeEntry(entry){
  mountedEntries.delete(entry);queuedEditorMounts.delete(entry);
  clearChangeFlash(entry);
  entry.mountVersion++;
  if(entry.path===activePath)globalHScroll.hidden=true;
  if(entry.saveTimer){clearTimeout(entry.saveTimer);entry.saveTimer=0}
  if(entry.modified){
    entry.modifiedValue=entry.modified.getValue();
    entry.originalSelections=entry.editor.getOriginalEditor().getSelections();
    entry.modifiedSelections=entry.editor.getModifiedEditor().getSelections();
  }
  for(const disposable of entry.disposables||[]){try{disposable.dispose()}catch(_){}}
  entry.disposables=[];
  if(entry.slot)releaseSlot(entry.slot);
  if(entry.original){try{entry.original.dispose()}catch(_){}}
  if(entry.modified){try{entry.modified.dispose()}catch(_){}}
  entry.slot=null;entry.editor=null;entry.original=null;entry.modified=null;entry.fit=function(){};entry.mounted=false;entry.mounting=false;
  if(entry.body&&!entry.collapsed&&!entry.staticContent){entry.body.replaceChildren();entry.body.style.height=Math.max(80,entry.bodyHeight||80)+'px'}
}
function dispose(){
  renderToken++;clearVirtualJumpAnchor();clearSettledRevealAnchor();
  if(virtualFrame){cancelAnimationFrame(virtualFrame);virtualFrame=0}
  if(externalRevealFrame){cancelAnimationFrame(externalRevealFrame);externalRevealFrame=0}
  if(editorMountFrame){cancelAnimationFrame(editorMountFrame);editorMountFrame=0}
  editorMountQueue=[];queuedEditorMounts.clear();
  if(programmaticRevealFrame){cancelAnimationFrame(programmaticRevealFrame);programmaticRevealFrame=0}
  if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}
  if(programmaticRevealTimer){clearTimeout(programmaticRevealTimer);programmaticRevealTimer=0}
  programmaticRevealPath='';programmaticRevealStableFrames=0;programmaticRevealTargetReady=false;revealTailPath='';externalRevealPath='';
  for(const entry of cards){disposeEntry(entry);if(entry.card)entry.card.remove();entry.card=null;entry.header=null;entry.meta=null;entry.pinnedGroup=null;entry.body=null}
  mountedCardEntries.clear();
  while(editorPool.length)destroySlot(editorPool.pop());
  mountedEntries.clear();
  requestedDiffPaths.clear();prioritizedDiffPaths.clear();pendingDiffRequestPaths.clear();pendingPriorityDiffRequestPaths.clear();diffRequestScheduled=false;
  virtualRoot=null;virtualTop=null;virtualCardsHost=null;virtualBottom=null;layoutPrefix=[];layoutTotal=0;layoutDirty=true;virtualWindowStart=0;virtualWindowEnd=-1;
  // 去重键必须随卡片集合一起归零：卡片全部销毁后旧的可视路径不再成立，
  // 否则重建出相同路径时会被误判为"未变化"而永不重新上报，使 Host 集合停留在空态。
  lastVisibleDiffPaths='';
  cards=[];cardByPath=new Map();activePath='';clickedPath='';activeChangeIndex=-1;activeChangePage=0;pinnedAnchor=null;list.replaceChildren();globalHScroll.hidden=true;globalHScroll.scrollLeft=0
}
function language(path){const ext=path.slice(path.lastIndexOf('.')+1).toLowerCase();return languages[ext]||'plaintext'}
function escapeHtml(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function pathHtml(path,deleted){const slash=path.lastIndexOf('/');const name=slash<0?path:path.slice(slash+1),folder=slash<0?'':path.slice(0,slash+1);return '<span class="file-location'+(deleted?' is-deleted':'')+'" title="'+escapeHtml(path)+'"><span class="file-name">'+escapeHtml(name)+'</span>'+(folder?'<span class="file-path-gap"> </span><span class="file-folder">'+escapeHtml(folder)+'</span>':'')+'</span>'}
function statusHtml(status){return '<span class="status status-'+escapeHtml(status)+'">'+escapeHtml(status)+'</span>'}
function workingTreeKindHtml(kind){
  if(kind==='conflict')return '<span class="working-tree-kind working-tree-kind-conflict" title="Conflict：存在未解决冲突" aria-label="Conflict：存在未解决冲突"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5 16 15.5H2Z"/><path d="M9 6.25v4.5M9 13v.1" stroke-width="1.8"/></svg></span>';
  if(kind==='staged')return '<span class="working-tree-kind working-tree-kind-staged" title="Staged：已暂存" aria-label="Staged：已暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="m5.8 9 2.1 2.1 4.35-4.45" stroke-width="2"/></svg></span>';
  if(kind==='untracked')return '<span class="working-tree-kind working-tree-kind-untracked" title="Untracked：未跟踪" aria-label="Untracked：未跟踪"><svg viewBox="0 0 18 18" aria-hidden="true"><circle class="kind-file" cx="9" cy="9" r="6.25"/><path d="M7.15 7.15c.15-2.1 3.85-2.15 3.85.15 0 1.55-2 1.65-2 3.15M9 12.75v.1" stroke-width="1.7"/></svg></span>';
  if(kind==='unstaged')return '<span class="working-tree-kind working-tree-kind-unstaged" title="Unstaged：未暂存" aria-label="Unstaged：未暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="M9 5.25v4.5M9 12.4v.1" stroke-width="2"/></svg></span>';
  return '';
}
function gitlinkLabelHtml(){return '<span class="gitlink-label" title="Submodule repository">Repo</span>'}
function gitlinkBodyHtml(diff){
  if(diff.gitlinkScanPending)return '<div class="empty gitlink-loading"><span class="gitlink-loading-spinner" aria-hidden="true"></span><span>正在扫描子模块提交…</span></div>';
  const commits=diff.gitlinkRangeCommits&&diff.gitlinkRangeCommits.length?diff.gitlinkRangeCommits:[diff.status==='A'?undefined:diff.oldGitlinkCommit,diff.status==='D'?undefined:diff.newGitlinkCommit].filter(function(commit,index,values){return commit&&values.findIndex(function(item){return item&&item.hash===commit.hash})===index});
  if(!commits.length)return '<div class="empty">没有可显示的子模块提交。</div>';
  return '<div class="gitlink-commits">'+commits.map(function(commit){return '<button type="button" class="gitlink-commit" data-hash="'+escapeHtml(commit.hash)+'" title="查看子模块提交 '+escapeHtml(commit.hash)+'"><span class="gitlink-commit-hash">'+escapeHtml(commit.shortHash||String(commit.hash||'').slice(0,7))+'</span><span class="gitlink-commit-message">'+escapeHtml(commit.message||commit.subject||'')+'</span></button>'}).join('')+'</div>';
}
function binaryBodyHtml(diff){
  const oldLabel=diff.status==='A'?'/dev/null':(diff.oldPath||diff.path),newLabel=diff.status==='D'?'/dev/null':diff.path;
  const unavailable='<div class="empty binary-empty">二进制文件不同，无法显示文本差异。</div>';
  return '<div class="binary-diff'+(renderSideBySide?'':' inline')+'"><section class="binary-pane"><span class="binary-pane-title">'+escapeHtml(oldLabel)+'</span>'+unavailable+'</section><section class="binary-pane binary-pane-right"><span class="binary-pane-title">'+escapeHtml(newLabel)+'</span>'+unavailable+'</section><section class="binary-unified-pane"><span class="binary-pane-title">'+escapeHtml(diff.path)+'</span>'+unavailable+'</section></div>';
}
function headerHtml(diff){const chevron='<svg class="diff-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 5.5 5 5 5-5"/></svg>';const kind=workingTreeKindHtml(diff.workingTreeKind);const stats='<span class="line-stats"><span class="line-stat-added"></span><span class="line-stat-removed"></span></span>';const gitlink=diff.isGitlink?gitlinkLabelHtml():'';const renamed=diff.status==='R'&&diff.oldPath&&diff.oldPath!==diff.path;const leftPath=renamed?diff.oldPath:diff.path;const left=chevron+gitlink+kind+stats+statusHtml(diff.status)+pathHtml(leftPath,diff.status==='D'||renamed);if(!renamed)return '<span class="title-side title-side-left">'+left+'</span>';return '<span class="title-side title-side-left">'+left+'</span><span class="title-side title-side-right">'+statusHtml(diff.status)+pathHtml(diff.path,false)+'</span>'}
// 对象 id 按 git 惯例截断到 7 位; 全 0 表示该侧不存在(新增或删除)。
function shortObjectId(id){const value=String(id==null?'':id);return value?value.slice(0,7):'0000000'}
// 标题栏下方的元信息: index <old>..<new> <mode>, 以及重命名的来源与目标。
function metaHtml(diff){
  // 沿用 git diff 头部的逐行格式: rename from / rename to / old mode / new mode / index。
  const lines=[];
  if(diff.oldPath&&diff.oldPath!==diff.path){
    lines.push('<span class="meta-line meta-rename-from" title="'+escapeHtml(diff.oldPath)+'">rename from '+escapeHtml(diff.oldPath)+'</span>');
    lines.push('<span class="meta-line meta-rename-to" title="'+escapeHtml(diff.path)+'">rename to '+escapeHtml(diff.path)+'</span>');
  }
  const oldId=shortObjectId(diff.oldObjectId),newId=shortObjectId(diff.newObjectId);
  if(diff.isGitlink){
    const oldCommit=diff.oldGitlinkCommit,newCommit=diff.newGitlinkCommit;
    if(diff.status!=='A')lines.push('<span class="meta-line meta-gitlink" title="'+escapeHtml(oldCommit?.hash||diff.oldObjectId||'')+'">Submodule commit '+escapeHtml(oldCommit?.shortHash||oldId)+(oldCommit?.subject?': '+escapeHtml(oldCommit.subject):'')+'</span>');
    if(diff.status!=='D')lines.push('<span class="meta-line meta-gitlink" title="'+escapeHtml(newCommit?.hash||diff.newObjectId||'')+'">Submodule commit '+escapeHtml(newCommit?.shortHash||newId)+(newCommit?.subject?': '+escapeHtml(newCommit.subject):'')+'</span>');
  }
  const mode=diff.newMode&&diff.newMode!=='000000'?diff.newMode:(diff.oldMode||'');
  const modeChanged=diff.oldMode&&diff.newMode&&diff.oldMode!==diff.newMode&&diff.oldMode!=='000000'&&diff.newMode!=='000000';
  if(modeChanged){
    lines.push('<span class="meta-line">old mode '+escapeHtml(diff.oldMode)+'</span>');
    lines.push('<span class="meta-line">new mode '+escapeHtml(diff.newMode)+'</span>');
  }
  const indexText='index '+oldId+'..'+newId+(mode?' '+mode:'');
  lines.push('<span class="meta-line meta-index" title="'+escapeHtml('旧对象 '+(diff.oldObjectId||'-')+' → 新对象 '+(diff.newObjectId||'-'))+'">'+escapeHtml(indexText)+'</span>');
  return lines.join('');
}
// 直接读 Monaco 已算好的行变更推导增删行数, 不额外跑 git 命令也不重复计算。
// endLineNumber===0 表示该侧无内容 (纯新增或纯删除)。
function updateLineStats(entry){
  if(!entry.editor)return;
  const changes=entry.editor.getLineChanges();
  if(!changes)return;
  let added=0,removed=0;
  for(const change of changes){
    if(change.originalEndLineNumber>0)removed+=change.originalEndLineNumber-change.originalStartLineNumber+1;
    if(change.modifiedEndLineNumber>0)added+=change.modifiedEndLineNumber-change.modifiedStartLineNumber+1;
  }
  const host=entry.header.querySelector('.line-stats');
  if(!host)return;
  host.querySelector('.line-stat-added').textContent='+'+added;
  host.querySelector('.line-stat-removed').textContent='-'+removed;
  host.classList.add('ready');
}
function estimateBodyHeight(diff){
  const originalLines=(diff.original||'').split('\\n').length,modifiedLines=(diff.modified||'').split('\\n').length;
  return Math.max(80,Math.max(originalLines,modifiedLines)*20+12);
}
// 先创建轻量逻辑项外壳，Monaco 模板只绑定可视范围，离屏后归还对象池。
function createEntry(diff,order){
  const key=diffKey(diff),loaded=diff.loaded===true;
  return {diff:diff,index:order,path:key,filePath:diff.path,card:null,header:null,meta:null,pinnedGroup:null,body:null,slot:null,editor:null,original:null,modified:null,modifiedValue:diff.modified||'',syncingModel:false,originalSelections:null,modifiedSelections:null,bodyHeight:loaded?estimateBodyHeight(diff):80,pinnedHeight:62,horizontalLeft:0,flashOverlay:null,flashTimer:0,collapsed:false,staticContent:!loaded,mounted:false,mounting:false,mountVersion:0,saveTimer:0,disposables:[],fit:function(){}};
}
function ensureVirtualRoot(){
  if(virtualRoot)return;
  virtualRoot=document.createElement('div');virtualRoot.className='multi-virtual-root';
  virtualTop=document.createElement('div');virtualTop.className='multi-virtual-spacer';
  virtualCardsHost=document.createElement('div');virtualCardsHost.className='multi-virtual-cards';
  virtualBottom=document.createElement('div');virtualBottom.className='multi-virtual-spacer';
  virtualRoot.append(virtualTop,virtualCardsHost,virtualBottom);
  list.replaceChildren(virtualRoot);
}
function entryHeight(entry){return (entry.collapsed?entry.pinnedHeight:entry.pinnedHeight+entry.bodyHeight)+14}
function rebuildLayoutMetrics(){
  layoutPrefix=new Array(cards.length+1);layoutPrefix[0]=0;
  for(let index=0;index<cards.length;index++)layoutPrefix[index+1]=layoutPrefix[index]+entryHeight(cards[index]);
  layoutTotal=layoutPrefix[cards.length]||0;layoutDirty=false;
}
function lowerBoundOffset(offset){
  let low=0,high=cards.length;
  while(low<high){const middle=(low+high)>>1;if(layoutPrefix[middle+1]>offset)high=middle;else low=middle+1}
  return Math.min(low,Math.max(0,cards.length-1));
}
function upperBoundOffset(offset){
  let low=0,high=cards.length;
  while(low<high){const middle=(low+high)>>1;if(layoutPrefix[middle]<offset)low=middle+1;else high=middle}
  return Math.min(low,cards.length);
}
function unmountCardShell(entry){
  if(!entry.card)return
  disposeEntry(entry);
  entry.card.remove();
  mountedCardEntries.delete(entry);
  entry.card=null;entry.header=null;entry.meta=null;entry.pinnedGroup=null;entry.body=null;
}

function mountCardShell(entry,parent){
  const diff=entry.diff,order=entry.index;
  const key=entry.path,card=document.createElement('section');card.className='diff';card.dataset.path=diff.path;card.dataset.diffKey=key;card.dataset.index=String(order);
  const pinnedGroup=document.createElement('div');pinnedGroup.className='pinned-group';
  // 独立标题层: 盖板与标题栏同高, 盖板位于标题内容下方但可跨出标题栏 8px 覆盖相邻卡片。
  const headerLayer=document.createElement('div');headerLayer.className='header-layer';
  const headerRow=document.createElement('div');headerRow.className='header-row';
  const header=document.createElement('button');header.type='button';header.className='file-header'+(diff.status==='R'&&diff.oldPath&&diff.oldPath!==diff.path?' rename-header':'');header.innerHTML=headerHtml(diff);
  const actions=document.createElement('div');actions.className='diff-actions';
  function actionButton(action,section,title,icon){const button=document.createElement('button');button.type='button';button.className='diff-action';button.dataset.action=action;button.dataset.section=section;button.title=title;button.setAttribute('aria-label',title);button.innerHTML='<span class="codicon codicon-'+icon+'" aria-hidden="true"></span>';return button}
  if(diff.workingTreeKind==='conflict')actions.append(actionButton('stage','conflict','暂存当前文件并标记冲突已解决','add'));
  else if(diff.workingTreeKind==='staged')actions.append(actionButton('unstage','staged','取消暂存当前文件（移回 Unstaged Changes）','remove'));
  else if(diff.workingTreeKind==='unstaged'||diff.workingTreeKind==='untracked')actions.append(actionButton('discard','unstaged','放弃当前文件的未暂存更改（不可撤销）','discard'),actionButton('stage','unstaged','暂存当前文件（移入 Staged Changes）','add'));
  const openFile=document.createElement('button');openFile.type='button';openFile.className='open-file';
  openFile.title='在编辑器中打开当前文件';openFile.setAttribute('aria-label','在编辑器中打开当前文件');
  openFile.innerHTML='<span class="codicon codicon-go-to-file" aria-hidden="true"></span>';
  actions.append(openFile);
  const body=document.createElement('div');body.className='diff-body';
  const loaded=diff.loaded===true;
  if(!loaded){body.className+=' diff-loading';body.textContent='正在读取 Diff…';}
  headerRow.append(header,actions);
  headerLayer.append(headerRow);
  const meta=document.createElement('div');meta.className='file-meta';meta.innerHTML=metaHtml(diff);
  pinnedGroup.append(headerLayer,meta);
  card.append(pinnedGroup,body);parent.append(card);
  entry.card=card;entry.header=header;entry.meta=meta;entry.pinnedGroup=pinnedGroup;entry.body=body;entry.staticContent=!loaded;
  card.classList.toggle('collapsed',entry.collapsed);card.classList.toggle('selected',entry.path===activePath);
  header.addEventListener('click',function(){toggle(entry)});
  card.addEventListener('pointerdown',function(){externalRevealPath='';cancelProgrammaticReveal();clickedPath=entry.path;setActive(entry.path,true)});
  actions.querySelectorAll('.diff-action').forEach(function(button){
    button.addEventListener('pointerdown',function(event){if(event.button!==0)return;event.preventDefault();event.stopPropagation()});
    button.addEventListener('pointerup',function(event){if(event.button!==0)return;event.preventDefault();event.stopPropagation();try{window.gitkVscode.postMessage({type:'workingTreeAction',action:button.dataset.action,section:button.dataset.section,path:diff.path})}catch(_){}});
  });
  // 标题栏右侧直接打开工作区文件, 不带行号定位。
  openFile.addEventListener('click',function(event){
    event.stopPropagation();
    try{window.gitkVscode.postMessage({type:'openFileAtLine',path:diff.path})}catch(_){}
  });
  // Gitlink 提交行使用事件委托，异步元数据刷新替换 innerHTML 后仍可点击跳转。
  body.addEventListener('click',function(event){
    const target=event.target instanceof Element?event.target.closest('.gitlink-commit[data-hash]'):null;
    if(!target||!body.contains(target))return;
    const hash=target.dataset.hash;if(!hash)return;
    event.stopPropagation();
    try{window.gitkVscode.postMessage({type:'selectGitlinkCommit',path:entry.filePath,hash:hash})}catch(_){}
  });
  mountedCardEntries.add(entry);
  if(!loaded){body.style.height=entry.bodyHeight+'px';return entry;}
  if(diff.isGitlink){
    body.style.height='';body.innerHTML=gitlinkBodyHtml(diff);entry.staticContent=true;
    return entry;
  }
  if(diff.error){
    const message=document.createElement('div');message.className='empty';message.textContent='无法读取此文件：'+diff.error;
    body.append(message);entry.staticContent=true;
    return entry;
  }
  if(diff.isBinary){body.style.height='';body.innerHTML=binaryBodyHtml(diff);entry.staticContent=true;return entry}
  body.style.height=entry.bodyHeight+'px';
  return entry;
}

function measureMountedCardShell(entry){
  if(!entry.card||!entry.pinnedGroup||!entry.body)return;
  const measuredPinnedHeight=entry.pinnedGroup.getBoundingClientRect().height;
  if(measuredPinnedHeight>0&&Math.abs(entry.pinnedHeight-measuredPinnedHeight)>.5){entry.pinnedHeight=measuredPinnedHeight;layoutDirty=true;if(externalRevealPath)scheduleExternalRevealAlignment()}
  if(entry.diff.loaded===true&&entry.staticContent){
    const measuredBodyHeight=Math.max(entry.body.scrollHeight,entry.body.getBoundingClientRect().height);
    if(measuredBodyHeight>0&&Math.abs(entry.bodyHeight-measuredBodyHeight)>.5){entry.bodyHeight=Math.max(80,Math.ceil(measuredBodyHeight));layoutDirty=true;if(externalRevealPath)scheduleExternalRevealAlignment()}
  }
  if(settledRevealAnchorPath)alignSettledRevealAnchor()
}
function flushDiffRequests(){
  diffRequestScheduled=false;
  if(!pendingPriorityDiffRequestPaths.size&&!pendingDiffRequestPaths.size)return;
  const priorityPaths=Array.from(pendingPriorityDiffRequestPaths);
  pendingPriorityDiffRequestPaths.clear();
  priorityPaths.forEach(function(path){pendingDiffRequestPaths.delete(path)});
  const paths=Array.from(pendingDiffRequestPaths);
  pendingDiffRequestPaths.clear();
  if(priorityPaths.length){
    try{window.gitkVscode.postMessage({type:'ensureDiffs',paths:priorityPaths,priority:true})}
    catch(_){priorityPaths.forEach(function(path){requestedDiffPaths.delete(path);prioritizedDiffPaths.delete(path)})}
  }
  if(paths.length){
    try{window.gitkVscode.postMessage({type:'ensureDiffs',paths:paths})}
    catch(_){paths.forEach(function(path){requestedDiffPaths.delete(path)})}
  }
}
function ensureDiffRequested(entry,priority=false){
  if(entry.diff.loaded===true)return;
  if(priority){
    if(prioritizedDiffPaths.has(entry.path))return;
    prioritizedDiffPaths.add(entry.path);requestedDiffPaths.add(entry.path);pendingPriorityDiffRequestPaths.add(entry.path);
  }else{
    if(requestedDiffPaths.has(entry.path))return;
    requestedDiffPaths.add(entry.path);pendingDiffRequestPaths.add(entry.path);
  }
  if(!diffRequestScheduled){diffRequestScheduled=true;queueMicrotask(flushDiffRequests)}
}
function hasMountedEditorContent(entry){
  return Boolean(entry.mounted&&entry.editor&&entry.slot&&entry.slot.owner===entry&&entry.body&&entry.body.contains(entry.slot.host))
}
// 为可视逻辑项借用 Monaco 模板；离屏后归还对象池并保留等高占位。
function mountEntry(entry,fromScroll=false){
  if(entry.staticContent||entry.collapsed)return Promise.resolve();
  if(hasMountedEditorContent(entry)||entry.mounting)return Promise.resolve();
  // mounted 标记与真实 host 脱节时先完整回收，再重新绑定，避免留下只有高度的空白卡片。
  if(entry.mounted||entry.editor||entry.slot)disposeEntry(entry);
  entry.mounting=true;mountedEntries.add(entry);entry.mountVersion++;
  const mountVersion=entry.mountVersion,diff=entry.diff;
  entry.body.style.height=Math.max(80,entry.bodyHeight||80)+'px';
  const slot=acquireSlot(entry),host=slot.host,editor=slot.editor;
  let original,modified;
  try{
    original=monaco.editor.createModel(diff.original||'',language(diff.path));
    modified=monaco.editor.createModel(entry.modifiedValue,language(diff.path));
    // changes 模式右侧即工作区文件, 允许编辑; 其余模式(commit/staged)保持只读。
    const entryEditable=diff.editable===true;
    editor.updateOptions(Object.assign({},diffOptions,{readOnly:!entryEditable,renderSideBySide:renderSideBySide}));
    editor.setModel({original:original,modified:modified});
    const originalEditor=editor.getOriginalEditor(),modifiedEditor=editor.getModifiedEditor();
    originalEditor.setScrollLeft(entry.horizontalLeft||0);modifiedEditor.setScrollLeft(entry.horizontalLeft||0);
    if(entry.originalSelections)originalEditor.setSelections(entry.originalSelections);
    if(entry.modifiedSelections)modifiedEditor.setSelections(entry.modifiedSelections);
    function syncHorizontalFromEditor(source){
      if(syncingGlobalHScroll)return;
      entry.horizontalLeft=source.getScrollLeft();
      const other=source===originalEditor?modifiedEditor:originalEditor;
      syncingGlobalHScroll=true;other.setScrollLeft(entry.horizontalLeft);syncingGlobalHScroll=false;
      if(entry.path===activePath)updateGlobalHScroll();
    }
    entry.disposables.push(originalEditor.onDidScrollChange(function(event){if(event.scrollLeftChanged)syncHorizontalFromEditor(originalEditor)}));
    entry.disposables.push(modifiedEditor.onDidScrollChange(function(event){if(event.scrollLeftChanged)syncHorizontalFromEditor(modifiedEditor)}));
    if(entryEditable){
      // 仅工作区一侧允许编辑回写，Staged 卡片保持只读。
      entry.disposables.push(modified.onDidChangeContent(function(){
        if(entry.syncingModel)return;
        entry.modifiedValue=modified.getValue();
        if(entry.saveTimer)clearTimeout(entry.saveTimer);
        entry.saveTimer=setTimeout(function(){
          entry.saveTimer=0;
          try{window.gitkVscode.postMessage({type:'saveFile',path:diff.path,content:entry.modifiedValue})}catch(_){}
        },400);
      }));
    }
    // 折叠未改动区域的图标用 glyphMarginClassName 渲染, DiffEditor 默认只给左侧开 glyphMargin,
    // 右侧那一列让给了 renderIndicators, 故右侧看不到该图标; 这里单独为右侧开启。
    editor.getModifiedEditor().updateOptions({glyphMargin:true});
    function bindOpenFileGesture(side, targetEditor, targetPath) {
      let linkDecorations = [];
      entry.disposables.push(targetEditor.onMouseMove(function(event){
        const mouse=event.event;
        const position=event.target&&event.target.position;
        const model=targetEditor.getModel();
        const word=position&&model?model.getWordAtPosition(position):null;
        const active=Boolean(word && (mouse.ctrlKey || mouse.metaKey));
        if (model) {
          linkDecorations = model.deltaDecorations(linkDecorations, active ? [{
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            options: {inlineClassName: 'gitk-diff-link-hover'},
          }] : []);
        }
      }));
      entry.disposables.push(targetEditor.onMouseLeave(function(){
        const model=targetEditor.getModel();
        if (model) { linkDecorations = model.deltaDecorations(linkDecorations, []); }
      }));
      entry.disposables.push(targetEditor.onMouseDown(function(event){
        const mouse=event.event;
        if(mouse.leftButton!==true&&mouse.button!==0)return;
        if(!mouse.ctrlKey&&!mouse.metaKey)return;
        const position=event.target&&event.target.position;
        const model=targetEditor.getModel();
        const word=position&&model?model.getWordAtPosition(position):null;
        if(!position||!word)return;
        mouse.preventDefault&&mouse.preventDefault();
        try{window.gitkVscode.postMessage({type:'openFileAtLine',path:targetPath,line:position.lineNumber,column:word.startColumn,side:side})}catch(_){}
      }));
    }
    // Ctrl/Cmd + hover/左键支持 Diff 两侧跳转, 路径按 Diff 文件的对应版本选择。
    bindOpenFileGesture('original', editor.getOriginalEditor(), diff.oldPath || diff.path);
    bindOpenFileGesture('modified', editor.getModifiedEditor(), diff.path);
  }catch(error){
    // 创建阶段就失败: 回收已建资源并让调用方就地降级。
    try{editor.setModel(null)}catch(_){}
    releaseSlot(slot);
    if(original){try{original.dispose()}catch(_){}}
    if(modified){try{modified.dispose()}catch(_){}}
    entry.mounting=false;
    return Promise.reject(error);
  }
  let fitting=false,fitFrame=0;
  const scheduleFit=function(){
    if(fitFrame||entry.mountVersion!==mountVersion)return;
    fitFrame=requestAnimationFrame(function(){fitFrame=0;fit()});
  };
  const fit=function(){
    if(fitting||entry.collapsed||entry.mountVersion!==mountVersion)return;
    fitting=true;
    try{
      const left=editor.getOriginalEditor(),right=editor.getModifiedEditor();
      const width=Math.ceil(host.clientWidth||Math.max(0,window.innerWidth-18));
      const currentHeight=Math.max(80,entry.bodyHeight||80);
      // 先用当前卡片尺寸完成一次真实 layout，再读取 Monaco 内容高度；复用 host 或首次挂载时缓存值可能已过期。
      entry.body.style.height=currentHeight+'px';host.style.height=currentHeight+'px';
      editor.layout({width:width,height:currentHeight});
      const nextHeight=Math.ceil(Math.max(80,left.getContentHeight(),right.getContentHeight()));
      const delta=nextHeight-entry.bodyHeight;
      const heightChanged=Math.abs(delta)>.5;
      const viewportAnchor=heightChanged?captureViewportAnchorForEntry(entry):null;
      entry.bodyHeight=nextHeight;entry.body.style.height=nextHeight+'px';host.style.height=nextHeight+'px';
      editor.layout({width:width,height:nextHeight});
      if(entry.path===activePath)updateGlobalHScroll();
      if(!heightChanged)return;
      layoutDirty=true;
      if(programmaticRevealPath)scheduleProgrammaticReveal();else if(externalRevealPath)scheduleExternalRevealAlignment();
      // 高度变化发生在目标或当前视口上方时，同一轮布局内恢复锚点，不能等下一帧再补偿。
      if(settledRevealAnchorPath)alignSettledRevealAnchor();
      else if(pinnedAnchor)applyPinnedAnchor();
      else restoreViewportAnchor(viewportAnchor);
      scheduleVirtualization();
      // 第二次 layout 可能改变折行/对齐区高度；下一帧再收敛一次，避免只显示部分新增、删除或修改内容。
      scheduleFit();
    }finally{fitting=false}
  };
  entry.disposables.push(editor.onDidUpdateDiff(function(){fit();updateLineStats(entry)}));
  entry.disposables.push(editor.getOriginalEditor().onDidContentSizeChange(fit));
  entry.disposables.push(editor.getModifiedEditor().onDidContentSizeChange(fit));
  entry.slot=slot;entry.editor=editor;entry.original=original;entry.modified=modified;entry.fit=fit;entry.mounted=true;entry.mounting=false;
  // 不依赖 Monaco 事件是否恰好在监听器注册前触发；挂载后的连续两帧主动校准真实内容高度。
  scheduleFit();requestAnimationFrame(scheduleFit);
  if(entry.path===activePath)updateGlobalHScroll();
  // 纯事件驱动：onDidUpdateDiff 到达即就绪；若挂监听前差异已算完，
  // getLineChanges() 已非 null，直接就绪，避免错过事件而永久等待。
  return new Promise(function(resolve,reject){
    let settled=false;
    const listener=editor.onDidUpdateDiff(function(){finish()});
    function finish(){
      if(settled)return;
      settled=true;
      try{listener.dispose()}catch(_){}
      if(entry.mountVersion===mountVersion){entry.mounting=false;fit();updateLineStats(entry)}
      resolve();
    }
    try{
      if(editor.getLineChanges()!==null){finish();return}
    }catch(error){
      settled=true;
      try{listener.dispose()}catch(_){}
      reject(error);
      return;
    }
  });
}
// 单张卡片失败不影响其余卡片：就地显示异常信息并让该卡片视为已就绪。
function markCardFailed(entry,error){
  mountedEntries.delete(entry);
  const message=error&&error.message||String(error);
  if(entry.editor){
    for(const disposable of entry.disposables||[]){try{disposable.dispose()}catch(_){} }
    entry.disposables=[];
    if(entry.slot)releaseSlot(entry.slot);
    try{entry.original.dispose()}catch(_){}
    try{entry.modified.dispose()}catch(_){}
    entry.slot=null;entry.editor=null;entry.original=null;entry.modified=null;entry.mounted=false;entry.mounting=false;entry.staticContent=true;entry.fit=function(){};
  }
  const notice=document.createElement('div');notice.className='empty';
  notice.textContent='此文件差异渲染失败：'+message;
  if(entry.body){entry.body.replaceChildren(notice);entry.body.style.height=Math.max(80,entry.bodyHeight||80)+'px'}
  entry.bodyHeight=Math.max(80,entry.bodyHeight||80);layoutDirty=true;if(settledRevealAnchorPath)scheduleSettledRevealAlignment();
  report('card '+entry.path+' failed: '+message);
}
function toggle(entry){
  externalRevealPath='';
  entry.collapsed=!entry.collapsed;
  entry.card.classList.toggle('collapsed',entry.collapsed);
  if(entry.collapsed)disposeEntry(entry);else scheduleVirtualization();
  setActive(entry.path,true);updateGlobalHScroll();
}
function setActive(path,notify){
  // Changed Files 发起定位后，残余滚动/刷新不得把活动项切回其他文件；用户主动操作会先解除该锁。
  if(notify&&externalRevealPath&&path!==externalRevealPath)return;
  const changed=activePath!==path;
  activePath=path;
  if(!changed){
    // 虚拟窗口重建时 mountCardShell 已按 activePath 恢复 class；这里只兜底补回当前卡片，避免每个 scroll 帧遍历全部卡片。
    const current=cardByPath.get(path);if(current&&current.card)current.card.classList.add('selected');
    return
  }
  // 只处理当前挂载的 Monaco；大量文件时遍历全部逻辑卡片会拖慢滚动高亮切换。
  for(const entry of mountedEntries){
    if(entry.path===path||!entry.editor)continue;
    try{entry.editor.getOriginalEditor().blur();entry.editor.getModifiedEditor().blur()}catch(_){ }
  }
  activeChangeIndex=-1;activeChangePage=0;
  for(const entry of mountedCardEntries)entry.card.classList.toggle('selected',entry.path===path);
  if(notify){try{window.gitkVscode.postMessage({type:'selectFile',path:path,selectionEpoch:selectionEpoch})}catch(_){}}
  updateGlobalHScroll();
}
// 固定 SCROLL_DURATION 完成短距离滚动；跨越很多卡片时直接定位，避免沿途虚拟窗口快速换页。
function animateScrollTo(top,onComplete){
  if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}
  const start=window.scrollY,distance=top-start;
  if(Math.abs(distance)<1){window.scrollTo({top:top,behavior:'auto'});if(onComplete)onComplete();return}
  const startTime=performance.now();
  const step=function(now){
    const progress=Math.min(1,(now-startTime)/SCROLL_DURATION);
    const eased=progress<.5?2*progress*progress:1-Math.pow(-2*progress+2,2)/2;
    window.scrollTo({top:start+distance*eased,behavior:'auto'});
    if(progress<1)scrollAnimationFrame=requestAnimationFrame(step);
    else{scrollAnimationFrame=0;if(onComplete)onComplete()}
  };
  scrollAnimationFrame=requestAnimationFrame(step);
}
function revealScrollTop(entry){
  if(layoutDirty)rebuildLayoutMetrics();
  const listTop=list.getBoundingClientRect().top+window.scrollY;
  const stickyTop=entry.pinnedGroup?parseFloat(getComputedStyle(entry.pinnedGroup).top)||0:0;
  return Math.max(0,listTop+8+layoutPrefix[entry.index]-stickyTop)
}
function revealTailHeight(){
  const entry=revealTailPath&&cardByPath.get(revealTailPath);
  if(!entry)return 0;
  if(layoutDirty)rebuildLayoutMetrics();
  // 最后几张卡片后方也要保留一个视口的可滚动余量，否则浏览器最大 scrollY 会让目标只能停在面板中部。
  return Math.max(0,window.innerHeight-(layoutTotal-layoutPrefix[entry.index]))
}
function revealAlignmentDelta(entry){
  // 卡片外壳挂载后以真实 DOM 顶部为准；overscan 中前置卡片的真实高度可能与逻辑估值不同。
  if(entry.card&&mountedCardEntries.has(entry)){
    const stickyTop=entry.pinnedGroup?parseFloat(getComputedStyle(entry.pinnedGroup).top)||0:0;
    return entry.card.getBoundingClientRect().top-stickyTop
  }
  return revealScrollTop(entry)-window.scrollY
}
function clearVirtualJumpAnchor(){
  if(virtualJumpAnchorFrame){cancelAnimationFrame(virtualJumpAnchorFrame);virtualJumpAnchorFrame=0}
  document.documentElement.classList.remove('programmatic-reveal')
}
function beginVirtualJumpAnchor(){
  clearVirtualJumpAnchor();document.documentElement.classList.add('programmatic-reveal');
  // 只在替换虚拟窗口的当前帧关闭原生锚定；下一帧恢复，后续高度变化由 settled reveal anchor 精确补偿。
  virtualJumpAnchorFrame=requestAnimationFrame(function(){virtualJumpAnchorFrame=0;document.documentElement.classList.remove('programmatic-reveal')})
}
function clearSettledRevealAnchor(){
  if(settledRevealAlignFrame){cancelAnimationFrame(settledRevealAlignFrame);settledRevealAlignFrame=0}
  if(settledRevealObserver){settledRevealObserver.disconnect();settledRevealObserver=null}
  settledRevealAnchorPath='';document.documentElement.classList.remove('settled-reveal-anchor')
}
function alignSettledRevealAnchor(){
  settledRevealAlignFrame=0;
  const anchor=settledRevealAnchorPath&&cardByPath.get(settledRevealAnchorPath);
  if(!anchor||!anchor.card||!mountedCardEntries.has(anchor))return;
  const stickyTop=anchor.pinnedGroup?parseFloat(getComputedStyle(anchor.pinnedGroup).top)||0:0;
  const delta=anchor.card.getBoundingClientRect().top-stickyTop;
  if(Math.abs(delta)>.5){window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});suppressSyncUntil=performance.now()+120}
}
function scheduleSettledRevealAlignment(){
  if(!settledRevealAnchorPath||settledRevealAlignFrame)return;
  settledRevealAlignFrame=requestAnimationFrame(alignSettledRevealAnchor)
}
function setSettledRevealAnchor(path){
  clearSettledRevealAnchor();settledRevealAnchorPath=path||'';
  if(!settledRevealAnchorPath)return;
  document.documentElement.classList.add('settled-reveal-anchor');
  // ResizeObserver 在绘制前收到前置缓存卡片/顶部 spacer 的高度变化，直接维持目标卡片的视觉顶部。
  if('ResizeObserver' in window){
    settledRevealObserver=new ResizeObserver(function(){alignSettledRevealAnchor()});
    if(virtualTop)settledRevealObserver.observe(virtualTop);
    if(virtualCardsHost)settledRevealObserver.observe(virtualCardsHost);
    settledRevealObserver.observe(parentCommitNavigation)
  }
  alignSettledRevealAnchor()
}

function cancelProgrammaticReveal(){
  clearVirtualJumpAnchor();clearSettledRevealAnchor();
  if(programmaticRevealFrame){cancelAnimationFrame(programmaticRevealFrame);programmaticRevealFrame=0}
  if(programmaticRevealTimer){clearTimeout(programmaticRevealTimer);programmaticRevealTimer=0}
  programmaticRevealPath='';programmaticRevealStableFrames=0;programmaticRevealTargetReady=false;clickedPath='';
  if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}
}
function enforceRevealTarget(entry){
  if(!entry)return;
  setActive(entry.path,false);
  // 大跨度虚拟窗口替换后强制保证只有目标卡片带 selected，不能只依赖挂载瞬间的 activePath 快照。
  for(const mounted of mountedCardEntries)mounted.card.classList.toggle('selected',mounted===entry);
  if(entry.card)entry.card.classList.add('selected')
}
function alignRevealTarget(entry){
  if(!entry)return;
  enforceRevealTarget(entry);
  const delta=revealAlignmentDelta(entry);
  if(Math.abs(delta)>.5)window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});
}
function finishProgrammaticReveal(entry){
  if(programmaticRevealFrame){cancelAnimationFrame(programmaticRevealFrame);programmaticRevealFrame=0}
  if(programmaticRevealTimer){clearTimeout(programmaticRevealTimer);programmaticRevealTimer=0}
  if(externalRevealFrame){cancelAnimationFrame(externalRevealFrame);externalRevealFrame=0}
  if(entry){alignRevealTarget(entry);clickedPath=entry.path}
  programmaticRevealPath='';programmaticRevealStableFrames=0;programmaticRevealTargetReady=false;externalRevealPath='';
  if(entry)setSettledRevealAnchor(entry.path);else clearSettledRevealAnchor();
  suppressSyncUntil=performance.now()+120;
  // 目标置顶后补齐可视区与前后缓存；后续高度变化由稳定锚点原位补偿。
  if(entry)updateVirtualizationAtIndex(entry.index,false,false);else scheduleVirtualization()
}
function scheduleExternalRevealAlignment(){
  if(!externalRevealPath||programmaticRevealPath||externalRevealFrame)return;
  externalRevealFrame=requestAnimationFrame(function(){
    externalRevealFrame=0;
    if(!externalRevealPath||programmaticRevealPath)return;
    const entry=cardByPath.get(externalRevealPath);if(!entry)return;
    updateVirtualizationAtIndex(entry.index,true,true);alignRevealTarget(entry);suppressSyncUntil=performance.now()+120
  })
}
function scheduleProgrammaticReveal(){
  if(!programmaticRevealPath||programmaticRevealFrame)return;
  programmaticRevealFrame=requestAnimationFrame(settleProgrammaticReveal)
}
function settleProgrammaticReveal(){
  programmaticRevealFrame=0;
  const entry=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);
  if(!entry){cancelProgrammaticReveal();return}
  let targetReady=entry.diff.loaded===true&&(entry.staticContent||hasMountedEditorContent(entry));
  if(targetReady&&!programmaticRevealTargetReady){programmaticRevealTargetReady=true;programmaticRevealStableFrames=0}
  // 跳转阶段只允许目标卡片参与挂载和定位；前后缓存等目标置顶后再补齐，避免高度变化反复拉扯 scrollY。
  updateVirtualizationAtIndex(entry.index,true,true);
  enforceRevealTarget(entry);
  targetReady=entry.diff.loaded===true&&(entry.staticContent||hasMountedEditorContent(entry));
  const delta=revealAlignmentDelta(entry);
  if(Math.abs(delta)>.5){window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});programmaticRevealStableFrames=0}
  else if(targetReady)programmaticRevealStableFrames++;
  if(targetReady&&programmaticRevealStableFrames>=2){finishProgrammaticReveal(entry);return}
  // 等待目标 Diff 数据或 Monaco 首次布局；不再等待前后 overscan 卡片。
  if(!targetReady||programmaticRevealStableFrames<2)scheduleProgrammaticReveal();
}
function resolveRevealEntry(path){
  if(!path)return undefined;
  return cardByPath.get(path)||cards.find(function(entry){return entry.filePath===path})
}
function reveal(path,smooth){
  const entry=resolveRevealEntry(path);
  if(!entry){pendingRevealPath=path||'';return false}
  if(externalRevealFrame){cancelAnimationFrame(externalRevealFrame);externalRevealFrame=0}
  clearSettledRevealAnchor();pendingRevealPath='';
  if(entry.collapsed){entry.collapsed=false;layoutDirty=true}
  const targetPath=entry.path;
  // 外部选择保持为唯一高亮目标，直到用户主动在 MultiDiff 中进行滚动、点击或差异导航。
  externalRevealPath=targetPath;
  pinnedAnchor=null;clickedPath=targetPath;programmaticRevealPath=targetPath;programmaticRevealStableFrames=0;programmaticRevealTargetReady=false;revealTailPath=targetPath;
  if(programmaticRevealTimer)clearTimeout(programmaticRevealTimer);
  programmaticRevealTimer=setTimeout(function(){const target=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);finishProgrammaticReveal(target)},5000);
  suppressSyncUntil=performance.now()+SCROLL_DURATION+120;
  const targetWasVisible=isCardVisible(entry);
  let top=revealScrollTop(entry),distance=Math.abs(top-window.scrollY);
  // 目标只要超出当前可视范围就直接定位；仅对已经可见的局部对齐使用短动画。
  const useAnimation=smooth&&targetWasVisible&&distance<=Math.max(1200,window.innerHeight*2);
  setActive(targetPath,false);
  if(useAnimation)animateScrollTo(top,function(){scheduleVirtualization();scheduleProgrammaticReveal()});
  else{
    if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}
    // 远距离定位先直接把目标附近的虚拟窗口挂载出来，再按真实标题栏位置计算滚动目标。
    // 仅在替换 DOM 的这一帧关闭浏览器锚定，防止旧窗口把 scrollY 拉回；后续异步高度变化继续使用原生锚定。
    beginVirtualJumpAnchor();updateVirtualizationAtIndex(entry.index,true,true);
    enforceRevealTarget(entry);
    top=revealScrollTop(entry);
    window.scrollTo({top:top,behavior:'auto'});
    scheduleProgrammaticReveal();
  }
  if(useAnimation)scheduleVirtualization();return true;
}
function viewportContentTop(){return parentCommitNavigation.hidden?0:parentCommitNavigation.getBoundingClientRect().height}
function isCardVisible(entry){
  if(layoutDirty)rebuildLayoutMetrics();
  const listTop=list.getBoundingClientRect().top+window.scrollY+8;
  const top=listTop+layoutPrefix[entry.index]-window.scrollY;
  const viewportTop=viewportContentTop();
  return top+entryHeight(entry)>viewportTop&&top<window.innerHeight;
}
function currentViewportOffset(){
  const listTop=list.getBoundingClientRect().top+window.scrollY+8;
  return Math.max(0,window.scrollY+viewportContentTop()-listTop);
}
function topVisibleCard(){
  if(!cards.length)return undefined;
  if(layoutDirty)rebuildLayoutMetrics();
  return cards[lowerBoundOffset(currentViewportOffset())];
}
function syncActiveFromViewport(){
  if(programmaticRevealPath||scrollAnimationFrame||performance.now()<suppressSyncUntil)return;
  const clickedEntry=clickedPath&&cardByPath.get(clickedPath);
  if(clickedEntry&&isCardVisible(clickedEntry))return;
  clickedPath='';
  const entry=topVisibleCard();
  if(entry&&entry.path!==activePath)setActive(entry.path,true)
}
function captureViewportAnchor(){
  if(programmaticRevealPath||settledRevealAnchorPath||scrollAnimationFrame||!virtualCardsHost)return null;
  const viewportTop=viewportContentTop();
  for(const card of virtualCardsHost.children){
    const rect=card.getBoundingClientRect();
    if(rect.bottom>viewportTop){return {key:card.dataset.diffKey,top:rect.top}}
  }
  return null
}
function captureViewportAnchorForEntry(entry){
  if(!entry||!entry.card||entry.card.getBoundingClientRect().bottom>viewportContentTop())return null;
  return captureViewportAnchor()
}
function restoreViewportAnchor(anchor){
  if(!anchor)return;
  const entry=anchor.key&&cardByPath.get(anchor.key);
  if(!entry||!entry.card||!mountedCardEntries.has(entry))return;
  const delta=entry.card.getBoundingClientRect().top-anchor.top;
  if(Math.abs(delta)>.5){window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});suppressSyncUntil=performance.now()+80}
}
function updateVirtualLayout(start,end,rebuildCards){
  ensureVirtualRoot();
  if(layoutDirty)rebuildLayoutMetrics();
  const topHeight=Math.max(0,layoutPrefix[start]||0)+'px';
  const bottomHeight=(Math.max(0,layoutTotal-(layoutPrefix[end+1]||0))+revealTailHeight())+'px';
  const viewportAnchor=(rebuildCards||virtualTop.style.height!==topHeight||virtualBottom.style.height!==bottomHeight)?captureViewportAnchor():null;
  virtualTop.style.height=topHeight;
  virtualBottom.style.height=bottomHeight;
  // 视口仍位于同一个虚拟窗口时只更新占位高度，不再 replaceChildren；后者会让全部卡片反复脱离/进入 DOM。
  if(!rebuildCards){restoreViewportAnchor(viewportAnchor);return}
  const fragment=document.createDocumentFragment();
  for(let index=start;index<=end;index++){
    const entry=cards[index];
    // 新卡片先在离屏 Fragment 中批量构造，避免每张卡片 append 后立刻读取布局造成强制回流。
    if(!entry.card)mountCardShell(entry,fragment);
    else fragment.appendChild(entry.card);
  }
  virtualCardsHost.replaceChildren(fragment);
  // DOM 写入全部完成后再统一测量；连续读取共享同一次布局计算。
  for(let index=start;index<=end;index++)measureMountedCardShell(cards[index]);
  restoreViewportAnchor(viewportAnchor);
}
function resetEditorMountQueue(){
  if(editorMountFrame){cancelAnimationFrame(editorMountFrame);editorMountFrame=0}
  editorMountQueue=[];queuedEditorMounts.clear();
}
function flushEditorMountQueue(){
  editorMountFrame=0;
  let mounted=0;
  while(editorMountQueue.length&&mounted<MAX_EDITOR_MOUNTS_PER_FRAME){
    const task=editorMountQueue.shift(),entry=task.entry;
    if(!queuedEditorMounts.delete(entry)||!mountedCardEntries.has(entry)||!entry.card||entry.collapsed||entry.staticContent||hasMountedEditorContent(entry)||entry.mounting)continue;
    mounted++;
    mountEntry(entry,task.fromScroll).catch(function(error){markCardFailed(entry,error)});
  }
  if(editorMountQueue.length)editorMountFrame=requestAnimationFrame(flushEditorMountQueue);
}
function queueEditorMount(entry,fromScroll){
  if(queuedEditorMounts.has(entry)||entry.staticContent||hasMountedEditorContent(entry)||entry.mounting)return;
  queuedEditorMounts.add(entry);editorMountQueue.push({entry:entry,fromScroll:fromScroll});
  if(!editorMountFrame)editorMountFrame=requestAnimationFrame(flushEditorMountQueue);
}
function applyVirtualWindow(first,last,fromScroll,priorityIndex=-1,priorityOnly=false){
  const mountFirst=Math.max(0,first-EDITOR_OVERSCAN_CARDS);
  const mountLast=Math.min(cards.length-1,last+EDITOR_OVERSCAN_CARDS);
  const firstMounted=virtualCardsHost&&virtualCardsHost.firstElementChild;
  const lastMounted=virtualCardsHost&&virtualCardsHost.lastElementChild;
  const rebuildCards=mountFirst!==virtualWindowStart||mountLast!==virtualWindowEnd
    ||!firstMounted||!lastMounted
    ||firstMounted.dataset.diffKey!==cards[mountFirst].path
    ||lastMounted.dataset.diffKey!==cards[mountLast].path;
  virtualWindowStart=mountFirst;virtualWindowEnd=mountLast;
  if(rebuildCards){
    // 只保留最新视口的待挂载任务；快速跨文件滚动时旧队列不能挡在新卡片前面。
    resetEditorMountQueue();
    Array.from(mountedCardEntries).forEach(function(entry){
      if(entry.index<mountFirst||entry.index>mountLast)unmountCardShell(entry);
    });
  }
  updateVirtualLayout(mountFirst,mountLast,rebuildCards);
  const mounts=[];
  const bind=function(index,priority,visible){
    const entry=cards[index];
    if(entry.collapsed)return;
    if(entry.diff.loaded!==true)ensureDiffRequested(entry,priority);
    else if(!entry.staticContent&&!hasMountedEditorContent(entry)&&!entry.mounting){
      // 只有点击目标立即绑定；其余可视卡片和 overscan 都分帧创建，避免首次打开或滚动时一帧创建十几个 Monaco。
      if(priority)mounts.push(mountEntry(entry,fromScroll).catch(function(error){markCardFailed(entry,error)}));
      else queueEditorMount(entry,fromScroll);
    }
  };
  const hasPriority=priorityIndex>=mountFirst&&priorityIndex<=mountLast;
  if(hasPriority)bind(priorityIndex,true,priorityIndex>=first&&priorityIndex<=last);
  if(!priorityOnly){
    // 可视卡片优先，其次按距离加入前后缓存，避免 overscan 抢在屏幕内容之前创建编辑器。
    for(let index=first;index<=last;index++)if(!hasPriority||index!==priorityIndex)bind(index,false,true);
    for(let index=first-1;index>=mountFirst;index--)if(!hasPriority||index!==priorityIndex)bind(index,false,false);
    for(let index=last+1;index<=mountLast;index++)if(!hasPriority||index!==priorityIndex)bind(index,false,false);
  }
  if(mounts.length)Promise.all(mounts);
  if(layoutDirty)scheduleVirtualization();
}
function updateVirtualizationAtIndex(index,fromScroll=false,priorityOnly=false){
  if(!cards.length)return;
  if(layoutDirty)rebuildLayoutMetrics();
  const first=Math.max(0,Math.min(index,cards.length-1));
  const lastExclusive=Math.max(first+1,upperBoundOffset(layoutPrefix[first]+window.innerHeight));
  const last=Math.min(cards.length-1,Math.max(first,lastExclusive-1));
  applyVirtualWindow(first,last,fromScroll,first,priorityOnly);
}
function updateVirtualization(fromScroll=false){
  if(!cards.length)return;
  if(layoutDirty)rebuildLayoutMetrics();
  const offset=currentViewportOffset();
  const first=lowerBoundOffset(offset);
  const lastExclusive=Math.max(first+1,upperBoundOffset(offset+window.innerHeight));
  const last=Math.min(cards.length-1,Math.max(first,lastExclusive-1));
  const priority=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);
  applyVirtualWindow(first,last,fromScroll,priority?priority.index:-1,false);
}
function scheduleVirtualization(){if(virtualFrame)return;virtualFrame=requestAnimationFrame(function(){
  virtualFrame=0;
  const target=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);
  const settled=settledRevealAnchorPath&&cardByPath.get(settledRevealAnchorPath);
  if(target)updateVirtualizationAtIndex(target.index,false,!programmaticRevealTargetReady||programmaticRevealStableFrames<1);
  else if(settled)updateVirtualizationAtIndex(settled.index,false,false);
  else updateVirtualization();
})}
let scrollFrame=0;
// 用户主动操作时立即接管，避免程序化定位锁与滚轮/触控/滚动条操作相互争抢。
function beginUserMultiDiffInteraction(){
  externalRevealPath='';
  if(externalRevealFrame){cancelAnimationFrame(externalRevealFrame);externalRevealFrame=0}
  cancelProgrammaticReveal()
}
window.addEventListener('pointerdown',beginUserMultiDiffInteraction,{passive:true,capture:true});
window.addEventListener('wheel',beginUserMultiDiffInteraction,{passive:true});
window.addEventListener('touchstart',beginUserMultiDiffInteraction,{passive:true});
window.addEventListener('keydown',function(event){if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))beginUserMultiDiffInteraction()});
window.addEventListener('scroll',function(){
  // 用户主动滚动即放弃刷新锚点；锚点自身的对齐写入不算用户滚动。
  if(pinnedAnchor){if(pinnedAnchor.selfScroll)pinnedAnchor.selfScroll=false;else pinnedAnchor=null}
  if(scrollFrame)return;scrollFrame=requestAnimationFrame(function(){
    scrollFrame=0;
    // 程序化动画结束后不再长期锁住原点击卡片；用户继续滚动时立即按横栏下方的顶部卡片切换高亮。
    if(!programmaticRevealPath&&!scrollAnimationFrame&&performance.now()>=suppressSyncUntil)clickedPath='';
    syncActiveFromViewport();
    const target=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);
    const settled=settledRevealAnchorPath&&cardByPath.get(settledRevealAnchorPath);
    if(target)updateVirtualizationAtIndex(target.index,true,true);
    else if(settled)updateVirtualizationAtIndex(settled.index,true,false);
    else updateVirtualization(true)
  })
},{passive:true});
globalHScroll.addEventListener('scroll',function(){
  if(syncingGlobalHScroll)return;
  const entry=activeEntry();if(!entry||!entry.mounted||!entry.editor)return;
  entry.horizontalLeft=globalHScroll.scrollLeft;
  syncingGlobalHScroll=true;entry.editor.getOriginalEditor().setScrollLeft(entry.horizontalLeft);entry.editor.getModifiedEditor().setScrollLeft(entry.horizontalLeft);syncingGlobalHScroll=false;
},{passive:true});
window.addEventListener('resize',function(){scheduleVirtualization();updateGlobalHScroll()});
// 同一提交刷新前记录选中卡片及其相对视口位置，key 变化时按真实文件路径映射。
function refreshState(){
  const selected=activeEntry();
  if(!selected)return null;
  return {key:selected.path,filePath:selected.filePath,index:selected.index,offset:selected.card?selected.card.getBoundingClientRect().top:undefined}
}
function applyPinnedAnchor(){
  if(!pinnedAnchor)return;
  const entry=cardByPath.get(pinnedAnchor.key);
  if(!entry){pinnedAnchor=null;return}
  if(!entry.card)return;
  const delta=entry.card.getBoundingClientRect().top-pinnedAnchor.offset;
  if(Math.abs(delta)<.5)return;
  pinnedAnchor.selfScroll=true;
  window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});
}
function restoreRefreshState(state,revealPath){
  const requested=resolveRevealEntry(revealPath);
  const kept=state&&(cardByPath.get(state.key)||cards.find(function(item){return item.filePath===state.filePath}));
  // 快照中的有效选择是权威目标；只有它不存在时才回退到刷新前活动卡片。
  const entry=requested||kept||(state&&cards[Math.min(state.index,cards.length-1)]);
  if(!entry)return false;
  if(kept&&entry===kept&&typeof state.offset==='number'){pinnedAnchor={key:entry.path,offset:state.offset};applyPinnedAnchor()}
  clickedPath=entry.path;
  setActive(entry.path,!requested&&entry.path!==revealPath);
  return true
}
function updateEntryFromSnapshot(entry,diff){
  const viewportAnchor=captureViewportAnchorForEntry(entry);
  try{
    const old=entry.diff;
    const wasLoaded=entry.diff.loaded===true,isLoaded=diff.loaded===true;
    entry.diff=diff;entry.filePath=diff.path;entry.modifiedValue=diff.modified||entry.modifiedValue;
    if(isLoaded){requestedDiffPaths.delete(entry.path);prioritizedDiffPaths.delete(entry.path)}
    if(!isLoaded)entry.bodyHeight=80;
    if(!wasLoaded&&isLoaded&&!diff.isGitlink&&!diff.error&&!diff.isBinary)entry.bodyHeight=estimateBodyHeight(diff);
    const wasStatic=old.isGitlink||old.error||old.isBinary;
    const isStatic=diff.isGitlink||diff.error||diff.isBinary;
    entry.staticContent=!isLoaded||isStatic;
    layoutDirty=true;
    if(!entry.card)return;
    entry.card.dataset.path=diff.path;entry.card.dataset.diffKey=entry.path;
    entry.header.className='file-header'+(diff.status==='R'&&diff.oldPath&&diff.oldPath!==diff.path?' rename-header':'');
    entry.header.innerHTML=headerHtml(diff);
    entry.meta.innerHTML=metaHtml(diff);
    if(isStatic){
      // 加载占位会写入 80px 内联高度；渲染 Gitlink 列表前必须清除，否则 overflow:hidden 会裁掉后续提交行。
      entry.body.className='diff-body';entry.body.style.height='';entry.body.innerHTML=diff.isGitlink?gitlinkBodyHtml(diff):(diff.error?'<div class="empty">无法读取此文件：'+escapeHtml(diff.error)+'</div>':binaryBodyHtml(diff));
      const measuredBodyHeight=Math.max(entry.body.scrollHeight,entry.body.getBoundingClientRect().height);
      if(measuredBodyHeight>0)entry.bodyHeight=Math.max(80,Math.ceil(measuredBodyHeight));
      return
    }
    if(!wasLoaded&&isLoaded){entry.body.className='diff-body';entry.body.replaceChildren();entry.body.style.height=Math.max(80,entry.bodyHeight)+'px'}
    else if(wasStatic){entry.body.className='diff-body';entry.body.replaceChildren();entry.body.style.height=Math.max(80,entry.bodyHeight)+'px'}
    if(!diff.isGitlink&&!diff.error&&!diff.isBinary&&entry.editor){
      const original=entry.editor.getOriginalEditor(),modified=entry.editor.getModifiedEditor();
      entry.syncingModel=true;
      try{
        if(original.getValue()!==String(diff.original||''))original.setValue(String(diff.original||''));
        if(modified.getValue()!==String(diff.modified||'')){modified.setValue(String(diff.modified||''));entry.modifiedValue=String(diff.modified||'')}
      }finally{entry.syncingModel=false}
      entry.fit();
    }
  }finally{
    if(settledRevealAnchorPath)alignSettledRevealAnchor();
    else restoreViewportAnchor(viewportAnchor)
  }
}
function reconcileSnapshot(snapshot){
  const oldByKey=new Map(cards.map(entry=>[entry.path,entry]));
  const next=[];cardByPath=new Map();
  snapshot.diffs.forEach(function(diff,order){
    const key=diffKey(diff),entry=oldByKey.get(key);
    if(entry){oldByKey.delete(key);entry.index=order;updateEntryFromSnapshot(entry,diff);next.push(entry);cardByPath.set(key,entry)}
    else{const created=createEntry(diff,order);next.push(created);cardByPath.set(key,created)}
  });
  oldByKey.forEach(function(entry){unmountCardShell(entry)});
  cards=next;layoutDirty=true;
}

function render(snapshot){
  try{
    const sameIdentity=lastIdentity!==''&&snapshot.identity===lastIdentity;
    const state=sameIdentity?refreshState():null;
    editable=snapshot.editable===true;
    if(!snapshot.diffs.length){dispose();list.classList.remove('rendering');list.textContent='暂无变更文件';loading.hidden=true;list.hidden=false;lastIdentity=snapshot.identity;log('render #'+snapshot.revision+': empty');notifyRendered(snapshot.revision,snapshot.identity);return}
    const total=snapshot.diffs.length;
    let token=renderToken;
    // show() 会在读取期间隐藏 list。相同 identity 的刷新走 reconcileSnapshot,
    // 原实现只在新 identity 分支恢复 list.hidden=false，导致空态之后再次出现同一文件时
    // 卡片已创建但整个 list 仍被 hidden，最终表现为加载结束后的空白 Diff 面板。
    list.hidden=false;
    if(!sameIdentity){
      requestedDiffPaths.clear();
      prioritizedDiffPaths.clear();
      pendingDiffRequestPaths.clear();
      pendingPriorityDiffRequestPaths.clear();
      dispose();
      token=renderToken;
      list.classList.add('rendering');loading.textContent='正在创建 Diff 列表...';loading.hidden=false;
      cards=snapshot.diffs.map(function(diff,order){return createEntry(diff,order)});
      cardByPath=new Map(cards.map(function(entry){return [entry.path,entry]}));
      layoutDirty=true;
    }else{
      // 空态渲染会在 list 中留下“暂无变更文件”文本节点；重新出现卡片时清掉它。
      if(!cards.length)list.replaceChildren();
      reconcileSnapshot(snapshot);
    }
    if(token!==renderToken)return;
    // 先建立完整逻辑滚动高度，再执行定位；否则首次定位远处文件时文档仍无可滚动高度。
    updateVirtualization();
    const hasPendingReveal=Boolean(pendingRevealPath);
    const requestedRevealPath=pendingRevealPath||snapshot.revealPath;
    const requestedEntry=resolveRevealEntry(requestedRevealPath);
    const target=requestedEntry?requestedEntry.path:diffKey(snapshot.diffs[0]);
    const selectedTargetChanged=Boolean(requestedEntry&&requestedEntry.path!==activePath);
    if(requestedEntry)pendingRevealPath='';
    // 快照选择与当前活动卡片不同时必须执行真实定位，不能只恢复旧刷新锚点或仅切换高亮。
    if(hasPendingReveal||selectedTargetChanged||!sameIdentity||!restoreRefreshState(state,requestedRevealPath))reveal(target,false);
    const activeReveal=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);
    if(activeReveal)updateVirtualizationAtIndex(activeReveal.index,true,true);else updateVirtualization();
    list.classList.remove('rendering');loading.hidden=true;lastIdentity=snapshot.identity;
    log('render #'+snapshot.revision+': cards='+total+', mounted='+mountedCardEntries.size+', reveal='+(sameIdentity?'anchor':target));
    // 外壳和首屏 Monaco 已开始挂载即可放行 Changed Files；后续由滚动虚拟化管理。
    notifyRendered(snapshot.revision,snapshot.identity);
  }catch(error){fail(error)}
}
function handleDiffError(message){
  // 本批读取失败时允许当前可视范围再次触发请求，避免卡片永久停留在“正在读取 Diff”。
  requestedDiffPaths.clear();
  prioritizedDiffPaths.clear();
  pendingDiffRequestPaths.clear();
  pendingPriorityDiffRequestPaths.clear();
  if(cards.length){
    loading.textContent='部分 Diff 读取失败，滚动、调整窗口大小或重新进入后将重试';
    loading.hidden=false;
    list.hidden=false;
  }else show(message.error);
}
function applyDiffUpdates(message){
  if(message.identity!==lastIdentity||!cards.length)return;
  if(message.error){handleDiffError(message);return}
  (message.diffs||[]).forEach(function(diff){
    const entry=cardByPath.get(diffKey(diff));
    if(entry)updateEntryFromSnapshot(entry,diff);
  });
  if(message.diffs&&message.diffs.length){
    const target=programmaticRevealPath&&cardByPath.get(programmaticRevealPath);
    const settled=settledRevealAnchorPath&&cardByPath.get(settledRevealAnchorPath);
    if(target)updateVirtualizationAtIndex(target.index,true,!(target.diff.loaded===true&&(target.staticContent||hasMountedEditorContent(target))));
    else if(settled)updateVirtualizationAtIndex(settled.index,true,false);
    else updateVirtualization();
  }
  if(programmaticRevealPath)scheduleProgrammaticReveal();else if(externalRevealPath)scheduleExternalRevealAlignment();
}
function flushPendingDiffUpdates(){
  if(!monacoReady||!pendingDiffUpdates.length)return;
  const updates=pendingDiffUpdates;pendingDiffUpdates=[];
  updates.forEach(applyDiffUpdates);
}
function receive(message){
  if(!message)return;
  if(message.type==='releaseDiffRequests'){
    const released=new Set(Array.isArray(message.paths)?message.paths.filter(function(path){return typeof path==='string'}):[]);
    released.forEach(function(path){requestedDiffPaths.delete(path);prioritizedDiffPaths.delete(path);pendingDiffRequestPaths.delete(path);pendingPriorityDiffRequestPaths.delete(path)});
    const targetPath=programmaticRevealPath||externalRevealPath;
    const target=targetPath&&cardByPath.get(targetPath);
    if(target&&released.has(target.path)&&target.diff.loaded!==true)ensureDiffRequested(target,true);
    else if(released.size)scheduleVirtualization();
    return
  }
  if(message.type==='reveal'){
    activeChangeIndex=-1;activeChangePage=0;
    if(typeof message.selectionEpoch==='number')selectionEpoch=message.selectionEpoch;
    reveal(message.path,true);return
  }
  if(message.type==='setParentCommitNavigation'){setParentCommitNavigation(message.parentCommit);return}
  if(message.type==='navigateChange'){navigateChange(message.direction===-1?-1:1).catch(fail);return}
  if(message.type==='setRenderSideBySide'){setRenderSideBySide(message.renderSideBySide===true);return}
  if(typeof message.revision!=='number'||message.revision<=lastRevision)return;
  lastRevision=message.revision;
  if(message.type==='diffUpdates'){
    log('receive #'+message.revision+': loading='+message.loading+', progress='+message.completed+'/'+message.total+', updates='+(message.diffs||[]).length);
    if(monacoReady)applyDiffUpdates(message);else pendingDiffUpdates.push(message);
    return;
  }
  if(typeof message.selectionEpoch==='number')selectionEpoch=message.selectionEpoch;
  log('receive #'+message.revision+': loading='+message.loading+', progress='+message.completed+'/'+message.total+', diffs='+message.diffs.length);
  setParentCommitNavigation(message.parentCommit);
  pending=message;
  if(message.error){handleDiffError(message);return}
  if(message.loading){
    if(!cards.length||message.identity!==lastIdentity){
      const progress=message.total>0?' ('+message.completed+'/'+message.total+')':'';
      show('正在读取 Diff 数据'+progress+'...');
    }
    return;
  }
  if(monacoReady){const snapshot=pending;pending=undefined;render(snapshot);flushPendingDiffUpdates()}
}
window.addEventListener('message',event=>receive(event.data));window.gitkQueue.forEach(receive);window.gitkQueue.push=()=>{};window.gitkVscode.postMessage({type:'ready'});
function applyVsCodeTheme(){const css=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim(),colors={},background=css('--vscode-editor-background'),foreground=css('--vscode-editor-foreground');if(background)colors['editor.background']=background;if(foreground)colors['editor.foreground']=foreground;monaco.editor.defineTheme('gitk-vscode-surface',{base:document.body.classList.contains('vscode-light')?'vs':'vs-dark',inherit:true,rules:[],colors});monaco.editor.setTheme('gitk-vscode-surface')}
function applyVsCodeFont(editor){const style=getComputedStyle(document.documentElement),fontFamily=style.getPropertyValue('--vscode-editor-font-family').trim(),fontSize=Number.parseFloat(style.getPropertyValue('--vscode-editor-font-size'));editor.updateOptions({fontFamily:fontFamily||undefined,fontSize:Number.isFinite(fontSize)?fontSize:undefined})}
try{require.config({paths:{vs:'${monacoUri}'}});require(['vs/editor/editor.main'],()=>{try{applyVsCodeTheme();monacoReady=true;if(pending&&!pending.loading&&!pending.error){const snapshot=pending;pending=undefined;render(snapshot)}flushPendingDiffUpdates()}catch(error){fail(error)}},fail)}catch(error){fail(error)}
</script></body></html>`;
}
