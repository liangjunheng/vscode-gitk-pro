import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export interface CommitPanelFile {
    readonly path: string;
    readonly status: string;
    readonly isUntracked?: boolean;
}

/** 单个仓库提交卡片数据。 */
export interface CommitCard {
    readonly repositoryPath: string;
    readonly repositoryLabel: string;
    readonly amend: boolean;
    readonly stagedFiles: readonly CommitPanelFile[];
    readonly unstagedFiles: readonly CommitPanelFile[];
    readonly committing: boolean;
}

export interface CommitPanelSnapshot {
    readonly cards: readonly CommitCard[];
}

type CommitPanelCallbacks = {
    readonly onCommit: (repositoryPath: string, message: string, amend: boolean) => void;
    readonly onToggleAmend: (repositoryPath: string) => void;
    readonly onHistory: (repositoryPath: string) => void;
    readonly onWorkingTreeAction: (
        repositoryPath: string,
        action: 'stage' | 'unstage' | 'discard',
        section: 'staged' | 'unstaged',
        paths: readonly string[],
        untrackedPaths: readonly string[],
    ) => void;
    readonly onClose: () => void;
};

/**
 * Commit 面板: 编辑器区 webview, 纵向排列所有仓库卡片(标题=仓库名),
 * 每张卡片=一个仓库的提交信息框 + staged/unstaged 列表。
 */
export class CommitPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private webviewReady = false;
    private snapshot?: CommitPanelSnapshot;
    private postQueue: Promise<unknown> = Promise.resolve();
    private pendingFocusRepositoryPath?: string;

    constructor(private readonly callbacks: CommitPanelCallbacks) {}

    show(snapshot: CommitPanelSnapshot, focusRepositoryPath?: string): void {
        this.snapshot = snapshot;
        const isNew = !this.panel;
        this.ensurePanel();
        this.panel!.reveal(this.panel!.viewColumn ?? vscode.ViewColumn.Active, false);
        if (focusRepositoryPath) { this.pendingFocusRepositoryPath = focusRepositoryPath; }
        if (isNew || !this.webviewReady) { return; }
        this.publish();
        this.sendPendingFocus();
    }

    update(snapshot: CommitPanelSnapshot): void {
        this.snapshot = snapshot;
        if (this.panel && this.webviewReady) { this.publish(); }
    }

    /** 定位到指定仓库卡片, 不重新渲染。 */
    focus(repositoryPath: string): void {
        if (this.panel && this.webviewReady) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
            this.post({ type: 'focus', repositoryPath });
        }
    }

    /** 把历史提交信息填入指定仓库卡片的信息框。 */
    setMessage(repositoryPath: string, message: string): void {
        if (this.panel && this.webviewReady) { this.post({ type: 'setMessage', repositoryPath, message }); }
    }

    isVisible(): boolean { return Boolean(this.panel); }

    hasRepository(repositoryPath: string): boolean {
        return Boolean(this.snapshot?.cards.some(card => card.repositoryPath === repositoryPath));
    }

    hide(): void { this.panel?.dispose(); }

    dispose(): void { this.panel?.dispose(); }

    private ensurePanel(): void {
        if (this.panel) { return; }
        this.webviewReady = false;
        this.postQueue = Promise.resolve();
        const codiconsRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..', 'media', 'codicons');
        this.panel = vscode.window.createWebviewPanel('vscode-gitk.commit', 'Commit', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [codiconsRoot],
        });
        this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
        this.panel.onDidDispose(() => { this.panel = undefined; this.webviewReady = false; this.pendingFocusRepositoryPath = undefined; });
        this.panel.webview.html = this.getHtml(codiconsRoot);
    }

    private sendPendingFocus(): void {
        if (!this.pendingFocusRepositoryPath || !this.panel || !this.webviewReady) { return; }
        const repositoryPath = this.pendingFocusRepositoryPath;
        this.pendingFocusRepositoryPath = undefined;
        this.post({ type: 'focus', repositoryPath });
    }

    private handleMessage(message: unknown): void {
        if (!message || typeof message !== 'object') { return; }
        const data = message as Record<string, unknown>;
        const repo = typeof data.repositoryPath === 'string' ? data.repositoryPath : undefined;
        if (data.type === 'ready') {
            this.webviewReady = true;
            this.publish();
            this.sendPendingFocus();
        } else if (data.type === 'rendered' && typeof data.cardCount === 'number') {
            console.log('[Gitk][CommitPanel] rendered', {
                timestamp: new Date().toISOString(),
                cardCount: data.cardCount,
            });
        } else if (data.type === 'commit' && repo && typeof data.message === 'string' && typeof data.amend === 'boolean') {
            this.callbacks.onCommit(repo, data.message, data.amend);
        } else if (data.type === 'toggleAmend' && repo) {
            this.callbacks.onToggleAmend(repo);
        } else if (data.type === 'history' && repo) {
            this.callbacks.onHistory(repo);
        } else if (data.type === 'workingTreeAction' && repo
            && (data.action === 'stage' || data.action === 'unstage' || data.action === 'discard')
            && (data.section === 'staged' || data.section === 'unstaged')
            && Array.isArray(data.paths)
            && data.paths.every(filePath => typeof filePath === 'string')
            && Array.isArray(data.untrackedPaths)
            && data.untrackedPaths.every(filePath => typeof filePath === 'string')) {
            this.callbacks.onWorkingTreeAction(
                repo,
                data.action,
                data.section,
                data.paths as string[],
                data.untrackedPaths as string[],
            );
        } else if (data.type === 'close') {
            this.callbacks.onClose();
        } else if (data.type === 'error') {
            console.error('[gitk-commit]', data.message);
        }
    }

    private publish(): void {
        if (!this.panel || !this.webviewReady || !this.snapshot) { return; }
        this.post({ type: 'snapshot', cards: this.snapshot.cards })
            .then(() => console.log('[Gitk][CommitPanel] snapshot posted', {
                timestamp: new Date().toISOString(),
                cardCount: this.snapshot?.cards.length,
            }));
    }

    private post(message: unknown): Promise<void> {
        this.postQueue = this.postQueue
            .catch(() => undefined)
            .then(() => this.panel?.webview.postMessage(message));
        return this.postQueue.then(() => undefined);
    }

    private getHtml(codiconsRoot: vscode.Uri): string {
        const webview = this.panel!.webview;
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css'));
        const nonce = randomBytes(16).toString('base64');
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconCssUri}">
<style>
:root{color-scheme:light dark;--card-radius:9px;--card-border:1px;--card-ring:1px;--header-surface:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground))}
*{box-sizing:border-box}
/* 与 MultiDiff 一致: 偏暗背板 + 卡片浮起, 视觉统一。 */
body{margin:0;padding-bottom:14px;background:color-mix(in srgb, var(--vscode-editor-background) 50%, #000);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
#app{width:100%;padding:8px}
.card{position:relative;width:100%;margin:0 0 14px;display:flex;flex-direction:column;border:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius);background:var(--vscode-editor-background);box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
/* 卡片标题吸顶, 与 MultiDiff 的 file-header 行为一致。 */
.card-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--header-surface);font-weight:600;border-bottom:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.card.selected-card{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder),0 1px 4px rgba(0,0,0,.12)}
.card.selected-card .card-header{border-bottom-color:var(--vscode-focusBorder)}
.card-header .codicon{font-size:15px;color:var(--vscode-icon-foreground)}
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
.message-box{display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:6px;overflow:hidden}
.message-input{width:100%;min-height:80px;resize:vertical;border:0;outline:0;padding:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.5}
.actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
.hint{margin-right:auto;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size) * .9)}
.history-btn{border:0;padding:6px 8px;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;display:inline-flex;align-items:center;border-radius:4px}
.history-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.history-btn .codicon{font-size:14px}
.commit-split{display:inline-flex;border-radius:4px;overflow:hidden}
.commit-btn{border:0;padding:6px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font:inherit}
.commit-btn:hover{background:var(--vscode-button-hoverBackground)}
.commit-btn:disabled{opacity:.5;cursor:default}
.amend-toggle{border:0;border-left:1px solid var(--vscode-button-separator,rgba(255,255,255,.2));padding:6px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;display:inline-flex;align-items:center}
.amend-toggle:hover{background:var(--vscode-button-hoverBackground)}
.amend-toggle:disabled{opacity:.5;cursor:default}
.amend-toggle:disabled:hover{background:var(--vscode-button-background)}
.amend-toggle .codicon{font-size:12px}
.amend-toggle.amend{background:color-mix(in srgb,var(--vscode-button-foreground) 22%,var(--vscode-button-background))}
.section{display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:6px;overflow:hidden}
.section-title{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:var(--vscode-editorWidget-background);font-weight:600;font-size:calc(var(--vscode-font-size) * .95)}
.section-title.collapsible{cursor:pointer;user-select:none}
.section-title .left{display:flex;align-items:center;gap:4px}
.section-title .section-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
.section-title .codicon{font-size:14px}
.file-row{display:flex;align-items:center;gap:6px;padding:3px 10px}
.file-row:hover{background:var(--vscode-list-hoverBackground)}
.file-row .status{width:14px;text-align:center;color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.file-row .path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-row .row-actions,.file-row .row-actions .icon-btn,.file-row .row-actions .codicon{opacity:1}
.file-row .row-actions{display:flex;gap:4px}
.icon-btn{border:0;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;padding:2px;border-radius:3px;display:inline-flex;align-items:center}
.icon-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.icon-btn:disabled{opacity:.35;cursor:default}
.icon-btn:disabled:hover{background:transparent}
.icon-btn .codicon{font-size:14px}
.empty{padding:6px 10px;color:var(--vscode-descriptionForeground)}
.no-repos{padding:20px;color:var(--vscode-descriptionForeground);text-align:center}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
(function(){
  const vscode=acquireVsCodeApi();
  const app=document.getElementById('app');
  // 每仓库卡片状态在 webview 端保留, 重渲染时复用 DOM 与用户已输入的提交信息。
  const cardEls=new Map();
  let selectedRepositoryPath='';

  function selectCard(repositoryPath){
    selectedRepositoryPath=repositoryPath;
    cardEls.forEach(function(card){card.classList.toggle('selected-card',card.dataset.repo===repositoryPath)});
  }

  function statusLabel(file){return file.isUntracked?'U':(file.status||'M').slice(0,1).toUpperCase()}

  function actionButton(action,section,path,icon,title){
    const button=document.createElement('button');
    button.className='icon-btn';
    button.dataset.action=action;
    button.dataset.section=section;
    button.dataset.path=path;
    button.title=title;
    const iconElement=document.createElement('span');
    iconElement.className='codicon codicon-'+icon;
    button.appendChild(iconElement);
    return button;
  }
  function fileRowHtml(file,section){
    const row=document.createElement('div');
    row.className='file-row';
    const status=document.createElement('span');
    status.className='status';
    status.textContent=statusLabel(file);
    const pathElement=document.createElement('span');
    pathElement.className='path';
    pathElement.title=file.path;
    pathElement.textContent=file.path;
    const actions=document.createElement('span');
    actions.className='row-actions';
    if(section==='staged'){
      actions.appendChild(actionButton('unstage',section,file.path,'remove','取消暂存'));
    }else{
      actions.appendChild(actionButton('discard',section,file.path,'discard','放弃更改'));
      actions.appendChild(actionButton('stage',section,file.path,'add','暂存'));
    }
    row.appendChild(status);
    row.appendChild(pathElement);
    row.appendChild(actions);
    return row;
  }

  function buildCard(repo){
    const el=document.createElement('div');
    el.className='card';
    el.dataset.repo=repo;
    el.innerHTML=
      '<div class="card-header"><span class="codicon codicon-chevron-down card-chevron"></span><span class="codicon codicon-repo"></span><span class="repo-label"></span><span class="repository-status-badge untracked-count"></span><span class="repository-status-badge unstaged-header-count"></span><span class="repository-status-badge staged-header-count"></span><span class="card-empty-tag"></span></div>'+
      '<div class="card-body">'+
        '<div class="message-box">'+
          '<textarea class="message-input" placeholder="输入提交信息…" spellcheck="false"></textarea>'+
        '</div>'+
        '<div class="section staged"><div class="section-title"><span class="left"><span>Staged Changes</span><span class="section-count-badge staged-count" hidden></span></span><span class="section-actions staged-actions"><button class="icon-btn staged-all" data-action="unstage" data-section="staged" title="取消暂存所有文件"><span class="codicon codicon-remove"></span></button></span></div><div class="staged-list"></div></div>'+
        '<div class="section unstaged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down unstaged-chevron"></span><span>Unstaged Changes</span><span class="section-count-badge unstaged-count" hidden></span></span><span class="section-actions unstaged-actions"><button class="icon-btn discard-all" data-action="discard" data-section="unstaged" title="还原所有文件"><span class="codicon codicon-discard"></span></button><button class="icon-btn stage-all" data-action="stage" data-section="unstaged" title="暂存所有文件"><span class="codicon codicon-add"></span></button></span></div><div class="unstaged-list"></div></div>'+
        '<div class="actions">'+
          '<span class="hint"></span>'+
          '<button class="history-btn" title="历史提交信息"><span class="codicon codicon-history"></span></button>'+
          '<span class="commit-split"><button class="commit-btn">Commit</button><button class="amend-toggle" title="切换到 Commit (Amend)"><span class="codicon codicon-arrow-swap"></span></button></span>'+
        '</div>'+
      '</div>';
    const state={unstagedOpen:true};
    const messageInput=el.querySelector('.message-input');
    const commitBtn=el.querySelector('.commit-btn');
    const amendToggle=el.querySelector('.amend-toggle');
    const historyBtn=el.querySelector('.history-btn');
    const hint=el.querySelector('.hint');
    const unstagedTitle=el.querySelector('.section-title.collapsible');
    const unstagedList=el.querySelector('.unstaged-list');
    const unstagedChevron=el.querySelector('.unstaged-chevron');
    const cardHeader=el.querySelector('.card-header');
    const cardChevron=el.querySelector('.card-chevron');
    const cardBody=el.querySelector('.card-body');

    el.addEventListener('click',function(){selectCard(repo)});
    // 仅无任何未提交文件的仓库可折叠; 有变更的仓库强制展开、不可折叠。
    cardHeader.addEventListener('click',function(){
      if(!el._collapsible)return;
      state.cardCollapsed=!state.cardCollapsed;
      cardBody.hidden=state.cardCollapsed;
      el.classList.toggle('collapsed',state.cardCollapsed);
      cardChevron.className='codicon codicon-chevron-'+(state.cardCollapsed?'right':'down')+' card-chevron';
    });

    amendToggle.addEventListener('click',function(){vscode.postMessage({type:'toggleAmend',repositoryPath:repo})});
    historyBtn.addEventListener('click',function(){vscode.postMessage({type:'history',repositoryPath:repo})});
    el.querySelectorAll('.section-actions .icon-btn').forEach(function(button){
      button.addEventListener('click',function(event){
        event.stopPropagation();
        const files=button.dataset.section==='staged'?el._card.stagedFiles:el._card.unstagedFiles;
        vscode.postMessage({
          type:'workingTreeAction',
          repositoryPath:repo,
          action:button.dataset.action,
          section:button.dataset.section,
          paths:files.map(function(file){return file.path}),
          untrackedPaths:files.filter(function(file){return file.isUntracked}).map(function(file){return file.path}),
        });
      });
    });
    commitBtn.addEventListener('click',function(){
      const message=messageInput.value.trim();
      if(!message){hint.textContent='提交信息不能为空';messageInput.focus();return}
      vscode.postMessage({type:'commit',repositoryPath:repo,message:messageInput.value,amend:el._amend===true});
    });
    messageInput.addEventListener('input',function(){hint.textContent=''});
    messageInput.addEventListener('keydown',function(event){
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();commitBtn.click()}
    });
    unstagedTitle.addEventListener('click',function(){
      state.unstagedOpen=!state.unstagedOpen;
      unstagedList.hidden=!state.unstagedOpen;
      unstagedChevron.className='codicon codicon-chevron-'+(state.unstagedOpen?'down':'right')+' unstaged-chevron';
    });

    state.cardCollapsed=false;
    el._state=state;
    el._refs={messageInput,commitBtn,amendToggle,hint,unstagedList,cardChevron,cardBody,cardHeader};
    return el;
  }

  function bindRowActions(container,repo,card){
    container.querySelectorAll('.icon-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        const filePath=btn.dataset.path;
        const file=card[btn.dataset.section==='staged'?'stagedFiles':'unstagedFiles'].find(function(item){return item.path===filePath});
        vscode.postMessage({
          type:'workingTreeAction',
          repositoryPath:repo,
          action:btn.dataset.action,
          section:btn.dataset.section,
          paths:[filePath],
          untrackedPaths:file&&file.isUntracked?[filePath]:[],
        });
      });
    });
  }

  function updateCard(el,card){
    el._card=card;
    el._amend=card.amend;
    el.querySelector('.repo-label').textContent=card.repositoryLabel;
    const refs=el._refs;
    el.classList.toggle('selected-card',el.dataset.repo===selectedRepositoryPath);
    const isEmpty=card.stagedFiles.length===0&&card.unstagedFiles.length===0;
    refs.amendToggle.classList.toggle('amend',card.amend);
    refs.commitBtn.textContent=card.amend?'Commit (Amend)':'Commit';
    // 没有任何暂存内容时禁用提交与其旁的 amend 切换按钮。
    const disableCommit=card.committing||card.stagedFiles.length===0;
    refs.commitBtn.disabled=disableCommit;
    refs.amendToggle.disabled=disableCommit;
    refs.hint.textContent=card.committing?'正在提交…':(card.stagedFiles.length?'':'没有已暂存的更改');
    // 空仓库可折叠且每次刷新强制折叠(不持久化用户展开态); 非空仓库强制展开且不可折叠。
    el._collapsible=isEmpty;
    el.querySelector('.card-empty-tag').textContent=isEmpty?'无更改':'';
    el.classList.toggle('collapsible-card',isEmpty);
    el._state.cardCollapsed=isEmpty;
    refs.cardBody.hidden=el._state.cardCollapsed;
    el.classList.toggle('collapsed',el._state.cardCollapsed);
    refs.cardChevron.hidden=!isEmpty;
    refs.cardChevron.className='codicon codicon-chevron-'+(el._state.cardCollapsed?'right':'down')+' card-chevron';
    const untrackedCount=card.unstagedFiles.filter(file=>file.isUntracked).length;
    const unstagedHeaderCount=card.unstagedFiles.length-untrackedCount;
    const updateRepositoryStatusBadge=function(selector,label,count){
      const badge=el.querySelector(selector);
      badge.textContent=count?label+' '+count:'';
      badge.hidden=count===0;
    };
    updateRepositoryStatusBadge('.untracked-count','Untracked',untrackedCount);
    updateRepositoryStatusBadge('.unstaged-header-count','Unstaged',unstagedHeaderCount);
    updateRepositoryStatusBadge('.staged-header-count','Staged',card.stagedFiles.length);
    const stagedList=el.querySelector('.staged-list');
    const unstagedList=el.querySelector('.unstaged-list');
    const stagedCount=el.querySelector('.staged-count');
    stagedCount.textContent=card.stagedFiles.length?String(card.stagedFiles.length):'';
    stagedCount.hidden=card.stagedFiles.length===0;
    el.querySelector('.staged-all').disabled=card.stagedFiles.length===0;
    const unstagedCount=el.querySelector('.unstaged-count');
    unstagedCount.textContent=card.unstagedFiles.length?String(card.unstagedFiles.length):'';
    unstagedCount.hidden=card.unstagedFiles.length===0;
    el.querySelector('.discard-all').disabled=card.unstagedFiles.length===0;
    el.querySelector('.stage-all').disabled=card.unstagedFiles.length===0;
    stagedList.replaceChildren();
    if(card.stagedFiles.length){
      card.stagedFiles.forEach(function(file){stagedList.appendChild(fileRowHtml(file,'staged'))});
    }else{
      const empty=document.createElement('div');
      empty.className='empty';
      empty.textContent='没有文件';
      stagedList.appendChild(empty);
    }
    unstagedList.replaceChildren();
    if(card.unstagedFiles.length){
      card.unstagedFiles.forEach(function(file){unstagedList.appendChild(fileRowHtml(file,'unstaged'))});
    }else{
      const empty=document.createElement('div');
      empty.className='empty';
      empty.textContent='没有文件';
      unstagedList.appendChild(empty);
    }
    bindRowActions(stagedList,el.dataset.repo,card);
    bindRowActions(unstagedList,el.dataset.repo,card);
  }

  function render(cards){
    if(!cards.length){
      app.innerHTML='<div class="no-repos">没有可提交的仓库</div>';
      cardEls.clear();
      vscode.postMessage({type:'rendered',cardCount:0});
      return;
    }
    const seen=new Set();
    let previous=null;
    cards.forEach(function(card){
      seen.add(card.repositoryPath);
      let el=cardEls.get(card.repositoryPath);
      if(!el){el=buildCard(card.repositoryPath);cardEls.set(card.repositoryPath,el)}
      updateCard(el,card);
      // 保持卡片顺序与快照一致, 复用已存在 DOM。
      if(previous){if(previous.nextSibling!==el)app.insertBefore(el,previous.nextSibling)}
      else if(app.firstChild!==el)app.insertBefore(el,app.firstChild);
      previous=el;
    });
    // 移除快照中已不存在的仓库卡片。
    cardEls.forEach(function(el,repo){if(!seen.has(repo)){el.remove();cardEls.delete(repo)}});
    vscode.postMessage({type:'rendered',cardCount:cards.length});
  }

  window.addEventListener('message',function(event){
    const message=event.data;
    if(!message)return;
    if(message.type==='snapshot'){render(message.cards||[])}
    else if(message.type==='setMessage'){
      const el=cardEls.get(message.repositoryPath);
      if(el){el._refs.messageInput.value=message.message||'';el._refs.hint.textContent='';el._refs.messageInput.focus()}
    }else if(message.type==='focus'){
      const el=cardEls.get(message.repositoryPath);
      if(el){selectCard(message.repositoryPath);el.scrollIntoView({behavior:'auto',block:'start'});el._refs.messageInput.focus()}
    }
  });

  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
    }
}
