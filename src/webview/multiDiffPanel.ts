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
    diffs: DiffPayload[];
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
        const diffs = state.files.filter((file): file is DiffPayload => 'original' in file && 'modified' in file);
        const snapshot: DiffSnapshot = {
            type: 'snapshot',
            revision: ++this.revision,
            // 与 CustomDiffPanel 一致：只由 Store 的 diffLoading 决定加载态；完成空快照也必须结束 loading。
            loading: state.diffLoading,
            completed: state.diffProgress.completed,
            total: state.diffProgress.total,
            error: state.diffError,
            revealPath: this.revealPath ?? state.selectedPath,
            // 只有 changes(未暂存改动) 的右侧就是工作区文件本身, 才允许编辑。
            editable: state.currentChangeSet === 'changes',
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
.file-header{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:4px 8px;border:0;color:var(--vscode-tab-activeForeground);background:var(--header-surface);font:inherit;font-size:calc(var(--vscode-editor-font-size) * .95);text-align:left;cursor:pointer}
.file-header:hover{background:var(--vscode-list-hoverBackground,var(--vscode-editorWidget-background))}
/* 标题栏底边保持常规边框色: 选中高光只体现在卡片外框与顶部预留条, 底部不跟着高亮。 */
.diff.collapsed>.pinned-group>.header-layer>.header-row>.file-header{border-bottom-color:transparent}
.diff-chevron{flex:0 0 auto;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;transition:transform .12s ease}
.diff.collapsed .diff-chevron{transform:rotate(-90deg)}
.status{flex:0 0 auto;width:14px;text-align:center;font-weight:600}
.status-A{color:var(--vscode-gitDecoration-addedResourceForeground)}
.status-M{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.status-D{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.status-R,.status-C{color:var(--vscode-gitDecoration-renamedResourceForeground)}
.line-stats{flex:0 0 auto;display:none;gap:6px;font-size:calc(var(--vscode-editor-font-size) * .85);font-variant-numeric:tabular-nums}
.line-stats.ready{display:inline-flex}
.line-stat-added{color:var(--vscode-gitDecoration-addedResourceForeground)}
.line-stat-removed{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.file-path{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.file-folder{color:var(--vscode-descriptionForeground)}
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
let monacoReady=false,lastRevision=0,pending,cards=[],cardByPath=new Map(),activePath='',suppressSyncUntil=0,scrollAnimationFrame=0,renderToken=0,editable=false;
const SCROLL_DURATION=150;
function show(message){loading.textContent=message;loading.hidden=false;list.hidden=true;list.classList.remove('rendering')}
function fail(error){const message=error&&error.message||String(error);show('Diff 渲染失败: '+message);report(message)}
function dispose(){for(const entry of cards){if(entry.editor){entry.editor.dispose();entry.original.dispose();entry.modified.dispose()}}cards=[];cardByPath=new Map();activePath='';list.replaceChildren()}
function language(path){const ext=path.slice(path.lastIndexOf('.')+1).toLowerCase();return languages[ext]||'plaintext'}
function escapeHtml(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function pathHtml(path){const slash=path.lastIndexOf('/');return slash<0?escapeHtml(path):'<span class="file-folder">'+escapeHtml(path.slice(0,slash+1))+'</span>'+escapeHtml(path.slice(slash+1))}
function headerHtml(diff){const chevron='<svg class="diff-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 5.5 5 5 5-5"/></svg>';const status='<span class="status status-'+escapeHtml(diff.status)+'">'+escapeHtml(diff.status)+'</span>';const stats='<span class="line-stats"><span class="line-stat-added"></span><span class="line-stat-removed"></span></span>';return chevron+status+stats+'<span class="file-path" title="'+escapeHtml(diff.path)+'">'+pathHtml(diff.path)+'</span>'}
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
// 返回 Promise：Monaco 首次差异计算完成（onDidUpdateDiff）才算这张卡片就绪。
function createCard(diff,order,parent){
  const card=document.createElement('section');card.className='diff';card.dataset.path=diff.path;card.dataset.index=String(order);
  const pinnedGroup=document.createElement('div');pinnedGroup.className='pinned-group';
  // 独立标题层: 盖板与标题栏同高, 盖板位于标题内容下方但可跨出标题栏 8px 覆盖相邻卡片。
  const headerLayer=document.createElement('div');headerLayer.className='header-layer';
  const headerRow=document.createElement('div');headerRow.className='header-row';
  const header=document.createElement('button');header.type='button';header.className='file-header';header.innerHTML=headerHtml(diff);
  const openFile=document.createElement('button');openFile.type='button';openFile.className='open-file';
  openFile.title='在编辑器中打开文件';openFile.setAttribute('aria-label','在编辑器中打开文件');
  openFile.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 8 8"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>';
  const body=document.createElement('div');body.className='diff-body';
  headerRow.append(header,openFile);
  headerLayer.append(headerRow);
  const meta=document.createElement('div');meta.className='file-meta';meta.innerHTML=metaHtml(diff);
  pinnedGroup.append(headerLayer,meta);
  card.append(pinnedGroup,body);parent.append(card);
  const entry={path:diff.path,card:card,header:header,pinnedGroup:pinnedGroup,body:body,editor:null,original:null,modified:null,collapsed:false,fit:function(){}};
  header.addEventListener('click',function(){toggle(entry)});
  // 标题栏右侧直接打开工作区文件, 不带行号定位。
  openFile.addEventListener('click',function(event){
    event.stopPropagation();
    try{window.gitkVscode.postMessage({type:'openFileAtLine',path:diff.path})}catch(_){}
  });
  cards.push(entry);cardByPath.set(diff.path,entry);
  if(diff.error||diff.isBinary){
    const message=document.createElement('div');message.className='empty';
    message.textContent=diff.error?('无法读取此文件：'+diff.error):'二进制文件不同，无法显示文本差异。';
    body.append(message);
    return Promise.resolve();
  }
  const host=document.createElement('div');host.className='editor';body.append(host);
  let original,modified,editor;
  try{
    original=monaco.editor.createModel(diff.original||'',language(diff.path));
    modified=monaco.editor.createModel(diff.modified||'',language(diff.path));
    // changes 模式右侧即工作区文件, 允许编辑; 其余模式(commit/staged)保持只读。
    editor=monaco.editor.createDiffEditor(host,Object.assign({},diffOptions,{readOnly:!editable}));
    editor.setModel({original:original,modified:modified});
    applyVsCodeFont(editor);
    if(editable){
      // 编辑防抖回写工作区文件, 避免每次击键都发消息。
      let saveTimer=0;
      modified.onDidChangeContent(function(){
        if(saveTimer)clearTimeout(saveTimer);
        saveTimer=setTimeout(function(){
          saveTimer=0;
          try{window.gitkVscode.postMessage({type:'saveFile',path:diff.path,content:modified.getValue()})}catch(_){}
        },400);
      });
    }
    // 折叠未改动区域的图标用 glyphMarginClassName 渲染, DiffEditor 默认只给左侧开 glyphMargin,
    // 右侧那一列让给了 renderIndicators, 故右侧看不到该图标; 这里单独为右侧开启。
    editor.getModifiedEditor().updateOptions({glyphMargin:true});
    function bindOpenFileGesture(side, targetEditor, targetPath) {
      let linkDecorations = [];
      targetEditor.onMouseMove(function(event){
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
      });
      targetEditor.onMouseLeave(function(){
        const model=targetEditor.getModel();
        if (model) { linkDecorations = model.deltaDecorations(linkDecorations, []); }
      });
      targetEditor.onMouseDown(function(event){
        const mouse=event.event;
        if(mouse.leftButton!==true&&mouse.button!==0)return;
        if(!mouse.ctrlKey&&!mouse.metaKey)return;
        const position=event.target&&event.target.position;
        const model=targetEditor.getModel();
        const word=position&&model?model.getWordAtPosition(position):null;
        if(!position||!word)return;
        mouse.preventDefault&&mouse.preventDefault();
        try{window.gitkVscode.postMessage({type:'openFileAtLine',path:targetPath,line:position.lineNumber,column:word.startColumn,side:side})}catch(_){}
      });
    }
    // Ctrl/Cmd + hover/左键支持 Diff 两侧跳转, 路径按 Diff 文件的对应版本选择。
    bindOpenFileGesture('original', editor.getOriginalEditor(), diff.oldPath || diff.path);
    bindOpenFileGesture('modified', editor.getModifiedEditor(), diff.path);
  }catch(error){
    // 创建阶段就失败: 回收已建资源并让调用方就地降级。
    if(editor){try{editor.dispose()}catch(_){}}
    if(original){try{original.dispose()}catch(_){}}
    if(modified){try{modified.dispose()}catch(_){}}
    return Promise.reject(error);
  }
  const fit=function(){
    if(entry.collapsed)return;
    const left=editor.getOriginalEditor(),right=editor.getModifiedEditor();
    const height=Math.max(80,left.getContentHeight(),right.getContentHeight());
    const width=host.clientWidth||Math.max(0,window.innerWidth-18);
    host.style.height=Math.ceil(height)+'px';
    editor.layout({width:Math.ceil(width),height:Math.ceil(height)});
  };
  editor.onDidUpdateDiff(function(){fit();updateLineStats(entry)});editor.getOriginalEditor().onDidContentSizeChange(fit);editor.getModifiedEditor().onDidContentSizeChange(fit);
  entry.editor=editor;entry.original=original;entry.modified=modified;entry.fit=fit;
  // 纯事件驱动：onDidUpdateDiff 到达即就绪；若挂监听前差异已算完，
  // getLineChanges() 已非 null，直接就绪，避免错过事件而永久等待。
  return new Promise(function(resolve,reject){
    let settled=false;
    const listener=editor.onDidUpdateDiff(function(){finish()});
    function finish(){
      if(settled)return;
      settled=true;
      try{listener.dispose()}catch(_){}
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
    try{entry.editor.dispose()}catch(_){}
    try{entry.original.dispose()}catch(_){}
    try{entry.modified.dispose()}catch(_){}
    entry.editor=null;entry.original=null;entry.modified=null;entry.fit=function(){};
  }
  const notice=document.createElement('div');notice.className='empty';
  notice.textContent='此文件差异渲染失败：'+message;
  entry.body.replaceChildren(notice);
  report('card '+entry.path+' failed: '+message);
}
function toggle(entry){
  entry.collapsed=!entry.collapsed;
  entry.card.classList.toggle('collapsed',entry.collapsed);
  if(!entry.collapsed)requestAnimationFrame(entry.fit);
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
  suppressSyncUntil=performance.now()+SCROLL_DURATION+120;
  // 对齐 pinned 组的实际 sticky top，而非卡片顶部再留固定 8px，
  // 点击 Changed Files 后目标标题栏 + index 栏会直接落在置顶位置。
  const group=entry.pinnedGroup||entry.card;
  const stickyTop=parseFloat(getComputedStyle(group).top)||0;
  const top=Math.max(0,group.getBoundingClientRect().top+window.scrollY-stickyTop);
  if(smooth)animateScrollTo(top);
  else{if(scrollAnimationFrame){cancelAnimationFrame(scrollAnimationFrame);scrollAnimationFrame=0}window.scrollTo({top:top,behavior:'auto'})}
  setActive(path,false);
}
function topVisibleCard(){for(const entry of cards){if(entry.card.getBoundingClientRect().bottom>1)return entry}return cards[cards.length-1]}
function syncActiveFromViewport(){if(performance.now()<suppressSyncUntil)return;const entry=topVisibleCard();if(entry)setActive(entry.path,true)}
let scrollFrame=0;
window.addEventListener('scroll',function(){if(scrollFrame)return;scrollFrame=requestAnimationFrame(function(){scrollFrame=0;syncActiveFromViewport()})},{passive:true});
// 卡片直接建在 #list 内（Monaco 需要真实容器宽度），渲染期间整个列表 visibility:hidden，
// 全部差异计算完成后再显示，既不逐个跳动也不需要挂载后补偿 layout。
function render(snapshot){
  try{
    dispose();
    renderToken++;
    const token=renderToken;
    editable=snapshot.editable===true;
    if(!snapshot.diffs.length){list.classList.remove('rendering');list.textContent='没有可显示的 Diff 内容';loading.hidden=true;list.hidden=false;log('render #'+snapshot.revision+': empty');notifyRendered(snapshot.revision);return}
    const total=snapshot.diffs.length;
    let ready=0;
    // 列表先进入文档流但不可见；loading 保持可见承载进度文案。
    list.classList.add('rendering');
    list.hidden=false;
    loading.textContent='正在渲染 Diff (0/'+total+')...';
    loading.hidden=false;
    const tasks=snapshot.diffs.map(function(diff,order){
      // 单张卡片异常就地降级显示, 不阻塞其余卡片, 也不让整个面板失败。
      return createCard(diff,order,list).catch(function(error){
        const entry=cardByPath.get(diff.path);
        if(entry)markCardFailed(entry,error);else report('card '+diff.path+' failed: '+(error&&error.message||String(error)));
      }).then(function(){
        if(token!==renderToken)return;
        ready++;
        loading.textContent='正在渲染 Diff ('+ready+'/'+total+')...';
      });
    });
    Promise.all(tasks).then(function(){
      if(token!==renderToken)return;
      list.classList.remove('rendering');
      loading.hidden=true;
      const target=snapshot.revealPath&&cardByPath.has(snapshot.revealPath)?snapshot.revealPath:snapshot.diffs[0].path;
      reveal(target,false);
      log('render #'+snapshot.revision+': cards='+cards.length+', reveal='+target);
      // Diff 内容与行号已呈现, 通知扩展侧再放行 Changed Files 列表。
      notifyRendered(snapshot.revision);
    }).catch(function(error){notifyRendered(snapshot.revision);fail(error)});
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
