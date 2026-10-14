import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { invokeNativeGit } from './nativeGitBinding';

export type MergeOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';
export async function readMergeOperation(root: vscode.Uri): Promise<MergeOperation | undefined> {
    const { gitDir } = await invokeNativeGit<{ gitDir: string }>('discover', { path: root.fsPath });
    const exists = async (name: string) => fs.access(path.join(gitDir, name)).then(() => true, () => false);
    const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
        ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(exists));
    if (rebaseMerge || rebaseApply) { return 'rebase'; }
    if (merge) { return 'merge'; }
    if (cherryPick) { return 'cherry-pick'; }
    if (revert) { return 'revert'; }
}

/** Use Git's own sequencer and abort safety rules; never approximate abort with hard reset. */
export async function runMergeOperation(root: vscode.Uri, expected: MergeOperation, action: 'continue' | 'abort'): Promise<void> {
    if (await readMergeOperation(root) !== expected) { throw new Error('当前冲突操作已改变，请刷新后重试。'); }
    if (action === 'continue' && await invokeNativeGit<boolean>('hasConflicts', { rootPath: root.fsPath })) {
        throw new Error('请先保存并暂存所有已解决的冲突，再继续。');
    }
    await new Promise<void>((resolve, reject) => {
        execFile('git', ['-C', root.fsPath, expected, `--${action}`], {
            windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
        }, (error, stdout, stderr) => error ? reject(new Error([stdout, stderr].filter(Boolean).join('\n') || error.message)) : resolve());
    });
}
