/**
 * Commit 面板 webview 页面: 纵向排列各仓库卡片(提交信息框 + staged/unstaged/committed 列表)。
 * 与 GitkViewProvider 的 webview 一样, 页面整体由 render 函数产出, 面板类只负责准备 nonce/CSP/首屏快照。
 */

import { COMMIT_CARD_SCRIPT } from './commitCardScript';
import { COMMIT_FILE_LIST_SCRIPT } from './commitFileListScript';
import { COMMIT_SUBMODULE_SELECTOR_SCRIPT } from './commitSubmoduleSelectorScript';
export function renderCommitPanelHtml(
    codiconCssUri: string,
    nonce: string,
    csp: string,
    initialSnapshotJson: string,
): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{color-scheme:light dark;--card-radius:9px;--card-border:1px;--card-ring:1px;--header-surface:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground));--file-path-font-size:calc(var(--vscode-editor-font-size) * .9);--file-row-padding-y:3px;--file-row-padding-x:10px;--row-icon-size:14px;--row-icon-padding:2px;--file-row-height:calc(var(--row-icon-size) + 2 * var(--row-icon-padding) + 2 * var(--file-row-padding-y))}
*{box-sizing:border-box}
/* 与 MultiDiff 一致: 偏暗背板 + 卡片浮起, 视觉统一。 */
body{margin:0;padding-bottom:14px;background:color-mix(in srgb, var(--vscode-editor-background) 50%, #000);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
#app{width:100%;padding:8px}
#app:empty::before{content:'正在加载提交面板…';display:grid;min-height:calc(100vh - 30px);place-items:center;color:var(--vscode-descriptionForeground)}
#loading{display:grid;min-height:calc(100vh - 30px);place-items:center;gap:10px;color:var(--vscode-descriptionForeground)}
#loading[hidden]{display:none}
.loading-content{display:flex;flex-direction:column;align-items:center;gap:10px}
.loading-track{width:min(360px,80vw);height:3px;overflow:hidden;background:var(--vscode-progressBar-background);opacity:.35}
.loading-bar{height:100%;width:35%;background:var(--vscode-progressBar-background);animation:loading-slide 1.1s ease-in-out infinite}
.loading-message{font-size:var(--vscode-editor-font-size)}
@keyframes loading-slide{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
.card{position:relative;width:100%;margin:0 0 14px;display:flex;flex-direction:column;border:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius);background:var(--vscode-editor-background);box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:visible}
/* 卡片标题吸顶, 与 MultiDiff 的 file-header 行为一致。 */
.card-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--header-surface);font-weight:600;border-bottom:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.repo-label{white-space:nowrap}
.repository-ancestry{display:inline-flex;align-items:center;gap:3px;min-width:0;color:var(--vscode-descriptionForeground);font-size:inherit;font-weight:400;opacity:.65}
.repository-ancestry[hidden]{display:none}
.repository-ancestry-link{border:0;padding:0;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.repository-ancestry-link:hover{text-decoration:underline;color:var(--vscode-textLink-foreground)}
.repository-ancestry-separator{opacity:.8}
.repository-icon{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px;font-size:16px;line-height:16px;color:var(--vscode-icon-foreground)}
.repository-icon.has-submodules{color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-icon-foreground))}
.card-header .repository-icon.codicon{display:flex;align-items:center;justify-content:center;width:16px;height:16px;font-size:16px;line-height:16px}
.card.selected-card{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder),0 1px 4px rgba(0,0,0,.12)}
.card.selected-card .card-header{border-bottom-color:var(--vscode-focusBorder)}
.card-header .codicon:not(.repository-icon){font-size:15px;color:var(--vscode-icon-foreground)}
.card.collapsible-card .card-header{cursor:pointer}
/* 折叠后只剩标题栏: 去掉多余底边框, 让标题栏自身呈完整卡片外观。 */
.card.collapsed .card-header{border-bottom:0;border-radius:var(--card-radius);box-shadow:none}
.card.collapsible-card .card-header:hover{background:var(--vscode-list-hoverBackground)}
.card-empty-tag{margin-left:6px;padding:2px 7px;border-radius:9px;background:#2e7d32;color:#fff;font-weight:600;font-size:calc(var(--vscode-editor-font-size) * .85);line-height:16px}
.card-empty-tag:empty{display:none}
.section-count-badge,.repository-status-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;font-weight:600;line-height:18px}
.section-count-badge[hidden],.repository-status-badge[hidden]{display:none}
.card-body{display:flex;flex-direction:column;gap:10px;padding:10px 12px}
/* 作者样式 display:flex 会覆盖 hidden 的 UA 默认 display:none，必须显式声明。 */
.card-body[hidden]{display:none}
.message-box{position:relative;display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:6px;overflow:hidden}
.message-input{box-sizing:border-box;width:100%;min-height:calc(3 * 1.5em + 20px);resize:none;overflow-y:hidden;border:0;outline:0;padding:10px 42px 32px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5}
.actions{display:flex;flex-direction:column;gap:8px}
.hint{min-width:120px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size) * .9)}
.action-groups{display:flex;flex-direction:column;gap:8px;width:100%}
.action-group{display:grid;grid-template-columns:auto auto minmax(0,1fr);grid-auto-rows:max-content;align-items:center;gap:8px;width:100%;height:auto;padding:8px 10px;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:7px;background:var(--vscode-editorWidget-background)}
.commit-group{border-color:var(--vscode-button-background)}
.commit-group .commit-btn,.submodule-group .push-btn{grid-column:1;grid-row:1}
.commit-group .commit-option,.submodule-group .pull-option{grid-column:2;grid-row:1}
.commit-submodule-selector,.submodule-group .submodule-selector{grid-column:1 / -1;grid-row:2;min-width:0;max-width:none}
.submodule-inline-box{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:40px;box-sizing:border-box;border:1px dashed var(--vscode-focusBorder,var(--vscode-widget-border));border-radius:8px;padding:7px 10px;background:transparent;color:var(--vscode-foreground)}
.submodule-inline-title{flex:0 0 auto;min-width:5.5em;padding:2px 10px 2px 0;border-right:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .9);font-weight:600;line-height:20px;white-space:nowrap}
.submodule-inline-options{display:flex;flex:1 1 auto;flex-wrap:wrap;align-items:stretch;gap:6px;max-height:100px;min-width:0;overflow:auto}
.submodule-inline-option{display:inline-flex;align-items:center;gap:5px;min-height:24px;box-sizing:border-box;padding:3px 7px;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:5px;background:var(--vscode-list-inactiveSelectionBackground);white-space:nowrap;cursor:pointer;font-size:calc(var(--vscode-editor-font-size) * .9);transition:border-color .12s ease,background .12s ease}
.submodule-inline-repository{border:0;padding:0;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;cursor:pointer;white-space:nowrap}
.submodule-inline-repository:hover{text-decoration:underline;color:var(--vscode-textLink-activeForeground)}
.submodule-inline-option .repository-status-badge{height:18px;line-height:18px}
.submodule-push-target{margin-left:auto;border:0;border-left:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));padding:0 0 0 7px;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;font-size:calc(var(--vscode-editor-font-size) * .85);cursor:pointer;white-space:nowrap}
.submodule-push-target:hover{text-decoration:underline;color:var(--vscode-textLink-activeForeground)}
.submodule-inline-option:hover{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
.submodule-inline-option:has(input:checked){border-color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 12%,transparent)}
.submodule-inline-option input{margin:0;accent-color:var(--vscode-checkbox-background,var(--vscode-button-background))}
.submodule-inline-empty{line-height:20px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .9)}
.commit-options{display:inline-flex;align-items:center;gap:8px}
.history-btn{box-sizing:border-box;height:calc(1em + 12px);min-width:calc(1em + 16px);border:0;padding:0 8px;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;font:inherit}
.history-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.message-history-btn{position:absolute;right:4px;bottom:4px;z-index:1}
.history-btn .codicon{font-size:14px}
.submodule-selector{position:relative;display:inline-flex;align-items:center}
.submodule-selector[hidden]{display:none}
/* 这里位于外层 HTML 模板字符串内，内嵌脚本的反斜杠必须保留。 */
.submodule-selector-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:5px;width:auto;max-width:100%;min-width:7em;border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:2px;padding:5px 8px;background:var(--vscode-dropdown-background,var(--vscode-editorWidget-background));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));cursor:pointer;font:inherit}
.submodule-selector-label{min-width:0;max-width:36em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.submodule-selector-btn:hover{background:var(--vscode-list-hoverBackground)}
.submodule-selector-btn:disabled{opacity:.55;cursor:default}
.submodule-selector-chevron{font-size:12px;transition:transform .12s ease}
.submodule-selector-btn[aria-expanded="true"] .submodule-selector-chevron{transform:rotate(180deg)}
.submodule-dropdown{position:absolute;right:0;top:calc(100% + 4px);z-index:1000;display:flex;flex-direction:column;min-width:280px;max-width:min(480px,calc(100vw - 24px));max-height:min(420px,calc(100vh - 24px));padding:6px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));border-radius:2px;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.submodule-dropdown[hidden]{display:none}
.submodule-dropdown-title{padding:5px 8px;color:var(--vscode-menu-foreground,var(--vscode-foreground));font-weight:600}
.submodule-dropdown-filter{width:100%;box-sizing:border-box;margin:2px 0 6px;padding:5px 7px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border));outline:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}
.submodule-dropdown-filter:focus{border-color:var(--vscode-focusBorder)}
.submodule-dropdown-options{min-height:24px;overflow:auto}
.submodule-dropdown-option{display:flex;align-items:center;gap:7px;padding:5px 8px;color:var(--vscode-menu-foreground,var(--vscode-foreground));cursor:pointer}
.submodule-dropdown-option:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground))}
.submodule-dropdown-option input{margin:0;accent-color:var(--vscode-checkbox-background,var(--vscode-button-background))}
.submodule-dropdown-empty{padding:7px 8px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .9)}
.submodule-dropdown-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;padding:6px 8px 2px;border-top:1px solid var(--vscode-menu-separatorBackground,var(--vscode-widget-border))}
.submodule-dropdown-action{border:0;border-radius:2px;padding:4px 9px;background:transparent;color:var(--vscode-menu-foreground,var(--vscode-foreground));cursor:pointer;font:inherit}
.submodule-dropdown-action:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground))}
.commit-option,.pull-option{display:inline-flex;align-items:center;gap:4px;color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family);font-size:12px;cursor:pointer;user-select:none}
.pull-option input{margin:0;accent-color:var(--vscode-checkbox-background,var(--vscode-button-background))}
.commit-option input{margin:0;accent-color:var(--vscode-button-background)}
.commit-option input:disabled+span{opacity:.5}
.commit-btn,.push-btn{flex:0 0 auto;border:0;border-radius:5px;padding:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-family:var(--vscode-editor-font-family);font-size:13px;line-height:normal}
.commit-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.commit-btn:hover{background:var(--vscode-button-hoverBackground)}
.push-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.push-btn:hover{background:var(--vscode-button-hoverBackground)}
.push-btn{display:inline-flex;align-items:center;gap:8px}
.push-target-label{max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:1px solid color-mix(in srgb,currentColor 45%,transparent);padding-left:8px;font-size:13px;opacity:.85}

.commit-btn:disabled,.push-btn:disabled{opacity:1;cursor:pointer}
.commit-option input:disabled{cursor:default}
.commit-option input:disabled+span{cursor:default}
.section{display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:6px;overflow:hidden}
.section[hidden]{display:none}
.section.committed .file-row{cursor:default}
.section-title{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:var(--vscode-editorWidget-background);font-weight:600;font-size:calc(var(--vscode-font-size) * .95)}
.section-title.collapsible{cursor:pointer;user-select:none}
.section-title .left{display:flex;align-items:center;gap:4px}
.section-title .section-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
.section-title .codicon{font-size:14px}
.file-row,.folder-row{display:flex;align-items:center;gap:6px;padding:var(--file-row-padding-y) var(--file-row-padding-x)}
.gitlink-label{display:inline-flex;align-items:center;flex:0 0 auto;margin:0;padding:0 6px;border:1px solid var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-badge-background));border-radius:8px;background:color-mix(in srgb,var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-badge-background)) 12%,transparent);color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-badge-foreground));font-size:10px;font-weight:600;line-height:16px;letter-spacing:.02em}
.file-row:hover,.folder-row:hover{background:var(--vscode-list-hoverBackground)}
.file-row.multi-selected{background:var(--vscode-list-inactiveSelectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-list-inactiveSelectionForeground,var(--vscode-foreground))}
.file-row .status{width:14px;text-align:center;color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.file-row .path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--file-path-font-size)}
.file-row .file-folder{opacity:.55}
.file-row.staged .file-name{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.file-row.unstaged .file-name{color:var(--vscode-textLink-foreground,#3794ff)}
.file-row.untracked .file-name{color:var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)}
.folder-row{cursor:pointer;font-weight:600}
.folder-row .codicon{font-size:14px}
.folder-row .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-row .row-actions,.file-row .row-actions .icon-btn,.file-row .row-actions .codicon{opacity:1}
.file-row .row-actions{display:flex;gap:4px}
.icon-btn{border:0;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;padding:var(--row-icon-padding);border-radius:3px;display:inline-flex;align-items:center}
.icon-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.icon-btn:disabled{opacity:.35;cursor:default}
.icon-btn:disabled:hover{background:transparent}
.icon-btn .codicon{font-size:var(--row-icon-size)}
/* 空态与文件行同高同字号: 行高由行内操作按钮(14px codicon + 2px padding)加上下内边距推出, 与文件路径共用变量避免再次漂移。 */
.empty{display:flex;align-items:center;padding:var(--file-row-padding-y) var(--file-row-padding-x);min-height:var(--file-row-height);color:var(--vscode-descriptionForeground);font-size:var(--file-path-font-size)}
.no-repos{padding:20px;color:var(--vscode-descriptionForeground);text-align:center}
</style>
</head>
<body>
<script nonce="${nonce}" id="gitk-initial-snapshot" type="application/json">${initialSnapshotJson}</script>
<div id="loading"><div class="loading-content"><div class="loading-message">正在加载提交面板…</div><div class="loading-track"><div class="loading-bar"></div></div></div></div>
<div id="app" hidden></div>
<script nonce="${nonce}">
(function(){
  const vscode=acquireVsCodeApi();
  // codicon.css 只提供图标字形; 放在 head 的阻塞 <link> 会把 ready 消息的发出一起挡住,
  // 改为脚本动态挂载后, 首屏数据不再等待该样式表(尺寸由内联样式固定, 不会引起布局跳动)。
  const codiconLink=document.createElement('link');
  codiconLink.rel='stylesheet';
  codiconLink.href='${codiconCssUri}';
  document.head.appendChild(codiconLink);
  const loading=document.getElementById('loading');
  const loadingMessage=loading.querySelector('.loading-message');
  const app=document.getElementById('app');
  const cardEls=new Map();
  const collapsedFolders=new Set();
  let selectedRepositoryPath='';
  let displayMode='flat';
  let currentCards=[];

  function selectCard(repositoryPath){
    selectedRepositoryPath=repositoryPath;
    cardEls.forEach(function(card){card.classList.toggle('selected-card',card.dataset.repo===repositoryPath)});
  }

${COMMIT_FILE_LIST_SCRIPT}
${COMMIT_SUBMODULE_SELECTOR_SCRIPT}
${COMMIT_CARD_SCRIPT}

  function captureViewportAnchor(){
    for(const el of cardEls.values()){
      const rect=el.getBoundingClientRect();
      if(rect.bottom>0)return {repositoryPath:el.dataset.repo||'',offset:rect.top};
    }
    return null;
  }

  function restoreViewportAnchor(anchor){
    if(!anchor)return;
    const el=cardEls.get(anchor.repositoryPath);
    if(!el)return;
    const delta=el.getBoundingClientRect().top-anchor.offset;
    if(Math.abs(delta)>=0.5)window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});
  }

  function render(cards){
    const viewportAnchor=captureViewportAnchor();
    // 先更新 currentCards，updatePushSelector 依赖它查找可推送的子模块。
    currentCards=cards;
    if(!cards.length){
      app.innerHTML='<div class="no-repos">没有可提交的仓库</div>';
      cardEls.clear();
      app.hidden=false;loading.hidden=true;
      vscode.postMessage({type:'rendered',cardCount:0});
      return;
    }
    const seen=new Set();
    let previous=null;
    cards.forEach(function(card){
      seen.add(card.repositoryPath);
      let el=cardEls.get(card.repositoryPath);
      if(!el){el=buildCard(card.repositoryPath);cardEls.set(card.repositoryPath,el)}
      // 先更新 detached 卡片、再插入 app；更新异常会导致卡片未挂载，必须保证 updateCard 不抛错。
      updateCard(el,card);
      // 保持卡片顺序与快照一致, 复用已存在 DOM。
      if(previous){if(previous.nextSibling!==el)app.insertBefore(el,previous.nextSibling)}
      else if(app.firstChild!==el)app.insertBefore(el,app.firstChild);
      previous=el;
    });
    // 移除快照中已不存在的仓库卡片。
    cardEls.forEach(function(el,repo){if(!seen.has(repo)){el.remove();cardEls.delete(repo)}});
    restoreViewportAnchor(viewportAnchor);
    app.hidden=false;loading.hidden=true;
    loadingMessage.textContent='已加载 '+cards.length+' 个仓库';
    vscode.postMessage({type:'rendered',cardCount:cards.length});
  }

  window.addEventListener('message',function(event){
    const message=event.data;
    if(!message)return;
    if(message.type==='snapshot'){displayMode=message.displayMode;render(message.cards||[])}
    else if(message.type==='setMessage'){
      const el=cardEls.get(message.repositoryPath);
      if(el){el._refs.messageInput.value=message.message||'';resizeMessageInput(el._refs.messageInput);el._refs.hint.textContent='';el._refs.messageInput.focus()}
    }else if(message.type==='focus'){
      const el=cardEls.get(message.repositoryPath);
      if(el){selectCard(message.repositoryPath);el.scrollIntoView({behavior:'auto',block:'start'});el._refs.messageInput.focus()}
    }
  });

  // 首屏快照随 HTML 内联下发, 首次渲染在首次绘制前完成, 不再等 ready→postMessage 往返。
  const initialSnapshotNode=document.getElementById('gitk-initial-snapshot');
  if(initialSnapshotNode){
    const initial=JSON.parse(initialSnapshotNode.textContent);
    displayMode=initial.displayMode;
    render(initial.cards||[]);
  }
  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
}
