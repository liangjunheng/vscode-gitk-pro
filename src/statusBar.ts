import * as vscode from 'vscode';

// 状态栏管理: 通过 workspace 根目录 .git/HEAD 是否存在控制 Gitk 面板和状态栏显示
export class GitkStatusBar {
    private item: vscode.StatusBarItem;
    private headWatchers: vscode.Disposable[] = [];
    private workspaceFoldersListener?: vscode.Disposable;
    private visibilityGeneration = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly openCommand: string,
    ) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = openCommand;
        this.item.tooltip = '打开 Gitk 提交图面板';
        this.item.name = 'Gitk';
        this.item.text = '$(git-merge) Gitk';
    }

    async initialize(): Promise<void> {
        this.rebuildWatchers();
        this.workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuildWatchers());
        await this.refreshVisibility();
    }

    private rebuildWatchers(): void {
        this.headWatchers.splice(0).forEach(disposable => disposable.dispose());
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/HEAD'));
            const refresh = () => void this.refreshVisibility();
            watcher.onDidCreate(refresh);
            watcher.onDidDelete(refresh);
            this.headWatchers.push(watcher);
        }
        void this.refreshVisibility();
    }

    private async refreshVisibility(): Promise<void> {
        const generation = ++this.visibilityGeneration;
        const hasRootGitHead = await this.hasAnyRootGitHead();
        if (generation !== this.visibilityGeneration) { return; }
        await this.checkVisibility(hasRootGitHead);
    }

    private async hasAnyRootGitHead(): Promise<boolean> {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.git', 'HEAD'));
                if ((stat.type & vscode.FileType.File) !== 0) { return true; }
            } catch {
                // 根目录没有 .git/HEAD, 继续检查其他 workspace root
            }
        }
        return false;
    }

    // 有根目录 .git/HEAD 则显示状态栏和面板, 否则隐藏
    private async checkVisibility(hasRepo: boolean): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitk:hasRepository', hasRepo);
        if (hasRepo) {
            this.item.show();
        } else {
            this.item.hide();
        }
    }

    dispose(): void {
        this.visibilityGeneration++;
        this.workspaceFoldersListener?.dispose();
        this.headWatchers.splice(0).forEach(disposable => disposable.dispose());
        this.item.dispose();
    }
}
