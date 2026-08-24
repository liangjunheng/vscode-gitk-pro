import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

/**
 * 提交服务: 不走 GIT_EDITOR 命名管道, 直接用 git commit -F <临时消息文件> 执行提交。
 * 展示模板取 git commit -v -v 生成的完整 COMMIT_EDITMSG 原文
 * (含分支状态、文件清单, 以及 scissors 之后 staged 与 unstaged 的完整 diff)。
 */

function runGit(rootUri: vscode.Uri, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        execFile('git', ['-C', rootUri.fsPath, ...args], {
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
            env: env ?? process.env,
        }, (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : (error ? 1 : 0);
            resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        });
    });
}

/** 定位 .git 目录 (worktree/submodule 下不是 rootUri/.git)。 */
async function resolveGitDir(rootUri: vscode.Uri): Promise<string> {
    const result = await runGit(rootUri, ['rev-parse', '--absolute-git-dir']);
    const gitDir = result.stdout.trim();
    if (result.code !== 0 || !gitDir) {
        throw new Error(result.stderr.trim() || '无法定位 .git 目录');
    }
    return gitDir;
}

/**
 * 取 git 生成的完整 COMMIT_EDITMSG 内容 (git commit -v -v)。
 * 做法: 用一个必定失败的 GIT_EDITOR 触发 git commit -v -v, git 会先写出完整模板
 * (注释 + scissors + staged diff + unstaged diff) 再因编辑器失败而中止, 不产生任何提交,
 * 随后读取 .git/COMMIT_EDITMSG。
 */
export async function readCommitTemplate(rootUri: vscode.Uri, amend: boolean): Promise<string> {
    const gitDir = await resolveGitDir(rootUri);
    const commitEditMsgPath = path.join(gitDir, 'COMMIT_EDITMSG');
    // 跨平台的"必定失败"编辑器: node -e process.exit(1)
    const failingEditor = `"${process.execPath.replace(/"/g, '\\"')}" -e "process.exit(1)"`;
    // -v -v: 在模板中附带 staged 与 unstaged 两份完整 diff。
    await runGit(rootUri, ['commit', ...(amend ? ['--amend'] : []), '-v', '-v'], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        GIT_EDITOR: failingEditor,
    });
    // git 中止提交时仍会留下模板文件; 读失败则回退为空。
    try {
        return await fs.readFile(commitEditMsgPath, 'utf8');
    } catch {
        return '';
    }
}

/** 用临时消息文件执行提交, 完成后删除临时文件。 */
export async function commitWithMessage(rootUri: vscode.Uri, message: string, amend: boolean): Promise<void> {
    const tempFile = path.join(os.tmpdir(), `vscode-gitk-commit-${randomUUID()}.txt`);
    await fs.writeFile(tempFile, message, 'utf8');
    try {
        // --cleanup=strip 去掉注释行与多余空白, 与 git 默认编辑器提交行为一致。
        const result = await runGit(rootUri, [
            'commit',
            ...(amend ? ['--amend'] : []),
            '--cleanup=strip',
            '-F', tempFile,
        ]);
        if (result.code !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || `git commit 退出，代码 ${result.code}`);
        }
    } finally {
        await fs.rm(tempFile, { force: true });
    }
}
