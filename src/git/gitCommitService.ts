import * as vscode from 'vscode';
import { commit } from './gitNativeOperations';

/** 通过 libgit2 创建普通提交或 amend，保留用户输入的完整多行消息。 */
export async function commitWithMessage(rootUri: vscode.Uri, message: string, amend: boolean): Promise<void> {
    await commit(rootUri, message, amend);
}