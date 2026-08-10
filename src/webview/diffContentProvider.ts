import * as vscode from 'vscode';
import { getCommitFiles, buildGitFileUri } from '../git/gitLogProvider';

// 虚拟文档提供器: 为 commit 的完整 diff 提供文本内容
// URI 格式: vscode-gitk-diff:<commit-hash>  (用 path 而非 authority 避免 URI 解析问题)
export class GitkDiffContentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'vscode-gitk-diff';
    private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.changeEmitter.event;
    private cache = new Map<string, string>();

    // 构造 diff 虚拟文档 URI
    // path 用 /<hash>.diff 格式, 让 VS Code 识别为 diff 文件 (语法高亮)
    static uriForCommit(hash: string): vscode.Uri {
        return vscode.Uri.from({
            scheme: GitkDiffContentProvider.scheme,
            path: `/${hash}.diff`,
            authority: '',
            query: '',
            fragment: '',
        });
    }

    // 直接设置内容 (供 openDiff 用 child_process 获取后直接传入)
    private contentMap = new Map<string, string>();
    setContent(hash: string, content: string): void {
        this.contentMap.set(hash, content);
    }

    // 通知文档内容已更新 (让 VS Code 重新加载)
    fireDidChange(hash: string): void {
        const uri = GitkDiffContentProvider.uriForCommit(hash);
        this.changeEmitter.fire(uri);
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // path 格式 /<hash>.diff, 提取 hash
        const rawPath = uri.path || '';
        // 去掉前导 / 和 .diff 后缀
        let cleanHash = rawPath.replace(/^\//, '').replace(/\.diff$/, '');
        console.log('[vscode-gitk] provideTextDocumentContent for hash:', cleanHash, '(raw path:', uri.path, ')');
        if (!cleanHash) { return '无效的 commit hash'; }

        // 如果已通过 setContent 设置了内容, 直接返回
        const preset = this.contentMap.get(cleanHash);
        if (preset !== undefined) { return preset; }

        // 检查缓存
        const cached = this.cache.get(cleanHash);
        if (cached !== undefined) { return cached; }

        // 获取仓库根
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return '未找到工作区'; }
        const rootUri = folders[0].uri;

        try {
            const text = await getCommitDiffText(rootUri, cleanHash);
            this.cache.set(cleanHash, text);
            console.log('[vscode-gitk] diff text length:', text.length);
            return text;
        } catch (e: any) {
            console.error('[vscode-gitk] getCommitDiffText failed:', e);
            return `获取 diff 失败: ${e.message || e}\n\nHash: ${cleanHash}\nRootUri: ${rootUri.toString()}`;
        }
    }

    // 清除缓存
    clearCache(hash?: string): void {
        if (hash) {
            this.cache.delete(hash);
            this.contentMap.delete(hash);
        } else {
            this.cache.clear();
            this.contentMap.clear();
        }
    }
}

// 获取指定 commit 的完整 diff 文本 (所有变更文件合并)
// 通过 VS Code Git 扩展 API 逐文件读取并拼接
export async function getCommitDiffText(rootUri: vscode.Uri, hash: string): Promise<string> {
    const api = await getGitApiInternal();
    if (!api) { throw new Error('Git 扩展不可用'); }
    const repo = api.getRepository(rootUri);
    if (!repo) { throw new Error('未找到 Git 仓库'); }

    console.log('[vscode-gitk] getCommitDiffText, hash:', hash, 'repo:', repo.rootUri.toString());

    // 方案 1: 尝试用 Repository 的内部 run 方法执行 git show (桌面版最可靠)
    try {
        const repoAny = repo as any;
        if (typeof repoAny.run === 'function') {
            console.log('[vscode-gitk] trying repo.run([show, hash])');
            const text = await repoAny.run(['show', hash]);
            if (text) {
                console.log('[vscode-gitk] repo.run succeeded, length:', text.length);
                return text;
            }
        }
    } catch (e: any) {
        console.warn('[vscode-gitk] repo.run failed:', e.message);
    }

    // 方案 2: 尝试用 diffBetweenRefs
    try {
        const repoAny = repo as any;
        if (typeof repoAny.diffBetweenRefs === 'function') {
            console.log('[vscode-gitk] trying repo.diffBetweenRefs');
            const text = await repoAny.diffBetweenRefs(`${hash}^`, hash);
            if (text) {
                console.log('[vscode-gitk] diffBetweenRefs succeeded, length:', text.length);
                return text;
            }
        }
    } catch (e: any) {
        console.warn('[vscode-gitk] diffBetweenRefs failed:', e.message);
    }

    // 方案 3: 用 git.api.getCommitDiff 命令 (如果存在)
    try {
        console.log('[vscode-gitk] trying git.api.getCommitDiff command');
        const text = await vscode.commands.executeCommand<string>('git.api.getCommitDiff', rootUri, hash);
        if (text) {
            console.log('[vscode-gitk] getCommitDiff command succeeded, length:', text.length);
            return text;
        }
    } catch (e: any) {
        console.warn('[vscode-gitk] git.api.getCommitDiff failed:', e.message);
    }

    // 方案 4: 逐文件构造 diff 文本 (兜底, 兼容 web)
    console.log('[vscode-gitk] falling back to per-file diff construction');
    const files = await getCommitFiles(rootUri, hash);
    let combined = `commit ${hash}\n\n`;
    for (const f of files) {
        combined += `\ndiff --git a/${f.path} b/${f.path}\n`;
        combined += `status: ${f.status}\n\n`;
        try {
            const leftUri = buildGitFileUri(rootUri, `${hash}^`, f.oldPath || f.path);
            const rightUri = buildGitFileUri(rootUri, hash, f.path);
            const leftDoc = await vscode.workspace.openTextDocument(leftUri);
            const rightDoc = await vscode.workspace.openTextDocument(rightUri);
            const leftLines = leftDoc.getText().split('\n');
            const rightLines = rightDoc.getText().split('\n');
            const maxLen = Math.max(leftLines.length, rightLines.length);
            for (let i = 0; i < maxLen; i++) {
                const l = leftLines[i] || '';
                const r = rightLines[i] || '';
                if (l === r) {
                    combined += `  ${r}\n`;
                } else {
                    if (l) { combined += `- ${l}\n`; }
                    if (r) { combined += `+ ${r}\n`; }
                }
            }
        } catch (e: any) {
            combined += `(无法读取: ${e.message})\n`;
        }
    }
    return combined;
}

// 内部: 获取 Git 扩展 API (从 gitLogProvider.ts 复制逻辑, 避免循环依赖)
async function getGitApiInternal(): Promise<any | undefined> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) { return undefined; }
    await ext.activate();
    return ext.exports?.getAPI?.(1);
}
