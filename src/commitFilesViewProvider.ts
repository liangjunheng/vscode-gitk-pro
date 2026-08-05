import * as vscode from 'vscode';
import { CommitFile, getCommitFiles } from './gitLogProvider';
import { CustomDiffPanel } from './customDiffPanel';
import { GitkViewProvider } from './gitkViewProvider';

// 右侧面板: 显示选中提交的变更文件列表, 支持 tree/flat 切换
// 点击文件打开 diff, 并与编辑器活动标签同步高亮
export class CommitFilesViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vscode-gitk.commitFilesView';
    private view?: vscode.WebviewView;
    private files: CommitFile[] = [];
    private currentHash?: string;
    private displayMode: 'tree' | 'flat' = 'tree';
    private selectedPath?: string;
    private readonly customDiffPanel: CustomDiffPanel;

    constructor(
        context: vscode.ExtensionContext,
        private readonly gitkViewProvider: GitkViewProvider,
    ) {
        this.customDiffPanel = new CustomDiffPanel(context, path => this.syncHighlightFromPath(path));
        context.subscriptions.push(
            this.customDiffPanel,
            this.gitkViewProvider.onDidChangeDiffAvailability(() => {
                if (this.gitkViewProvider.isGitkLoading()) {
                    this.customDiffPanel.hide();
                }
            }),
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };
        view.webview.html = this.getHtml();
        view.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    }

    private syncHighlightFromPath(filePath: string): void {
        const file = this.files.find(item => item.path === filePath || item.oldPath === filePath);
        if (!file || file.path === this.selectedPath) {
            return;
        }
        console.log('[vscode-gitk] syncing highlight to:', file.path);
        this.selectedPath = file.path;
        this.view?.webview.postMessage({ type: 'syncHighlight', path: file.path });
    }

    // 清除高亮
    private clearHighlight(): void {
        this.selectedPath = undefined;
        this.view?.webview.postMessage({ type: 'syncHighlight', path: '' });
    }

    // 设置当前提交并加载变更文件
    async setCommit(hash: string): Promise<void> {
        this.clearHighlight();
        this.currentHash = hash;
        this.selectedPath = undefined;
        if (!this.view) { return; }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) {
            this.view.webview.postMessage({ type: 'error', message: '未找到 Git 仓库' });
            return;
        }
        try {
            this.files = await getCommitFiles(rootUri, hash);
            this.view.webview.postMessage({
                type: 'files',
                files: this.files,
                hash: hash,
                mode: this.displayMode,
            });
            // 仅在 Gitk 加载完成且仍聚焦时显示整个 commit 的合并 diff。
            if (this.files.length > 0 && this.gitkViewProvider.canShowMultiDiff()) {
                this.openDiff(hash);
            } else {
                this.customDiffPanel.hide();
            }
        } catch (e: any) {
            this.view.webview.postMessage({ type: 'error', message: String(e.message || e) });
        }
    }

    // 获取仓库根目录 URI (兼容 web)
    private getRepoRootUri(): vscode.Uri | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return undefined; }
        return folders[0].uri;
    }

    private onMessage(msg: any): void {
        switch (msg.type) {
            case 'setMode':
                this.displayMode = msg.mode === 'flat' ? 'flat' : 'tree';
                if (this.currentHash) {
                    this.view?.webview.postMessage({
                        type: 'files',
                        files: this.files,
                        hash: this.currentHash,
                        mode: this.displayMode,
                    });
                }
                break;
            case 'openDiff':
                this.openDiff(msg.hash, msg.filePath);
                break;
        }
    }

    // 打开自定义的按需加载 Diff 面板。
    private async openDiff(hash: string, filePath?: string): Promise<void> {
        // 文件列表属于当前 Gitk 提交的操作入口；点击它会使 Gitk Webview 失焦，
        // 但不应销毁已打开的同一提交 Diff。
        if (this.gitkViewProvider.isGitkLoading() || (!filePath && !this.gitkViewProvider.canShowMultiDiff())) {
            this.customDiffPanel.hide();
            return;
        }
        const rootUri = this.getRepoRootUri();
        if (!rootUri) { return; }
        const selectedFile = filePath
            ? this.files.find(file => file.path === filePath || file.oldPath === filePath)
            : undefined;
        if (filePath && !selectedFile) { return; }
        if (selectedFile) {
            this.syncHighlightFromPath(selectedFile.path);
        }
        try {
            await this.customDiffPanel.show(rootUri, hash, this.files, selectedFile?.path);
        } catch (error) {
            console.error('[vscode-gitk] open custom diff failed:', error);
            vscode.window.showErrorMessage(`Gitk Diff 打开失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // 生成 webview HTML
    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Commit Files</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: var(--vscode-editor-font-family, sans-serif); font-size: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); display: flex; flex-direction: column; height: 100%; }
  #header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  #header .title { font-weight: bold; }
  #header .hash { opacity: 0.7; font-family: monospace; }
  .toggle-group { display: flex; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; margin-left: auto; }
  .toggle-group button { background: transparent; color: var(--vscode-foreground); border: none; padding: 3px 10px; cursor: pointer; font-size: 11px; }
  .toggle-group button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #fileList { overflow: auto; flex: 1; min-height: 0; padding: 4px 0; }
  .file-item { display: flex; align-items: center; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .file-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item.selected { background: rgba(255, 100, 100, 0.25); border-left: 3px solid #e06c75; padding-left: 7px; }
  .file-item .status { width: 16px; text-align: center; font-weight: bold; margin-right: 6px; font-size: 11px; }
  .file-item .path { overflow: hidden; text-overflow: ellipsis; }
  .file-item .filename { font-weight: 500; }
  .file-item .dir { opacity: 0.6; }
  .status-A { color: #98c379; }
  .status-M { color: #e5c07b; }
  .status-D { color: #e06c75; }
  .status-R { color: #c678dd; }
  .status-C { color: #61afef; }
  .status-T { color: #fd971f; }
  .status-U { color: #ff7a7a; }
  .status-\\? { color: #ff7a7a; }
  .tree-folder { color: var(--vscode-symbol-icon-folderForeground, #c678dd); }
  .tree-folder-group > summary { padding: 3px 10px; cursor: pointer; user-select: none; }
  .tree-folder-group > summary::marker { color: var(--vscode-foreground); }
  .tree-folder-group > .file-item { padding-left: 26px; }
  .empty-msg { padding: 20px; text-align: center; opacity: 0.6; }
  #loading { padding: 20px; text-align: center; opacity: 0.6; }
</style>
</head>
<body>
  <div id="header">
    <span class="title">变更文件</span>
    <span class="hash" id="hashLabel"></span>
    <div class="toggle-group">
      <button id="treeBtn" class="active" data-mode="tree">树形</button>
      <button id="flatBtn" data-mode="flat">平铺</button>
    </div>
  </div>
  <div id="fileList">
    <div id="loading" style="display:none;">加载中...</div>
    <div id="content"></div>
  </div>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  let files = [];
  let currentHash = '';
  let mode = 'tree';
  let selectedPath = '';

  document.getElementById('treeBtn').addEventListener('click', function() {
    if (mode === 'tree') return;
    setMode('tree');
  });
  document.getElementById('flatBtn').addEventListener('click', function() {
    if (mode === 'flat') return;
    setMode('flat');
  });

  function setMode(m) {
    mode = m;
    document.getElementById('treeBtn').classList.toggle('active', m === 'tree');
    document.getElementById('flatBtn').classList.toggle('active', m === 'flat');
    vscode.postMessage({ type: 'setMode', mode: m });
    render();
  }

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'files') {
      files = msg.files || [];
      currentHash = msg.hash || '';
      mode = msg.mode || 'tree';
      document.getElementById('treeBtn').classList.toggle('active', mode === 'tree');
      document.getElementById('flatBtn').classList.toggle('active', mode === 'flat');
      document.getElementById('hashLabel').textContent = currentHash ? currentHash.slice(0, 8) : '';
      render();
    } else if (msg.type === 'syncHighlight') {
      // 编辑器切换 -> 同步高亮文件项
      selectedPath = msg.path || '';
      updateHighlight();
    } else if (msg.type === 'error') {
      document.getElementById('content').innerHTML = '<div class="empty-msg">错误: ' + escapeHtml(msg.message) + '</div>';
    }
  });

  function statusLabel(s) {
    switch (s) {
      case 'A': return 'A';
      case 'M': return 'M';
      case 'D': return 'D';
      case 'R': return 'R';
      case 'C': return 'C';
      case 'T': return 'T';
      case 'U': return 'U';
      default: return '?';
    }
  }

  // 渲染平铺模式
  function renderFlat() {
    let html = '';
    for (const f of files) {
      const parts = f.path.split('/');
      const filename = parts.pop() || f.path;
      const dir = parts.join('/');
      const sel = f.path === selectedPath ? ' selected' : '';
      html += '<div class="file-item' + sel + '" data-path="' + escapeAttr(f.path) + '" data-status="' + f.status + '" data-old="' + escapeAttr(f.oldPath || '') + '">' +
        '<span class="status status-' + f.status + '">' + statusLabel(f.status) + '</span>' +
        '<span class="path"><span class="dir">' + escapeHtml(dir ? dir + '/' : '') + '</span><span class="filename">' + escapeHtml(filename) + '</span></span>' +
        '</div>';
    }
    return html;
  }

  // 文件项严格按 files 的原始顺序输出；同一路径的连续文件归入可折叠目录组。
  function renderTree() {
    let html = '';
    let index = 0;
    while (index < files.length) {
      const firstParts = files[index].path.split('/');
      const dir = firstParts.slice(0, -1).join('/');
      let end = index + 1;
      while (end < files.length && files[end].path.split('/').slice(0, -1).join('/') === dir) {
        end++;
      }

      const open = files.slice(index, end).some(function(f) { return f.path === selectedPath; }) ? ' open' : '';
      if (dir) {
        html += '<details class="tree-folder-group"' + open + '><summary><span class="tree-folder">' + escapeHtml(dir) + '/</span></summary>';
      }
      for (let fileIndex = index; fileIndex < end; fileIndex++) {
        const f = files[fileIndex];
        const filename = f.path.split('/').pop() || f.path;
        const sel = f.path === selectedPath ? ' selected' : '';
        html += '<div class="file-item' + sel + '" data-path="' + escapeAttr(f.path) + '" data-status="' + f.status + '" data-old="' + escapeAttr(f.oldPath || '') + '">' +
          '<span class="status status-' + f.status + '">' + statusLabel(f.status) + '</span>' +
          '<span class="path"><span class="filename">' + escapeHtml(filename) + '</span></span>' +
          '</div>';
      }
      if (dir) {
        html += '</details>';
      }
      index = end;
    }
    return html;
  }

  // 判断文件夹下是否包含选中文件
  function folderContainsSelected(folder) {
    if (!selectedPath) return false;
    function check(node) {
      for (const f of node.files) {
        if (f.path === selectedPath) return true;
      }
      for (const k in node.children) {
        if (check(node.children[k])) return true;
      }
      return false;
    }
    return check(folder);
  }

  // 更新高亮 (不重新渲染, 只切换 selected class, 并展开/滚动到选中文件)
  function updateHighlight() {
    const items = document.querySelectorAll('.file-item');
    items.forEach(function(item) {
      const p = item.getAttribute('data-path');
      if (p === selectedPath) {
        item.classList.add('selected');
        const folder = item.closest('.tree-folder-group');
        if (folder) folder.open = true;
        // 滚动到可视区
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.classList.remove('selected');
      }
    });
  }

  function render() {
    const content = document.getElementById('content');
    if (files.length === 0) {
      content.innerHTML = '<div class="empty-msg">请先在左侧选择一个提交</div>';
      return;
    }
    content.innerHTML = mode === 'tree' ? renderTree() : renderFlat();

    // 绑定文件点击 -> 打开整个 commit 的合并 diff, 高亮选中文件
    const fileItems = content.querySelectorAll('.file-item');
    fileItems.forEach(function(item) {
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        const path = item.getAttribute('data-path');
        if (path === selectedPath) {
          return;
        }
        selectedPath = path;
        updateHighlight();
        vscode.postMessage({
          type: 'openDiff',
          hash: currentHash,
          filePath: path,
        });
      });
    });
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
}
