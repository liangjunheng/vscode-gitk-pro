import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export interface CommitPanelFile {
    readonly path: string;
    readonly status: string;
    readonly isUntracked?: boolean;
    readonly isSubmodule?: boolean;
}

export interface CommitCardRepository {
    readonly path: string;
    readonly label: string;
    readonly hasSubmodules: boolean;
}

/** 单个仓库提交卡片数据。 */
export interface CommitCard {
    readonly repositoryPath: string;
    readonly repositoryLabel: string;
    readonly repositoryHasSubmodules: boolean;
    readonly repositoryIsSubmodule: boolean;
    readonly repositoryAncestry: readonly CommitCardRepository[];
    readonly amend: boolean;
    readonly committedFiles: readonly CommitPanelFile[];
    readonly committedFilesLoading: boolean;
    readonly stagedFiles: readonly CommitPanelFile[];
    readonly unstagedFiles: readonly CommitPanelFile[];
    readonly committing: boolean;
}

export interface CommitPanelSnapshot {
    readonly cards: readonly CommitCard[];
    readonly displayMode: 'tree' | 'flat';
}

type CommitPanelCallbacks = {
    readonly onCommit: (repositoryPath: string, message: string, amend: boolean) => void;
    readonly onPush: (repositoryPaths: readonly string[]) => void;
    readonly onToggleDisplayMode: () => void;
    readonly onToggleAmend: (repositoryPath: string, message: string) => void;
    readonly onHistory: (repositoryPath: string) => void;
    readonly onFocusRepository: (repositoryPath: string) => void;
    readonly onSelectFile: (repositoryPath: string, section: 'staged' | 'unstaged', path: string) => void;
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
        } else if (data.type === 'toggleAmend' && repo && typeof data.message === 'string') {
            this.callbacks.onToggleAmend(repo, data.message);
        } else if (data.type === 'gitSync' && data.action === 'push'
            && Array.isArray(data.repositoryPaths)
            && data.repositoryPaths.every(repositoryPath => typeof repositoryPath === 'string')) {
            this.callbacks.onPush(data.repositoryPaths as string[]);
        } else if (data.type === 'toggleDisplayMode') {
            this.callbacks.onToggleDisplayMode();
        } else if (data.type === 'history' && repo) {
            this.callbacks.onHistory(repo);
        } else if (data.type === 'focusRepository' && repo) {
            this.callbacks.onFocusRepository(repo);
        } else if (data.type === 'selectFile' && repo
            && (data.section === 'staged' || data.section === 'unstaged')
            && typeof data.path === 'string') {
            this.callbacks.onSelectFile(repo, data.section, data.path);
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
        this.post({ type: 'snapshot', cards: this.snapshot.cards, displayMode: this.snapshot.displayMode })
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
.repo-label{white-space:nowrap}
.repository-ancestry{display:inline-flex;align-items:center;gap:3px;min-width:0;color:var(--vscode-descriptionForeground);font-size:inherit;font-weight:400;opacity:.65}
.repository-ancestry[hidden]{display:none}
.repository-ancestry-link{border:0;padding:0;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.repository-ancestry-link:hover{text-decoration:underline;color:var(--vscode-textLink-foreground)}
.repository-ancestry-separator{opacity:.8}
.repository-icon{display:inline-flex;width:16px;height:16px;flex:0 0 16px;color:var(--vscode-icon-foreground)}
.repository-icon.has-submodules{color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-icon-foreground))}
.repository-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
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
.actions{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.hint{margin-right:auto;min-width:120px;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size) * .9)}
.action-groups{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.action-group{display:inline-flex;align-items:center;gap:6px;padding:3px 5px;border:1px solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:5px;background:var(--vscode-editorWidget-background)}
.commit-group{border-color:var(--vscode-button-background)}
.submodule-group{max-width:100%;overflow:hidden}
.commit-options{display:inline-flex;align-items:center;gap:8px}
.history-btn{border:0;padding:6px 8px;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;display:inline-flex;align-items:center;border-radius:4px}
.history-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
.history-btn .codicon{font-size:14px}
.submodule-selector{display:inline-flex;align-items:center;gap:8px;max-width:45vw;overflow:auto;white-space:nowrap}
.submodule-selector .commit-option{font-size:calc(var(--vscode-editor-font-size) * .9)}
.submodule-selector .submodule-all+span{font-weight:600}
.submodule-empty-text{color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-editor-font-size) * .85)}
.commit-option{display:inline-flex;align-items:center;gap:4px;color:var(--vscode-foreground);font-size:var(--vscode-editor-font-size);cursor:pointer;user-select:none}
.commit-option input{margin:0;accent-color:var(--vscode-button-background)}
.commit-option input:disabled+span{opacity:.5}
.commit-btn,.push-btn{border:0;border-radius:5px;padding:6px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font:inherit}
.commit-btn:hover,.push-btn:hover{background:var(--vscode-button-hoverBackground)}
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
.display-mode-btn{margin-left:4px}
.file-row,.folder-row{display:flex;align-items:center;gap:6px;padding:3px 10px}
.file-row:hover,.folder-row:hover{background:var(--vscode-list-hoverBackground)}
.file-row .status{width:14px;text-align:center;color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.file-row .path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(var(--vscode-editor-font-size) * .9)}
.file-row .file-folder{opacity:.55}
.file-row.staged .file-name{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.file-row.unstaged .file-name{color:var(--vscode-textLink-foreground,#3794ff)}
.file-row.untracked .file-name{color:var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c)}
.folder-row{cursor:pointer;font-weight:600}
.folder-row .codicon{font-size:14px}
.folder-row .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
  const collapsedFolders=new Set();
  let selectedRepositoryPath='';
  let displayMode='flat';
  let currentCards=[];
  const selectedSubmodules=new Set();

  function selectCard(repositoryPath){
    selectedRepositoryPath=repositoryPath;
    cardEls.forEach(function(card){card.classList.toggle('selected-card',card.dataset.repo===repositoryPath)});
  }

  function statusLabel(file){return file.isUntracked?'U':(file.status||'M').slice(0,1).toUpperCase()}
  function syncSelectedSubmoduleMessages(sourceRepo,message){
    cardEls.forEach(function(card,repositoryPath){
      if(repositoryPath===sourceRepo)return;
      const cardData=card._card;
      if(!cardData||!cardData.stagedFiles.some(function(file){return file.isSubmodule===true}))return;
      const selected=cardData.stagedFiles.some(function(file){return file.isSubmodule===true&&selectedSubmodules.has(repositoryPath+'\0'+file.path)});
      if(selected)card._refs.messageInput.value=message;
    });
  }
  function updatePushSelector(el,card){
    const selector=el.querySelector('.submodule-selector');
    selector.hidden=!card.repositoryHasSubmodules;
    const submodules=currentCards.filter(function(item){return item.repositoryIsSubmodule&&item.stagedFiles.length>0});
    selector.replaceChildren();
    if(!submodules.length){
      const empty=document.createElement('label');empty.className='commit-option submodule-empty';
      empty.innerHTML='<input class="submodule-all" type="checkbox" disabled><span>Submodule</span><span class="submodule-empty-text">暂无子模块变更</span>';
      selector.appendChild(empty);
      return;
    }
    const all=document.createElement('label');all.className='commit-option';
    all.innerHTML='<input class="submodule-all" type="checkbox"><span>Submodule</span>';
    const allInput=all.querySelector('input');
    const items=submodules.map(function(submodule){
      const label=document.createElement('label');label.className='commit-option';
      label.innerHTML='<input class="submodule-item" type="checkbox"><span></span>';
      label.querySelector('span').textContent=submodule.repositoryLabel;
      label.querySelector('input').checked=selectedSubmodules.has(submodule.repositoryPath);
      label.querySelector('input').dataset.path=submodule.repositoryPath;
      label.querySelector('input').addEventListener('change',function(){
        if(this.checked)selectedSubmodules.add(submodule.repositoryPath);else selectedSubmodules.delete(submodule.repositoryPath);
        allInput.checked=items.every(function(input){return input.checked});
        allInput.indeterminate=!allInput.checked&&items.some(function(input){return input.checked});
      });
      return label.querySelector('input');
    });
    allInput.checked=items.length>0&&items.every(function(input){return input.checked});
    allInput.indeterminate=!allInput.checked&&items.some(function(input){return input.checked});
    allInput.addEventListener('change',function(){items.forEach(function(input){input.checked=allInput.checked;input.dispatchEvent(new Event('change'))})});
    selector.appendChild(all);
    items.forEach(function(input){selector.appendChild(input.parentElement)});
  }

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
  function fileParts(file){
    const lastSlash=file.path.lastIndexOf('/');
    return {
      folder:lastSlash>=0?file.path.slice(0,lastSlash):'',
      name:lastSlash>=0?file.path.slice(lastSlash+1):file.path,
    };
  }

  function fileRowHtml(file,section,treeIndent){
    const parts=fileParts(file);
    const row=document.createElement('div');
    row.className='file-row '+(file.isUntracked?'untracked':section);
    row.dataset.path=file.path;
    row.dataset.section=section;
    if(treeIndent)row.style.paddingLeft='30px';
    const status=document.createElement('span');
    status.className='status';
    status.textContent=statusLabel(file);
    const pathElement=document.createElement('span');
    pathElement.className='path';
    pathElement.title=file.path;
    const nameElement=document.createElement('span');
    nameElement.className='file-name';
    nameElement.textContent=parts.name;
    pathElement.appendChild(nameElement);
    if(displayMode==='flat'&&parts.folder){
      pathElement.appendChild(document.createTextNode(' '));
      const folderElement=document.createElement('span');
      folderElement.className='file-folder';
      folderElement.textContent=parts.folder+'/';
      pathElement.appendChild(folderElement);
    }
    const actions=document.createElement('span');
    actions.className='row-actions';
    if(section==='staged'){
      actions.appendChild(actionButton('unstage',section,file.path,'remove','取消暂存'));
    }else if(section==='unstaged'){
      actions.appendChild(actionButton('discard',section,file.path,'discard','放弃更改'));
      actions.appendChild(actionButton('stage',section,file.path,'add','暂存'));
    }
    row.appendChild(status);
    row.appendChild(pathElement);
    row.appendChild(actions);
    return row;
  }

  function renderFileList(container,files,section,repositoryPath){
    container.replaceChildren();
    if(!files.length){
      const empty=document.createElement('div');
      empty.className='empty';
      empty.textContent='没有文件';
      container.appendChild(empty);
      return;
    }
    const ordered=files;
    if(displayMode==='flat'){
      ordered.forEach(function(file){container.appendChild(fileRowHtml(file,section,false))});
      return;
    }
    const byFolder=new Map();
    ordered.forEach(function(file){
      const folder=fileParts(file).folder;
      const group=byFolder.get(folder)||[];
      group.push(file);
      byFolder.set(folder,group);
    });
    byFolder.forEach(function(folderFiles,folder){
      const folderKey=repositoryPath+':'+section+':'+folder;
      if(folder){
        const expanded=!collapsedFolders.has(folderKey);
        const folderRow=document.createElement('div');
        folderRow.className='folder-row';
        folderRow.innerHTML='<span class="codicon codicon-chevron-'+(expanded?'down':'right')+'"></span><span class="codicon codicon-folder'+(expanded?'-opened':'')+'"></span><span class="path"></span>';
        folderRow.querySelector('.path').textContent=folder;
        folderRow.title=folder;
        folderRow.addEventListener('click',function(){
          if(expanded)collapsedFolders.add(folderKey);else collapsedFolders.delete(folderKey);
          renderFileList(container,files,section,repositoryPath);
          bindRowActions(container,repositoryPath,container.closest('.card')._card);
        });
        container.appendChild(folderRow);
        if(!expanded)return;
      }
      folderFiles.forEach(function(file){container.appendChild(fileRowHtml(file,section,Boolean(folder)))});
    });
  }

  function buildCard(repo){
    const el=document.createElement('div');
    el.className='card';
    el.dataset.repo=repo;
    el.innerHTML=
      '<div class="card-header"><span class="codicon codicon-chevron-down card-chevron"></span><span class="repository-icon card-repository-icon" aria-hidden="true"></span><span class="repo-label"></span><span class="repository-ancestry" hidden></span><span class="repository-status-badge untracked-count"></span><span class="repository-status-badge unstaged-header-count"></span><span class="repository-status-badge staged-header-count"></span><span class="card-empty-tag"></span></div>'+
      '<div class="card-body">'+
        '<div class="message-box">'+
          '<textarea class="message-input" placeholder="输入提交信息…" spellcheck="false"></textarea>'+
        '</div>'+
        '<div class="section unstaged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down unstaged-chevron"></span><span>Unstaged Changes</span><span class="section-count-badge unstaged-count" hidden></span></span><span class="section-actions unstaged-actions"><button class="icon-btn discard-all" data-action="discard" data-section="unstaged" title="还原所有文件"><span class="codicon codicon-discard"></span></button><button class="icon-btn stage-all" data-action="stage" data-section="unstaged" title="暂存所有文件"><span class="codicon codicon-add"></span></button></span></div><div class="unstaged-list"></div></div>'+
        '<div class="section staged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down staged-chevron"></span><span>Staged Changes</span><span class="section-count-badge staged-count" hidden></span></span><span class="section-actions staged-actions"><button class="icon-btn display-mode-btn" title="切换树状/平铺显示"><span class="codicon codicon-list-tree"></span></button><button class="icon-btn staged-all" data-action="unstage" data-section="staged" title="取消暂存所有文件"><span class="codicon codicon-remove"></span></button></span></div><div class="staged-list"></div></div>'+
        '<div class="section committed" hidden><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down committed-chevron"></span><span>Committed Changes</span><span class="section-count-badge committed-count" hidden></span></span></div><div class="committed-list"></div></div>'+
        '<div class="actions">'+
          '<span class="hint"></span>'+
          '<button class="history-btn" title="历史提交信息"><span class="codicon codicon-history"></span></button>'+
          '<div class="action-groups">'+
            '<span class="action-group commit-group">'+
              '<label class="commit-option"><input class="amend-checkbox" type="checkbox"><span>Amend</span></label>'+
              '<button class="commit-btn">Commit</button>'+
            '</span>'+
            '<span class="action-group submodule-group">'+
              '<span class="submodule-selector"></span>'+
              '<button class="push-btn">Push</button>'+
            '</span>'+
          '</div>'+
        '</div>'+
      '</div>';
    const state={unstagedOpen:true,stagedOpen:true,committedOpen:true};
    const messageInput=el.querySelector('.message-input');
    const commitBtn=el.querySelector('.commit-btn');
    const pushBtn=el.querySelector('.push-btn');
    const amendCheckbox=el.querySelector('.amend-checkbox');
    const historyBtn=el.querySelector('.history-btn');
    const hint=el.querySelector('.hint');
    const unstagedTitle=el.querySelector('.section.unstaged .section-title');
    const unstagedList=el.querySelector('.unstaged-list');
    const unstagedChevron=el.querySelector('.unstaged-chevron');
    const stagedTitle=el.querySelector('.section.staged .section-title');
    const stagedList=el.querySelector('.staged-list');
    const stagedChevron=el.querySelector('.staged-chevron');
    const committedTitle=el.querySelector('.section.committed .section-title');
    const committedList=el.querySelector('.committed-list');
    const committedChevron=el.querySelector('.committed-chevron');
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

    amendCheckbox.addEventListener('change',function(){vscode.postMessage({type:'toggleAmend',repositoryPath:repo,message:messageInput.value})});
    pushBtn.addEventListener('click',function(){
      vscode.postMessage({type:'gitSync',action:'push',repositoryPaths:Array.from(selectedSubmodules)});
    });
    historyBtn.addEventListener('click',function(){vscode.postMessage({type:'history',repositoryPath:repo})});
    el.querySelector('.display-mode-btn').addEventListener('click',function(event){
      event.stopPropagation();
      vscode.postMessage({type:'toggleDisplayMode'});
    });
    el.querySelectorAll('.section-actions .icon-btn[data-action]').forEach(function(button){
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
    messageInput.addEventListener('input',function(){hint.textContent='';syncSelectedSubmoduleMessages(repo,messageInput.value)});
    messageInput.addEventListener('keydown',function(event){
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();commitBtn.click()}
    });
    function bindSection(title,list,chevron,key){
      title.addEventListener('click',function(event){
        event.stopPropagation();
        state[key]=!state[key];
        list.hidden=!state[key];
        chevron.className='codicon codicon-chevron-'+(state[key]?'down':'right')+' '+key.replace('Open','')+'-chevron';
      });
    }
    bindSection(unstagedTitle,unstagedList,unstagedChevron,'unstagedOpen');
    bindSection(stagedTitle,stagedList,stagedChevron,'stagedOpen');
    bindSection(committedTitle,committedList,committedChevron,'committedOpen');

    state.cardCollapsed=false;
    el._state=state;
    el._refs={messageInput,commitBtn,pushBtn,amendCheckbox,hint,unstagedList,stagedList,committedList,unstagedChevron,stagedChevron,committedChevron,cardChevron,cardBody,cardHeader};
    return el;
  }

  function bindRowActions(container,repo,card){
    container.querySelectorAll('.file-row').forEach(function(row){
      row.addEventListener('click',function(){
        vscode.postMessage({type:'selectFile',repositoryPath:repo,section:row.dataset.section,path:row.dataset.path});
      });
    });
    container.querySelectorAll('.icon-btn').forEach(function(btn){
      btn.addEventListener('click',function(event){
        event.stopPropagation();
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
    const repositoryIcon=el.querySelector('.card-repository-icon');
    repositoryIcon.classList.toggle('has-submodules',card.repositoryHasSubmodules);
    repositoryIcon.innerHTML=card.repositoryHasSubmodules
      ? '<svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/><rect x="5" y="7.5" width="6" height="3.5" rx="0.5"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M2 4.5h4.5L8 6h6v5.5H2z"/></svg>';
    el.querySelector('.repo-label').textContent=card.repositoryLabel;
    const ancestry=el.querySelector('.repository-ancestry');
    ancestry.replaceChildren();
    card.repositoryAncestry.forEach(function(repository,index){
      if(index===0){
        const marker=document.createElement('span');
        marker.className='repository-ancestry-marker';
        marker.textContent='⌘';
        ancestry.appendChild(marker);
      }
      if(index>0){
        const separator=document.createElement('span');
        separator.className='repository-ancestry-separator';
        separator.textContent='/';
        ancestry.appendChild(separator);
      }
      const link=document.createElement('button');
      link.type='button';
      link.className='repository-ancestry-link';
      link.textContent=repository.label;
      link.title='跳转到 '+repository.label+' 的提交卡片';
      link.addEventListener('click',function(event){
        event.stopPropagation();
        vscode.postMessage({type:'focusRepository',repositoryPath:repository.path});
      });
      ancestry.appendChild(link);
    });
    if(card.repositoryAncestry.length){
      const trailingSeparator=document.createElement('span');
      trailingSeparator.className='repository-ancestry-separator';
      trailingSeparator.textContent='/';
      ancestry.appendChild(trailingSeparator);
    }
    ancestry.hidden=card.repositoryAncestry.length===0;
    const refs=el._refs;
    el.classList.toggle('selected-card',el.dataset.repo===selectedRepositoryPath);
    const isEmpty=card.stagedFiles.length===0&&card.unstagedFiles.length===0;
    refs.amendCheckbox.checked=card.amend;
    refs.amendCheckbox.disabled=false;
    refs.commitBtn.textContent=card.amend?'Amend':'Commit';
    const disableCommit=card.committing;
    refs.commitBtn.disabled=disableCommit;
    refs.pushBtn.disabled=false;
    refs.hint.textContent=card.committing?'正在提交…':(isEmpty?'变更文件为空，无需提交':'');
    el._collapsible=isEmpty;
    el.querySelector('.card-empty-tag').textContent=isEmpty?'无更改':'';
    el.classList.toggle('collapsible-card',isEmpty);
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
    const committedSection=el.querySelector('.section.committed');
    const committedList=el.querySelector('.committed-list');
    const committedCount=el.querySelector('.committed-count');
    committedSection.hidden=!card.amend;
    if(card.amend){
      committedCount.textContent=card.committedFiles.length?String(card.committedFiles.length):'';
      committedCount.hidden=card.committedFiles.length===0;
      if(card.committedFilesLoading){
        committedList.innerHTML='<div class="empty">正在加载当前提交的文件…</div>';
      }else{
        renderFileList(committedList,card.committedFiles,'committed',el.dataset.repo);
      }
      committedList.hidden=!el._state.committedOpen;
      refs.committedChevron.className='codicon codicon-chevron-'+(el._state.committedOpen?'down':'right')+' committed-chevron';
    }
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
    const displayModeButton=el.querySelector('.display-mode-btn');
    displayModeButton.title='显示方式（当前：'+(displayMode==='tree'?'树状':'平铺')+'）';
    displayModeButton.querySelector('.codicon').className='codicon codicon-'+(displayMode==='tree'?'list-flat':'list-tree');
    renderFileList(stagedList,card.stagedFiles,'staged',el.dataset.repo);
    renderFileList(unstagedList,card.unstagedFiles,'unstaged',el.dataset.repo);
    stagedList.hidden=!el._state.stagedOpen;
    unstagedList.hidden=!el._state.unstagedOpen;
    refs.stagedChevron.className='codicon codicon-chevron-'+(el._state.stagedOpen?'down':'right')+' staged-chevron';
    refs.unstagedChevron.className='codicon codicon-chevron-'+(el._state.unstagedOpen?'down':'right')+' unstaged-chevron';
    updatePushSelector(el,card);
    bindRowActions(stagedList,el.dataset.repo,card);
    bindRowActions(unstagedList,el.dataset.repo,card);
  }

  function render(cards){
    currentCards=cards;
    const validSubmodules=new Set(cards.filter(function(card){return card.repositoryIsSubmodule&&card.stagedFiles.length>0}).map(function(card){return card.repositoryPath}));
    selectedSubmodules.forEach(function(repositoryPath){if(!validSubmodules.has(repositoryPath))selectedSubmodules.delete(repositoryPath)});
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
    if(message.type==='snapshot'){displayMode=message.displayMode;render(message.cards||[])}
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
