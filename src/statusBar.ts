import * as vscode from 'vscode';

// 状态栏管理: 通过 workspace 根目录 .git/HEAD 是否存在控制 Gitk 面板和状态栏显示
export class GitkStatusBar {
    private item: vscode.StatusBarItem;
    private repositoryStateListener?: vscode.Disposable;
    private workingTreeSummaryListener?: vscode.Disposable;
    private visibilityGeneration = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly openCommand: string,
        private readonly getWorkingTreeSummary: () => {
            repositoryCount: number;
            stagedCount: number;
            unstagedCount: number;
            untrackedCount: number;
            repositories: Array<{
                label: string;
                stagedCount: number;
                unstagedCount: number;
                untrackedCount: number;
            }>;
        },
        private readonly hasRepository: () => boolean,
        onDidChangeRepositoryState: vscode.Event<void>,
        onDidChangeWorkingTreeSummary: vscode.Event<void>,
    ) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = openCommand;
        this.item.name = 'Gitk';
        this.refreshWorkingTreeSummary();
        this.repositoryStateListener = onDidChangeRepositoryState(() => void this.refreshVisibility());
        this.workingTreeSummaryListener = onDidChangeWorkingTreeSummary(() => this.refreshWorkingTreeSummary());
    }

    private refreshWorkingTreeSummary(): void {
        const { repositoryCount, stagedCount, unstagedCount, untrackedCount, repositories } = this.getWorkingTreeSummary();
        this.item.text = `$(git-merge): $(repo) ${repositoryCount} · $(pass) ${stagedCount} · $(warning) ${unstagedCount} · $(question) ${untrackedCount}`;
        const repositoryDetails = repositories
            .map(repository => `${repository.label}: Staged ${repository.stagedCount} · Unstaged ${repository.unstagedCount} · Untracked ${repository.untrackedCount}`)
            .join('\n');
        this.item.tooltip = `打开 Gitk 提交图面板${repositoryDetails ? `\n${repositoryDetails}` : ''}`;
    }

    async initialize(): Promise<void> {
        await this.refreshVisibility();
    }

    private async refreshVisibility(): Promise<void> {
        const generation = ++this.visibilityGeneration;
        await this.checkVisibility(this.hasRepository());
        if (generation !== this.visibilityGeneration) { return; }
    }

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
        this.repositoryStateListener?.dispose();
        this.workingTreeSummaryListener?.dispose();
        this.item.dispose();
    }
}
