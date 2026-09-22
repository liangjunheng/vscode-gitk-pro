import * as vscode from 'vscode';
import type { PushBranchOption } from '../git/gitLogProvider';

type PushBranchQuickPickItem = vscode.QuickPickItem & { readonly branch: PushBranchOption };

function branchKey(branch: PushBranchOption): string {
    return `${branch.name}\u0000${branch.upstreamRemote}\u0000${branch.upstreamBranch}`;
}

/**
 * 选择一个或多个 Push 目标。已选项会自动移动到列表顶部, 并保持勾选状态。
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
    const findItem = (key: string) => baseItems.find(item => branchKey(item.branch) === key);
    const initialSelected = baseItems.filter(item => defaultKeys.has(branchKey(item.branch)));
    const sortItems = (selected: readonly PushBranchQuickPickItem[]) => {
        const selectedKeys = new Set(selected.map(item => branchKey(item.branch)));
        return [...baseItems].sort((left, right) => {
            const leftSelected = selectedKeys.has(branchKey(left.branch));
            const rightSelected = selectedKeys.has(branchKey(right.branch));
            return Number(rightSelected) - Number(leftSelected);
        });
    };

    quickPick.title = `${localBranchLabel} 要推送的远程分支`;
    quickPick.placeholder = '勾选后按 Enter 提交，按 Esc 取消';
    quickPick.canSelectMany = true;
    quickPick.items = sortItems(initialSelected);
    quickPick.selectedItems = initialSelected;

    return new Promise(resolve => {
        let settled = false;
        let reordering = false;
        const finish = (value: PushBranchOption[] | undefined) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidChangeSelection(selected => {
            if (reordering) { return; }
            reordering = true;
            const selectedKeys = new Set(selected.map(item => branchKey(item.branch)));
            const activeKey = quickPick.activeItems[0] ? branchKey(quickPick.activeItems[0].branch) : undefined;
            quickPick.items = sortItems(selected);
            quickPick.selectedItems = quickPick.items.filter(item => selectedKeys.has(branchKey(item.branch)));
            const activeItem = activeKey ? findItem(activeKey) : undefined;
            if (activeItem) {
                const reorderedActiveItem = quickPick.items.find(item => branchKey(item.branch) === activeKey);
                if (reorderedActiveItem) { quickPick.activeItems = [reorderedActiveItem]; }
            }
            reordering = false;
        });
        quickPick.onDidAccept(() => {
            finish(quickPick.selectedItems.map(item => item.branch));
        });
        quickPick.onDidHide(() => finish(undefined));
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
