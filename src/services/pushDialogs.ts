import * as vscode from 'vscode';
import type { PushPlan, PushSourceBranch, PushTargetOption } from '../git/gitLogProvider';

type PushTargetQuickPickItem = vscode.QuickPickItem & { readonly target: PushTargetOption };

/** 远程分支身份只由 remote + branch 决定; 两次读取得到的对象引用不同, 不能用引用比较。 */
function targetKey(target: PushTargetOption): string {
    return `${target.remote}\u0000${target.branch}`;
}

function shortHash(hash: string): string {
    return hash.slice(0, 8);
}

/** 推送源的完整描述: 分支名与提交 hash 分别标注, 互不替代。 */
export function describePushSource(source: PushSourceBranch): string {
    return source.branchName
        ? `分支 ${source.branchName}（提交 ${shortHash(source.hash)}）`
        : `游离 HEAD（提交 ${shortHash(source.hash)}）`;
}

/** 标题栏文案: 用仓库卡片显示的分支名, detached HEAD 才退回短 hash。 */
function describeSourceLabel(source: PushSourceBranch): string {
    return source.branchName ?? `游离 HEAD ${shortHash(source.hash)}`;
}

function buildTargetItems(plan: PushPlan): PushTargetQuickPickItem[] {
    return plan.targets.map(target => ({
        label: `$(cloud) ${target.remoteName}`,
        description: `未推送提交：${target.unpushedCommitCount}`,
        detail: `${describePushSource(plan.source)} → ${target.remoteName}`,
        target,
    }));
}

/**
 * 多选 Push 目标。列表顺序由 getPushPlan 决定(绑定 upstream 优先, 其余按远程 tip 时间倒序),
 * 默认目标只影响勾选, 不参与排序; 标题栏显示仓库卡片上的本地分支名。
 */
export function pickPushTargets(
    plan: PushPlan,
    defaultTargets: readonly PushTargetOption[],
): Promise<PushTargetOption[] | undefined> {
    const quickPick = vscode.window.createQuickPick<PushTargetQuickPickItem>();
    const items = buildTargetItems(plan);
    const defaultKeys = new Set(defaultTargets.map(targetKey));
    quickPick.title = `${describeSourceLabel(plan.source)} 要推送的远程分支`;
    quickPick.placeholder = '勾选后按 Enter 提交，按 Esc 取消';
    quickPick.canSelectMany = true;
    quickPick.keepScrollPosition = true;
    quickPick.buttons = [{
        iconPath: new vscode.ThemeIcon('close'),
        tooltip: '关闭',
    }];
    quickPick.items = items;
    quickPick.selectedItems = items.filter(item => defaultKeys.has(targetKey(item.target)));

    return new Promise(resolve => {
        let settled = false;
        const finish = (value: PushTargetOption[] | undefined) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidAccept(() => finish(quickPick.selectedItems.map(item => item.target)));
        quickPick.onDidTriggerButton(() => finish(undefined));
        quickPick.onDidHide(() => finish(undefined));
        quickPick.show();
    });
}

/** 单选 Push 目标: 子模块卡片每个仓库只记录一个远程分支。 */
export function pickPushTarget(
    plan: PushPlan,
    defaultTarget?: PushTargetOption,
): Promise<PushTargetOption | undefined> {
    const quickPick = vscode.window.createQuickPick<PushTargetQuickPickItem>();
    const items = buildTargetItems(plan);
    quickPick.items = items;
    quickPick.title = `${describeSourceLabel(plan.source)} 要推送的远程分支`;
    quickPick.placeholder = '选择要推送的远程分支';
    const activeItem = defaultTarget
        ? items.find(item => targetKey(item.target) === targetKey(defaultTarget))
        : undefined;
    if (activeItem) { quickPick.activeItems = [activeItem]; }
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: PushTargetOption | undefined) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidAccept(() => finish(quickPick.activeItems[0]?.target));
        quickPick.onDidHide(() => finish(undefined));
        quickPick.show();
    });
}

/** 确认弹窗里的一行推送目标: 本地分支名 → 远程分支名, 提交 hash 单独标注。 */
export interface PushConfirmRow {
    readonly source: PushSourceBranch;
    readonly target: PushTargetOption;
    /** 多仓库推送时标注仓库名, 单仓库留空。 */
    readonly repositoryLabel?: string;
}

type PushConfirmItem = vscode.QuickPickItem & { readonly action: 'push' | 'cancel' };

/** 一行推送目标的纯文本形式, 供通知与进度复用。 */
export function describePushRow(row: PushConfirmRow): string {
    const prefix = row.repositoryLabel ? `${row.repositoryLabel}：` : '';
    return `${prefix}${describeSourceLabel(row.source)} → ${row.target.remoteName}（提交 ${shortHash(row.source.hash)}）`;
}

/**
 * 使用 QuickPick 弹窗确认 Push, 不依赖通知或 VS Code 的系统 OK/Cancel 文案。
 * 推送按钮下面逐行列出目标: 左边是仓库卡片上的本地分支名, 右边是远程分支名,
 * 提交 hash 放在该行的 detail 里, 不与分支名互换。
 */
export function confirmPush(rows: readonly PushConfirmRow[]): Promise<boolean> {
    const quickPick = vscode.window.createQuickPick<PushConfirmItem>();
    const pushItem: PushConfirmItem = {
        label: '$(cloud-upload) 推送',
        detail: rows.length === 1 ? '推送下面 1 个远程分支' : `推送下面 ${rows.length} 个远程分支`,
        action: 'push',
    };
    // 目标行也归属 push 动作: 它们是确认内容, 点中任意一行等同于确认整个推送计划。
    const targetItems: PushConfirmItem[] = rows.map(row => ({
        label: `$(git-branch) ${describeSourceLabel(row.source)} $(arrow-right) $(cloud) ${row.target.remoteName}`,
        description: row.repositoryLabel,
        detail: `提交 ${shortHash(row.source.hash)}`,
        action: 'push',
    }));
    const cancelItem: PushConfirmItem = {
        label: '$(close) 取消',
        detail: '放弃本次远程推送',
        action: 'cancel',
    };
    quickPick.title = '确认推送';
    quickPick.placeholder = '请选择操作；按 Esc 也可以取消';
    quickPick.items = [pushItem, ...targetItems, cancelItem];
    quickPick.activeItems = [pushItem];
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