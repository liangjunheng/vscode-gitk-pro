import * as vscode from 'vscode';
import type { PushBranchOption } from '../git/gitLogProvider';

type PushBranchQuickPickItem = vscode.QuickPickItem & { readonly branch: PushBranchOption };

function branchKey(branch: PushBranchOption): string {
    return `${branch.name}\u0000${branch.upstreamRemote}\u0000${branch.upstreamBranch}`;
}

/**
 * 选择一个或多个 Push 目标。当前分支绑定的 upstream 始终排在第一位,
 * 其余远程分支按最新提交时间倒序; 默认目标只影响勾选, 不改变顺序。
 */
export function pickPushBranches(
    branches: readonly PushBranchOption[],
    defaultBranches: readonly PushBranchOption[],
    localBranchLabel: string,
): Promise<PushBranchOption[] | undefined> {
    const quickPick = vscode.window.createQuickPick<PushBranchQuickPickItem>();
    const currentBranchNames = new Set(branches.filter(branch => branch.isCurrent).map(branch => branch.name));
    const candidates = branches.filter(branch => currentBranchNames.size === 0 || currentBranchNames.has(branch.name));
    const uniqueBranches = new Map<string, PushBranchOption>();
    for (const branch of candidates) {
        const key = `${branch.upstreamRemote}\u0000${branch.upstreamBranch}`;
        const existing = uniqueBranches.get(key);
        if (!existing || (branch.isCurrent && !existing.isCurrent) || (branch.isUpstream && !existing.isUpstream)) {
            uniqueBranches.set(key, branch);
        }
    }
    const orderedBranches = [...uniqueBranches.values()].sort((left, right) => {
        const leftDefault = left.isCurrent && left.isUpstream;
        const rightDefault = right.isCurrent && right.isUpstream;
        return Number(rightDefault) - Number(leftDefault)
            || right.tipTimestamp - left.tipTimestamp
            || left.upstreamName.localeCompare(right.upstreamName);
    });
    const baseItems: PushBranchQuickPickItem[] = orderedBranches.map(branch => ({
        label: `$(cloud) ${branch.upstreamName}`,
        detail: `未推送提交：${branch.unpushedCommitCount}`,
        branch,
    }));
    const defaultKeys = new Set(defaultBranches.map(branchKey));
    const initialSelected = baseItems.filter(item => defaultKeys.has(branchKey(item.branch)));
    // 列表顺序只由排序规则决定: 当前分支绑定的 upstream 始终第一, 其余按远程最新提交时间倒序。
    // 默认勾选项不再置顶, 否则缓存目标会把绑定的 upstream 挤下去。
    const orderedItems = baseItems;

    quickPick.title = `${localBranchLabel} 要推送的远程分支`;
    quickPick.placeholder = '勾选后按 Enter 提交，按 Esc 取消';
    quickPick.canSelectMany = true;
    quickPick.keepScrollPosition = true;
    quickPick.buttons = [{
        iconPath: new vscode.ThemeIcon('close'),
        tooltip: '关闭',
    }];
    quickPick.items = orderedItems;
    quickPick.selectedItems = initialSelected;

    return new Promise(resolve => {
        let settled = false;
        const finish = (value: PushBranchOption[] | undefined) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidAccept(() => finish(quickPick.selectedItems.map(item => item.branch)));
        quickPick.onDidTriggerButton(() => finish(undefined));
        quickPick.onDidHide(() => finish(undefined));
        quickPick.show();
    });
}

type PushConfirmItem = vscode.QuickPickItem & { readonly action: 'push' | 'cancel' };

/** 使用 QuickPick 弹窗确认 Push, 不依赖通知或 VS Code 的系统 OK/Cancel 文案。 */
export function confirmPush(detail: string): Promise<boolean> {
    const quickPick = vscode.window.createQuickPick<PushConfirmItem>();
    const items: PushConfirmItem[] = [
        {
            label: '$(cloud-upload) 推送',
            detail,
            action: 'push',
        },
        {
            label: '$(close) 取消',
            detail: '放弃本次远程推送',
            action: 'cancel',
        },
    ];
    quickPick.title = '确认推送';
    quickPick.placeholder = '请选择操作；按 Esc 也可以取消';
    quickPick.items = items;
    quickPick.activeItems = [items[0]];
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidAccept(() => {
            finish(quickPick.activeItems[0]?.action === 'push');
        });
        quickPick.onDidHide(() => finish(false));
        quickPick.show();
    });
}

/** 使用 VS Code 通知展示 Push 完成或失败信息，不再打开需要手工关闭的 QuickPick。 */
export function showPushResult(title: string, detail: string): Promise<void> {
    const normalizedDetail = detail.trim().replace(/\s*\r?\n\s*/g, '；');
    const message = normalizedDetail ? `${title}：${normalizedDetail}` : title;
    const notification = title.includes('失败')
        ? vscode.window.showErrorMessage(message)
        : vscode.window.showInformationMessage(message);
    return Promise.resolve(notification).then(() => undefined);
}
