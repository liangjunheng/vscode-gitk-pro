import * as vscode from 'vscode';
import type { PushBranchOption } from '../git/gitLogProvider';

type PushBranchQuickPickItem = vscode.QuickPickItem & { readonly branch: PushBranchOption };

function branchKey(branch: PushBranchOption): string {
    return `${branch.name}\u0000${branch.upstreamRemote}\u0000${branch.upstreamBranch}`;
}

/**
 * 选择一个或多个 Push 目标。上次成功 Push 的目标默认勾选并显示在列表顶部。
 */
export function pickPushBranches(
    branches: readonly PushBranchOption[],
    defaultBranches: readonly PushBranchOption[],
    localBranchLabel: string,
): Promise<PushBranchOption[] | undefined> {
    const quickPick = vscode.window.createQuickPick<PushBranchQuickPickItem>();
    const baseItems: PushBranchQuickPickItem[] = branches.map(branch => ({
        label: branch.upstreamName,
        detail: `未推送提交：${branch.recentUnpushedCommits.length}`,
        branch,
    }));
    const defaultKeys = new Set(defaultBranches.map(branchKey));
    const initialSelected = baseItems.filter(item => defaultKeys.has(branchKey(item.branch)));
    const initialSelectedKeys = new Set(initialSelected.map(item => branchKey(item.branch)));
    const orderedItems = [
        ...initialSelected,
        ...baseItems.filter(item => !initialSelectedKeys.has(branchKey(item.branch))),
    ];


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

/** 使用 QuickPick 展示 Push 完成/失败信息, 不依赖 VS Code 的系统 OK/Cancel 文案。 */
export function showPushResult(title: string, detail: string): Promise<void> {
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
    const item = {
        label: '$(check) 关闭',
        description: detail.split(/\r?\n/, 1)[0] || 'Git Push 已结束',
        detail,
    };
    quickPick.title = title;
    quickPick.placeholder = '按 Enter 或 Esc 关闭';
    quickPick.items = [item];
    quickPick.activeItems = [item];
    return new Promise(resolve => {
        const state = { settled: false };
        const finish = () => {
            if (state.settled) { return; }
            state.settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve();
        };
        quickPick.onDidAccept(finish);
        quickPick.onDidHide(finish);
        quickPick.show();
    });
}
