import * as vscode from 'vscode';
import type { DiffPayload } from '../types';
import { store } from '../state/store';
import { MONACO_DIFF_LANGUAGES, MONACO_DIFF_OPTIONS } from './monacoDiffConfig';

type DiffSnapshot = {
    type: 'snapshot';
    revision: number;
    loading: boolean;
    completed: number;
    total: number;
    error?: string;
    revealPath?: string;
    // changes 虚拟提交对比的是工作区文件, 右侧允许编辑并回写。
    editable: boolean;
    diffs: Array<Omit<DiffPayload, 'equals'> & { editable?: boolean }>;
};

// 单一 Webview 接收 Store 的原子完整快照，并为每个文件创建一套共享 Monaco Diff 配置。
export class MultiDiffPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private webviewReady = false;
    private revision = 0;
    private revealPath?: string;
    private postQueue: Promise<unknown> = Promise.resolve();
    private readonly unsubscribers: (() => void)[];

    constructor(
        private readonly onSelectFile?: (path: string, generation: number) => void,
        private readonly onRendered?: () => void,
        private readonly onOpenFileAtLine?: (path: string, line?: number, column?: number, side?: 'original' | 'modified') => void,
        private readonly onSaveFile?: (path: string, content: string) => void,
    ) {
        this.unsubscribers = [
            store.subscribeSelector(state => state.diffLoading, () => this.publish()),
            store.subscribeSelector(state => state.diffError, () => this.publish()),
            store.subscribeSelector(state => state.files, () => this.publish()),
            store.subscribeSelector(state => state.diffProgress, () => this.publish()),
        ];
    }

    // 打开(必要时创建)面板并定位; 新建或未就绪时发完整快照, 否则只做定位。
    show(hash: string, revealPath?: string): void {
        const isNewPanel = !this.panel;
        this.ensurePanel();
        // 标题仅在提交变化时更新, 避免重复写入面板属性。
        const title = `Gitk Diff (${hash.slice(0, 8)})`;
        if (this.panel!.title !== title) { this.panel!.title = title; }
        this.panel!.reveal(this.panel!.viewColumn ?? vscode.ViewColumn.Active, false);
        this.revealPath = revealPath;
        // 已渲染的面板只做定位，避免重建全部 Monaco 编辑器；卡片重建仅由 Store 快照驱动。
        if (isNewPanel || !this.webviewReady) { this.publish(); return; }
        this.post({ type: 'reveal', path: revealPath });
    }

    // 已渲染面板的轻量定位: 只发 reveal, 不 ensurePanel / 不改标题 / 不抢焦点。
    // 返回 false 表示面板不可用, 调用方需回退到 show()。
    revealFile(revealPath?: string): boolean {
        if (!this.panel || !this.webviewReady) { return false; }
        this.revealPath = revealPath;
        this.post({ type: 'reveal', path: revealPath });
        return true;
    }

    // 推进 generation 使在途 DiffReader 失效；新 Store 快照由订阅自动发布。
    cancelPending(): void {
        store.setState({
            diffGeneration: store.getState().diffGeneration + 1,
            diffLoading: false,
            diffError: undefined,
            diffProgress: { completed: 0, total: 0 },
        });
    }

    hide(): void { this.panel?.dispose(); }

    dispose(): void {
        this.unsubscribers.forEach(unsubscribe => unsubscribe());
        this.panel?.dispose();
    }

    private ensurePanel(): void {
        if (this.panel) { return; }
        this.webviewReady = false;
        this.postQueue = Promise.resolve();
        const monacoRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..', 'media', 'monaco');
        this.panel = vscode.window.createWebviewPanel('vscode-gitk.multiDiff', 'Gitk Diff', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [monacoRoot],
        });
        this.panel.webview.onDidReceiveMessage(message => {
            if (message?.type === 'ready') {
                this.webviewReady = true;
                this.publish();
            } else if (message?.type === 'selectFile' && typeof message.path === 'string') {
                // 顶部卡片变化时同步 Changed Files 高亮。
                this.revealPath = message.path;
                this.onSelectFile?.(message.path, store.getState().diffGeneration);
            } else if (message?.type === 'saveFile' && typeof message.path === 'string' && typeof message.content === 'string') {
                this.onSaveFile?.(message.path, message.content);
            } else if (message?.type === 'openFileAtLine' && typeof message.path === 'string') {
                // line 缺省表示标题栏按钮触发, 只打开文件不定位。
                const line = typeof message.line === 'number' ? message.line : undefined;
                const column = typeof message.column === 'number' ? message.column : undefined;
                        const side = message.side === 'original' || message.side === 'modified' ? message.side : undefined;
                this.onOpenFileAtLine?.(message.path, line, column, side);
            } else if (message?.type === 'rendered') {
                // Diff 卡片与行号渲染完成, 通知 Provider 放行 Changed Files 列表。
                this.onRendered?.();
            } else if (message?.type === 'error') {
                console.error('[gitk-multi-diff]', message.message);
            } else if (message?.type === 'log') {
                console.log('[gitk-multi-diff]', message.message);
            }
        });
        // 面板被关闭后不会再有渲染完成信号, 通知 Provider 兜底放行 Changed Files 列表。
        this.panel.onDidDispose(() => { this.panel = undefined; this.webviewReady = false; this.onRendered?.(); });
        this.panel.webview.html = this.getHtml(monacoRoot);
    }

    private publish(): void {
        if (!this.panel || !this.webviewReady) { return; }
        const state = store.getState();
        const diffs = state.files
            .filter((file): file is DiffPayload => 'original' in file && 'modified' in file)
            .map(file => ({
                ...file,
                editable: state.currentChangeSet === 'changes'
                    || (state.currentChangeSet === 'uncommitted' && file.workingTreeKind !== 'staged'),
            }));
        const snapshot: DiffSnapshot = {
            type: 'snapshot',
            revision: ++this.revision,
            // 与 CustomDiffPanel 一致：只由 Store 的 diffLoading 决定加载态；完成空快照也必须结束 loading。
            loading: state.diffLoading,
            completed: state.diffProgress.completed,
            total: state.diffProgress.total,
            error: state.diffError,
            revealPath: this.revealPath ?? state.selectedPath,
            // changes 与 uncommitted 的右侧都是工作区文件本身，允许编辑并回写。
            editable: state.currentChangeSet === 'changes' || state.currentChangeSet === 'uncommitted',
            diffs,
        };
        console.log(`[gitk-multi-diff] publish #${snapshot.revision}: loading=${snapshot.loading}, progress=${snapshot.completed}/${snapshot.total}, diffs=${snapshot.diffs.length}, error=${snapshot.error ?? 'none'}`);
        this.post(snapshot);
    }

    private post(message: unknown): void {
        this.postQueue = this.postQueue
            .catch(() => undefined)
            .then(() => this.panel?.webview.postMessage(message));
    }

    private getHtml(monacoRoot: vscode.Uri): string {
        const webview = this.panel!.webview;
        const monacoUri = webview.asWebviewUri(vscode.Uri.joinPath(monacoRoot, 'vs'));
        const nonce = String(Date.now());
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval'; worker-src ${webview.cspSource}; font-src ${webview.cspSource};"><style>
/* 吸顶组与文件顶部高亮轮廓对齐，不额外向上偏移。
   --header-cover-bleed 控制标题栏背后不透明盖板向上及向两侧的延展。 */
:root{color-scheme:light dark;--header-surface:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground));--card-radius:9px;--card-border:1px;--card-ring:1px;--header-gap:0px;--header-inset:0px;--header-cover-bleed:8px}
*{box-sizing:border-box}
/* 不要给 html/body 设 overflow 或 min-height: 那会改变滚动容器归属, 使 window.scrollY /
   window 的 scroll 事件失效, 并让 sticky 的参照系偏移导致标题栏无法吸顶。保持文档视口滚动。 */
body{margin:0;background:color-mix(in srgb, var(--vscode-editor-background) 50%, #000);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
#loading{min-height:100vh;display:grid;place-items:center;color:var(--vscode-descriptionForeground)}
#loading[hidden]{display:none}
#list{width:100%;padding:8px}
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
.working-tree-kind-untracked{color:var(--vscode-gitDecoration-untrackedResourceForeground,var(--vscode-gitDecoration-deletedResourceForeground,#f14c4c))}
.working-tree-kind-untracked .kind-file{stroke-dasharray:1.6 1.6}
.working-tree-kind-unstaged{color:var(--vscode-foreground)}
.working-tree-kind-staged{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.status{flex:0 0 auto;width:14px;text-align:center;font-weight:600}
.status-A{color:var(--vscode-gitDecoration-addedResourceForeground)}
.status-M{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.status-D{color:var(--vscode-gitDecoration-deletedResourceForeground)}
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
.pinned-group{position:sticky;top:calc(var(--header-gap) + var(--header-inset));z-index:2;margin-top:calc((var(--card-border) + var(--card-ring)) * -1);margin-right:calc((var(--card-border) + var(--card-ring)) * -1);margin-bottom:0;margin-left:calc((var(--card-border) + var(--card-ring)) * -1);border-top:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-right:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-left:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;background:var(--vscode-editorWidget-background,var(--vscode-tab-activeBackground));box-shadow:0 1px 3px rgba(0,0,0,.18)}
/* 独立标题层在 pinned 组内建立完整的遮罩层叠上下文: 盖板覆盖相邻 diff 内容和其 box-shadow 高亮，
   但低于标题内容与 pinned 轮廓。底边严格等于标题栏底边，上/左/右外延 8px。 */
.diff.selected>.pinned-group{border-color:var(--vscode-focusBorder)}
.header-layer{position:relative;z-index:1}
.header-layer::before{content:'';position:absolute;z-index:0;top:calc(var(--header-cover-bleed) * -1);right:calc(var(--header-cover-bleed) * -1);bottom:0;left:calc(var(--header-cover-bleed) * -1);background:var(--vscode-editor-background);pointer-events:none}
.header-row{position:relative;z-index:1;display:flex;align-items:stretch}
.header-row>.file-header,.header-row>.open-file{position:relative;z-index:1}
/* 轮廓层位于盖板上方：向外延展高亮总宽度，和底层卡片的三边高亮线无缝连接。 */
.pinned-group::after{content:'';position:absolute;z-index:3;top:calc((var(--card-border) + var(--card-ring)) * -1);right:calc((var(--card-border) + var(--card-ring)) * -1);bottom:0;left:calc((var(--card-border) + var(--card-ring)) * -1);border-top:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-right:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-left:calc(var(--card-border) + var(--card-ring)) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));border-radius:var(--card-radius) var(--card-radius) 0 0;pointer-events:none}
.diff.selected>.pinned-group::after{border-color:var(--vscode-focusBorder)}
.header-row>.file-header{flex:1 1 auto;min-width:0;border-radius:calc(var(--card-radius) - var(--card-border) - var(--card-ring)) 0 0 0}
.header-row>.open-file{border-radius:0 calc(var(--card-radius) - var(--card-border) - var(--card-ring)) 0 0}
.diff.collapsed>.pinned-group{border-radius:var(--card-radius)}
.diff.collapsed>.pinned-group>.header-layer>.header-row>.file-header{border-radius:calc(var(--card-radius) - var(--card-border) - var(--card-ring)) 0 0 calc(var(--card-radius) - var(--card-border) - var(--card-ring))}
.diff.collapsed>.pinned-group>.header-layer>.header-row>.open-file{border-radius:0 calc(var(--card-radius) - var(--card-border) - var(--card-ring)) calc(var(--card-radius) - var(--card-border) - var(--card-ring)) 0}
.open-file{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:26px;padding:0;color:var(--vscode-icon-foreground,currentColor);background:var(--header-surface);border:0;cursor:pointer}
.open-file:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
.open-file:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.open-file svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.diff.collapsed .open-file{border-bottom-color:transparent}
/* 标题栏下方的 git 元信息行: index <old>..<new> <mode> 以及重命名来源。 */
.file-meta{position:relative;z-index:1;display:flex;flex-direction:column;gap:1px;padding:0 8px 4px;border-bottom:var(--card-border) solid var(--vscode-widget-border,var(--vscode-editorGroup-border));color:var(--vscode-descriptionForeground);background:var(--header-surface);font-family:var(--vscode-editor-font-family,monospace);font-size:calc(var(--vscode-editor-font-size) * .85);line-height:1.45}
.diff.collapsed>.pinned-group>.file-meta{display:none}
.meta-line{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.meta-rename-from{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.meta-rename-to{color:var(--vscode-gitDecoration-addedResourceForeground)}
.diff-body{border-radius:0 0 calc(var(--card-radius) - var(--card-border)) calc(var(--card-radius) - var(--card-border));overflow:hidden}
.diff.collapsed>.diff-body{display:none}
.editor{width:100%;min-width:0;height:80px}
.empty{padding:16px 8px;color:var(--vscode-descriptionForeground);text-align:center}
.gitk-diff-link-hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;cursor:pointer}
</style></head><body><div id="loading">正在准备 Diff...</div><main id="list" hidden></main><script nonce="${nonce}">window.gitkQueue=[];window.addEventListener('message',event=>window.gitkQueue.push(event.data));window.gitkVscode=acquireVsCodeApi();</script><script nonce="${nonce}" src="${monacoUri}/loader.js"></script><script nonce="${nonce}">
self.MonacoEnvironment={getWorker:()=>new Worker('${monacoUri}/base/worker/workerMain.js')};
const loading=document.getElementById('loading'),list=document.getElementById('list'),languages=${JSON.stringify(MONACO_DIFF_LANGUAGES)},diffOptions=${JSON.stringify(MONACO_DIFF_OPTIONS)};
const report=message=>{try{window.gitkVscode.postMessage({type:'error',message})}catch(_){}};
const log=message=>{try{window.gitkVscode.postMessage({type:'log',message})}catch(_){}};
const notifyRendered=revision=>{try{window.gitkVscode.postMessage({type:'rendered',revision})}catch(_){}};
let monacoReady=false,lastRevision=0,pending,cards=[],cardByPath=new Map(),activePath='',suppressSyncUntil=0,scrollAnimationFrame=0,renderToken=0,editable=false,virtualFrame=0,editorPool=[];
function diffKey(diff){return diff.diffKey||diff.path}
const SCROLL_DURATION=150,MAX_IDLE_EDITORS=6;
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
    const editor=monaco.editor.createDiffEditor(host,Object.assign({},diffOptions,{readOnly:!editable}));
    applyVsCodeFont(editor);return {host:host,editor:editor,owner:null,generation:0};
  }();
  slot.owner=entry;slot.generation++;entry.body.replaceChildren(slot.host);return slot;
}
function disposeEntry(entry){
  entry.mountVersion++;
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
  if(!entry.collapsed&&!entry.staticContent){entry.body.replaceChildren();entry.body.style.height=Math.max(80,entry.bodyHeight||80)+'px'}
}
function dispose(){
  renderToken++;
  if(virtualFrame){cancelAnimationFrame(virtualFrame);virtualFrame=0}
  for(const entry of cards)disposeEntry(entry);
  while(editorPool.length)destroySlot(editorPool.pop());
  cards=[];cardByPath=new Map();activePath='';list.replaceChildren()
}
function language(path){const ext=path.slice(path.lastIndexOf('.')+1).toLowerCase();return languages[ext]||'plaintext'}
function escapeHtml(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function pathHtml(path,deleted){const slash=path.lastIndexOf('/');const name=slash<0?path:path.slice(slash+1),folder=slash<0?'':path.slice(0,slash+1);return '<span class="file-location'+(deleted?' is-deleted':'')+'" title="'+escapeHtml(path)+'"><span class="file-name">'+escapeHtml(name)+'</span>'+(folder?'<span class="file-path-gap"> </span><span class="file-folder">'+escapeHtml(folder)+'</span>':'')+'</span>'}
function statusHtml(status){return '<span class="status status-'+escapeHtml(status)+'">'+escapeHtml(status)+'</span>'}
function workingTreeKindHtml(kind){
  if(kind==='staged')return '<span class="working-tree-kind working-tree-kind-staged" title="Staged：已暂存" aria-label="Staged：已暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="m5.8 9 2.1 2.1 4.35-4.45" stroke-width="2"/></svg></span>';
  if(kind==='untracked')return '<span class="working-tree-kind working-tree-kind-untracked" title="Untracked：未跟踪" aria-label="Untracked：未跟踪"><svg viewBox="0 0 18 18" aria-hidden="true"><circle class="kind-file" cx="9" cy="9" r="6.25"/><path d="M7.15 7.15c.15-2.1 3.85-2.15 3.85.15 0 1.55-2 1.65-2 3.15M9 12.75v.1" stroke-width="1.7"/></svg></span>';
  if(kind==='unstaged')return '<span class="working-tree-kind working-tree-kind-unstaged" title="Unstaged：未暂存" aria-label="Unstaged：未暂存"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.25"/><path d="M9 5.25v4.5M9 12.4v.1" stroke-width="2"/></svg></span>';
  return '';
}
function headerHtml(diff){const chevron='<svg class="diff-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 5.5 5 5 5-5"/></svg>';const kind=workingTreeKindHtml(diff.workingTreeKind);const stats='<span class="line-stats"><span class="line-stat-added"></span><span class="line-stat-removed"></span></span>';const renamed=diff.status==='R'&&diff.oldPath&&diff.oldPath!==diff.path;const leftPath=renamed?diff.oldPath:diff.path;const left=chevron+kind+stats+statusHtml(diff.status)+pathHtml(leftPath,diff.status==='D'||renamed);if(!renamed)return '<span class="title-side title-side-left">'+left+'</span>';return '<span class="title-side title-side-left">'+left+'</span><span class="title-side title-side-right">'+statusHtml(diff.status)+pathHtml(diff.path,false)+'</span>'}
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
function createCardShell(diff,order,parent){
  const key=diffKey(diff),card=document.createElement('section');card.className='diff';card.dataset.path=diff.path;card.dataset.diffKey=key;card.dataset.index=String(order);
  const pinnedGroup=document.createElement('div');pinnedGroup.className='pinned-group';
  // 独立标题层: 盖板与标题栏同高, 盖板位于标题内容下方但可跨出标题栏 8px 覆盖相邻卡片。
  const headerLayer=document.createElement('div');headerLayer.className='header-layer';
  const headerRow=document.createElement('div');headerRow.className='header-row';
  const header=document.createElement('button');header.type='button';header.className='file-header'+(diff.status==='R'&&diff.oldPath&&diff.oldPath!==diff.path?' rename-header':'');header.innerHTML=headerHtml(diff);
  const openFile=document.createElement('button');openFile.type='button';openFile.className='open-file';
  openFile.title='在编辑器中打开文件';openFile.setAttribute('aria-label','在编辑器中打开文件');
  openFile.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 8 8"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>';
  const body=document.createElement('div');body.className='diff-body';
  headerRow.append(header,openFile);
  headerLayer.append(headerRow);
  const meta=document.createElement('div');meta.className='file-meta';meta.innerHTML=metaHtml(diff);
  pinnedGroup.append(headerLayer,meta);
  card.append(pinnedGroup,body);parent.append(card);
  const entry={diff:diff,index:order,path:key,filePath:diff.path,card:card,header:header,pinnedGroup:pinnedGroup,body:body,slot:null,editor:null,original:null,modified:null,modifiedValue:diff.modified||'',originalSelections:null,modifiedSelections:null,bodyHeight:estimateBodyHeight(diff),collapsed:false,staticContent:false,mounted:false,mounting:false,mountVersion:0,saveTimer:0,disposables:[],fit:function(){}};
  header.addEventListener('click',function(){toggle(entry)});
  // 标题栏右侧直接打开工作区文件, 不带行号定位。
  openFile.addEventListener('click',function(event){
    event.stopPropagation();
    try{window.gitkVscode.postMessage({type:'openFileAtLine',path:diff.path})}catch(_){}
  });
  cards.push(entry);cardByPath.set(key,entry);
  if(diff.error||diff.isBinary){
    const message=document.createElement('div');message.className='empty';
    message.textContent=diff.error?('无法读取此文件：'+diff.error):'二进制文件不同，无法显示文本差异。';
    body.append(message);entry.staticContent=true;return entry;
  }
  body.style.height=entry.bodyHeight+'px';
  return entry;
}
// 为可视逻辑项借用 Monaco 模板；离屏后归还对象池并保留等高占位。
function mountEntry(entry){
  if(entry.staticContent||entry.collapsed||entry.mounted||entry.mounting)return Promise.resolve();
  entry.mounting=true;entry.mountVersion++;
  const mountVersion=entry.mountVersion,diff=entry.diff;
  entry.body.style.height='';
  const slot=acquireSlot(entry),host=slot.host,editor=slot.editor;
  let original,modified;
  try{
    original=monaco.editor.createModel(diff.original||'',language(diff.path));
    modified=monaco.editor.createModel(entry.modifiedValue,language(diff.path));
    // changes 模式右侧即工作区文件, 允许编辑; 其余模式(commit/staged)保持只读。
    const entryEditable=diff.editable===true;
    editor.updateOptions(Object.assign({},diffOptions,{readOnly:!entryEditable}));
    editor.setModel({original:original,modified:modified});
    if(entry.originalSelections)editor.getOriginalEditor().setSelections(entry.originalSelections);
    if(entry.modifiedSelections)editor.getModifiedEditor().setSelections(entry.modifiedSelections);
    if(entryEditable){
      // 仅工作区一侧允许编辑回写，Staged 卡片保持只读。
      entry.disposables.push(modified.onDidChangeContent(function(){
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
  const fit=function(){
    if(entry.collapsed||entry.mountVersion!==mountVersion)return;
    const left=editor.getOriginalEditor(),right=editor.getModifiedEditor();
    const nextHeight=Math.ceil(Math.max(80,left.getContentHeight(),right.getContentHeight()));
    const width=host.clientWidth||Math.max(0,window.innerWidth-18);
    const delta=nextHeight-entry.bodyHeight;
    const aboveViewport=entry.card.getBoundingClientRect().bottom<=0;
    entry.bodyHeight=nextHeight;entry.body.style.height='';host.style.height=entry.bodyHeight+'px';
    editor.layout({width:Math.ceil(width),height:entry.bodyHeight});
    // 视口上方项目高度变化时补偿外层滚动，保持用户当前看到的内容不跳动。
    if(delta&&aboveViewport)window.scrollTo({top:Math.max(0,window.scrollY+delta),behavior:'auto'});
    scheduleVirtualization();
  };
  entry.disposables.push(editor.onDidUpdateDiff(function(){fit();updateLineStats(entry)}));
  entry.disposables.push(editor.getOriginalEditor().onDidContentSizeChange(fit));
  entry.disposables.push(editor.getModifiedEditor().onDidContentSizeChange(fit));
  entry.slot=slot;entry.editor=editor;entry.original=original;entry.modified=modified;entry.fit=fit;entry.mounted=true;entry.mounting=false;
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
  entry.body.replaceChildren(notice);
  report('card '+entry.path+' failed: '+message);
}
function toggle(entry){
  entry.collapsed=!entry.collapsed;
  entry.card.classList.toggle('collapsed',entry.collapsed);
  if(entry.collapsed)disposeEntry(entry);else scheduleVirtualization();
  setActive(entry.path,true);
}
function setActive(path,notify){
  if(activePath===path)return;
  activePath=path;
  for(const entry of cards)entry.card.classList.toggle('selected',entry.path===path);
  if(notify){try{window.gitkVscode.postMessage({type:'selectFile',path:path})}catch(_){}}
}
// 固定 SCROLL_DURATION 完成滚动：距离越远速度越快，不用浏览器 smooth 的按距离计时。
function animateScrollTo(top){
  if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}
  const start=window.scrollY,distance=top-start;
  if(Math.abs(distance)<1){window.scrollTo({top:top,behavior:'auto'});return}
  const startTime=performance.now();
  const step=function(now){
    const progress=Math.min(1,(now-startTime)/SCROLL_DURATION);
    const eased=progress<.5?2*progress*progress:1-Math.pow(-2*progress+2,2)/2;
    window.scrollTo({top:start+distance*eased,behavior:'auto'});
    scrollAnimationFrame=progress<1?requestAnimationFrame(step):0;
  };
  scrollAnimationFrame=requestAnimationFrame(step);
}
function reveal(path,smooth){
  const entry=path&&cardByPath.get(path);
  if(!entry)return;
  // 从 Changed Files 定位时只负责自动展开目标，挂载仍由原虚拟化范围管理。
  if(entry.collapsed){
    entry.collapsed=false;entry.card.classList.remove('collapsed');entry.body.style.height=Math.max(80,entry.bodyHeight||80)+'px';
  }
  suppressSyncUntil=performance.now()+SCROLL_DURATION+120;
  const group=entry.pinnedGroup||entry.card;
  const stickyTop=parseFloat(getComputedStyle(group).top)||0;
  // 使用逻辑项缓存高度累计定位，避免依赖尚未挂载 Monaco 的实时 DOM 内容高度。
  let top=8;
  for(let index=0;index<entry.index;index++){
    const item=cards[index];
    top+=(item.collapsed?item.pinnedGroup.offsetHeight:item.pinnedGroup.offsetHeight+item.bodyHeight)+14;
  }
  top=Math.max(0,top-stickyTop);
  if(smooth)animateScrollTo(top);
  else{if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}window.scrollTo({top:top,behavior:'auto'})}
  setActive(path,false);scheduleVirtualization();
}
function topVisibleCard(){for(const entry of cards){if(entry.card.getBoundingClientRect().bottom>1)return entry}return cards[cards.length-1]}
function syncActiveFromViewport(){if(performance.now()<suppressSyncUntil)return;const entry=topVisibleCard();if(entry)setActive(entry.path,true)}
function updateVirtualization(){
  if(!cards.length)return;
  let first=-1,last=-1;
  for(let index=0;index<cards.length;index++){
    const rect=cards[index].card.getBoundingClientRect();
    if(rect.bottom>=0&&rect.top<=window.innerHeight){if(first<0)first=index;last=index}
  }
  if(first<0){const visible=topVisibleCard();first=last=visible?visible.index:0}
  for(let index=0;index<cards.length;index++){
    const entry=cards[index];
    if(index>=first&&index<=last&&!entry.collapsed){
      mountEntry(entry).catch(function(error){markCardFailed(entry,error)});
    }else if(entry.mounted||entry.mounting){disposeEntry(entry)}
  }
}
function scheduleVirtualization(){if(virtualFrame)return;virtualFrame=requestAnimationFrame(function(){virtualFrame=0;updateVirtualization()})}
let scrollFrame=0;
window.addEventListener('scroll',function(){if(scrollFrame)return;scrollFrame=requestAnimationFrame(function(){scrollFrame=0;syncActiveFromViewport();updateVirtualization()})},{passive:true});
window.addEventListener('resize',scheduleVirtualization);
// 全部逻辑项外壳先进入文档流，只有 viewport 相交项绑定池中的 Monaco 模板。
function render(snapshot){
  try{
    dispose();
    const token=renderToken;
    editable=snapshot.editable===true;
    if(!snapshot.diffs.length){list.classList.remove('rendering');list.textContent='没有可显示的 Diff 内容';loading.hidden=true;list.hidden=false;log('render #'+snapshot.revision+': empty');notifyRendered(snapshot.revision);return}
    const total=snapshot.diffs.length;
    // 先同步创建全部逻辑项外壳，只有可视范围绑定对象池中的 Monaco。
    list.classList.add('rendering');list.hidden=false;
    loading.textContent='正在创建 Diff 列表...';loading.hidden=false;
    snapshot.diffs.forEach(function(diff,order){createCardShell(diff,order,list)});
    if(token!==renderToken)return;
    const target=snapshot.revealPath&&cardByPath.has(snapshot.revealPath)?snapshot.revealPath:diffKey(snapshot.diffs[0]);
    reveal(target,false);
    updateVirtualization();
    list.classList.remove('rendering');loading.hidden=true;
    log('render #'+snapshot.revision+': cards='+total+', mounted='+cards.filter(function(entry){return entry.mounted}).length+', reveal='+target);
    // 外壳和首屏 Monaco 已开始挂载即可放行 Changed Files；后续由滚动虚拟化管理。
    notifyRendered(snapshot.revision);
  }catch(error){fail(error)}
}
function receive(message){
  if(!message)return;
  if(message.type==='reveal'){reveal(message.path,true);return}
  if(typeof message.revision!=='number'||message.revision<=lastRevision)return;
  lastRevision=message.revision;
  log('receive #'+message.revision+': loading='+message.loading+', progress='+message.completed+'/'+message.total+', diffs='+message.diffs.length);
  if(message.error){show(message.error);return}
  if(message.loading){show('正在读取 Diff 数据 ('+message.completed+'/'+message.total+')...');return}
  if(monacoReady)render(message);else pending=message;
}
window.addEventListener('message',event=>receive(event.data));window.gitkQueue.forEach(receive);window.gitkQueue.push=()=>{};window.gitkVscode.postMessage({type:'ready'});
function applyVsCodeTheme(){const css=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim(),colors={},background=css('--vscode-editor-background'),foreground=css('--vscode-editor-foreground');if(background)colors['editor.background']=background;if(foreground)colors['editor.foreground']=foreground;monaco.editor.defineTheme('gitk-vscode-surface',{base:document.body.classList.contains('vscode-light')?'vs':'vs-dark',inherit:true,rules:[],colors});monaco.editor.setTheme('gitk-vscode-surface')}
function applyVsCodeFont(editor){const style=getComputedStyle(document.documentElement),fontFamily=style.getPropertyValue('--vscode-editor-font-family').trim(),fontSize=Number.parseFloat(style.getPropertyValue('--vscode-editor-font-size'));editor.updateOptions({fontFamily:fontFamily||undefined,fontSize:Number.isFinite(fontSize)?fontSize:undefined})}
try{require.config({paths:{vs:'${monacoUri}'}});require(['vs/editor/editor.main'],()=>{try{applyVsCodeTheme();monacoReady=true;if(pending){const snapshot=pending;pending=undefined;render(snapshot)}}catch(error){fail(error)}},fail)}catch(error){fail(error)}
</script></body></html>`;
    }
}
