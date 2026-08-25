import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

/** 提交服务: 使用临时消息文件执行提交。 */

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
