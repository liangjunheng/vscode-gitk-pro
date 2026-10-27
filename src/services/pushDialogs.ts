import * as vscode from 'vscode';
import type { PushPlan, PushSourceBranch, PushTargetOption } from '../git/gitLogProvider';

type PushTargetQuickPickItem = vscode.QuickPickItem & {
    readonly itemType: 'target';
    readonly target: PushTargetOption;
};
type CreatePushTargetQuickPickItem = vscode.QuickPickItem & { readonly itemType: 'create' };
type PushTargetPickerItem = PushTargetQuickPickItem | CreatePushTargetQuickPickItem;
type PushRemoteQuickPickItem = vscode.QuickPickItem & { readonly remote: string };

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

function buildTargetItems(targets: readonly PushTargetOption[]): PushTargetQuickPickItem[] {
    return targets.map(target => target.isNewBranch
        ? {
            label: `$(cloud) ${target.remoteName}`,
            description: `[${target.remote}] · [即将新建远程分支]`,
            detail: '确认推送后创建',
            itemType: 'target' as const,
            target,
        }
        : {
            label: `$(cloud) ${target.remoteName}`,
            description: `[${target.remote}]`,
            detail: `未推送提交：${target.unpushedCommitCount}`,
            itemType: 'target' as const,
            target,
        });
}

function validateNewRemoteBranchName(value: string): string | undefined {
    const branch = value.trim();
    if (!branch) { return '请输入新分支名'; }
    const forbidden = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
    const hasForbiddenCharacter = [...branch].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || forbidden.has(character);
    });
    const components = branch.split('/');
    if (branch === '@'
        || branch === 'HEAD'
        || branch.startsWith('-')
        || branch.endsWith('.')
        || branch.includes('..')
        || branch.includes('@{')
        || hasForbiddenCharacter
        || components.some(component => !component || component.startsWith('.') || component.endsWith('.lock'))) {
        return '分支名不符合 Git ref 命名规则';
    }
    return undefined;
}

/** 在一个原生 QuickPick 中输入新分支名并选择一个或多个 remote。 */
function pickNewPushTargets(
    plan: PushPlan,
    pendingTargets: readonly PushTargetOption[],
): Promise<PushTargetOption[] | undefined> {
    const remotes = [...new Set(plan.targets.map(target => target.remote).filter(Boolean))];
    const quickPick = vscode.window.createQuickPick<PushRemoteQuickPickItem>();
    // 只有一个 remote 时没有可选项, 默认勾选; 多个 remote 仍由用户自己选择。
    let selectedRemotes = new Set<string>(remotes.length === 1 ? remotes : []);
    let updatingItems = false;
    quickPick.title = '新增远程分支';
    quickPick.placeholder = '输入新分支名，并勾选目标 remote';
    quickPick.canSelectMany = true;
    quickPick.keepScrollPosition = true;
    quickPick.buttons = [{ iconPath: new vscode.ThemeIcon('close'), tooltip: '取消并返回' }];

    const renderItems = () => {
        const branch = quickPick.value.trim();
        const items: PushRemoteQuickPickItem[] = remotes.map(remote => ({
            label: `$(remote) ${remote}`,
            detail: branch ? `将新建 ${remote}/${branch}` : '勾选要创建新分支的 remote',
            alwaysShow: true,
            remote,
        }));
        updatingItems = true;
        quickPick.items = items;
        quickPick.selectedItems = items.filter(item => selectedRemotes.has(item.remote));
        updatingItems = false;
    };
    renderItems();

    return new Promise(resolve => {
        let settled = false;
        const finish = (value: PushTargetOption[] | undefined) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        quickPick.onDidChangeSelection(items => {
            if (!updatingItems) { selectedRemotes = new Set(items.map(item => item.remote)); }
        });
        quickPick.onDidChangeValue(() => {
            quickPick.title = '新建远程分支';
            renderItems();
        });
        quickPick.onDidAccept(() => {
            const branch = quickPick.value.trim();
            const validationError = validateNewRemoteBranchName(branch);
            if (validationError) {
                quickPick.title = `新增远程分支 — ${validationError}`;
                return;
            }
            if (selectedRemotes.size === 0) {
                quickPick.title = '新增远程分支 — 请至少勾选一个 remote';
                return;
            }
            const allTargets = [...plan.targets, ...pendingTargets];
            const duplicateRemotes = [...selectedRemotes].filter(remote =>
                allTargets.some(target => target.remote === remote && target.branch === branch));
            if (duplicateRemotes.length > 0) {
                quickPick.title = `新增远程分支 — ${duplicateRemotes.join('、')} 已存在同名分支`;
                return;
            }
            finish([...selectedRemotes].map(remote => ({
                remote,
                branch,
                remoteName: `${remote}/${branch}`,
                isUpstream: false,
                tipTimestamp: 0,
                unpushedCommitCount: 0,
                isNewBranch: true,
            })));
        });
        quickPick.onDidTriggerButton(() => finish(undefined));
        quickPick.onDidHide(() => finish(undefined));
        quickPick.show();
    });
}

/**
 * 多选 Push 目标。已有目标保持 getPushPlan 的排序；新建入口固定为第一项。
 * 打开时不预选任何远程分支；完成或取消新建流程后返回并恢复已有选择。
 */
export function pickPushTargets(plan: PushPlan): Promise<PushTargetOption[] | undefined> {
    const quickPick = vscode.window.createQuickPick<PushTargetPickerItem>();
    const pendingTargets = new Map<string, PushTargetOption>();
    const selectedTargetKeys = new Set<string>();
    const createItem: CreatePushTargetQuickPickItem = {
        label: '$(add) 新增远程分支…',
        detail: '输入新分支名并选择目标 remote',
        alwaysShow: true,
        itemType: 'create',
    };
    let switchingToCreate = false;
    let updatingSelection = false;

    quickPick.title = `${describeSourceLabel(plan.source)} 要推送的远程分支`;
    quickPick.placeholder = '勾选后按 Enter 提交，按 Esc 取消';
    quickPick.canSelectMany = true;
    quickPick.keepScrollPosition = true;
    quickPick.buttons = [{ iconPath: new vscode.ThemeIcon('close'), tooltip: '关闭' }];

    const renderItems = () => {
        const targetItems = buildTargetItems([...pendingTargets.values(), ...plan.targets]);
        updatingSelection = true;
        quickPick.items = [createItem, ...targetItems];
        quickPick.selectedItems = targetItems.filter(item => selectedTargetKeys.has(targetKey(item.target)));
        updatingSelection = false;
    };
    renderItems();

    return new Promise(resolve => {
        let settled = false;
        const finish = (value: PushTargetOption[] | undefined) => {
            if (settled) { return; }
            settled = true;
            quickPick.hide();
            quickPick.dispose();
            resolve(value);
        };
        const openCreatePicker = async () => {
            if (switchingToCreate) { return; }
            switchingToCreate = true;
            quickPick.hide();
            const createdTargets = await pickNewPushTargets(plan, [...pendingTargets.values()]);
            for (const target of createdTargets ?? []) {
                pendingTargets.set(targetKey(target), target);
                selectedTargetKeys.add(targetKey(target));
            }
            if (createdTargets && createdTargets.length > 0) { quickPick.value = ''; }
            renderItems();
            switchingToCreate = false;
            quickPick.show();
        };
        quickPick.onDidChangeSelection(items => {
            if (updatingSelection) { return; }
            selectedTargetKeys.clear();
            for (const item of items) {
                if (item.itemType === 'target') { selectedTargetKeys.add(targetKey(item.target)); }
            }
            if (items.some(item => item.itemType === 'create')) {
                updatingSelection = true;
                quickPick.selectedItems = items.filter((item): item is PushTargetQuickPickItem => item.itemType === 'target');
                updatingSelection = false;
                void openCreatePicker();
            }
        });
        quickPick.onDidAccept(() => finish(
            quickPick.selectedItems
                .filter((item): item is PushTargetQuickPickItem => item.itemType === 'target')
                .map(item => item.target),
        ));
        quickPick.onDidTriggerButton(() => finish(undefined));
        quickPick.onDidHide(() => {
            if (!switchingToCreate) { finish(undefined); }
        });
        quickPick.show();
    });
}

/** 单选 Push 目标: 子模块卡片每个仓库只记录一个远程分支。 */
export function pickPushTarget(
    plan: PushPlan,
    defaultTarget?: PushTargetOption,
): Promise<PushTargetOption | undefined> {
    const quickPick = vscode.window.createQuickPick<PushTargetQuickPickItem>();
    const items = buildTargetItems(plan.targets);
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

/** 一行推送目标的纯文本形式, 供通知与进度复用。 */
export function describePushRow(row: PushConfirmRow): string {
    const prefix = row.repositoryLabel ? `${row.repositoryLabel}：` : '';
    return `${prefix}${describeSourceLabel(row.source)} → ${row.target.remoteName}（提交 ${shortHash(row.source.hash)}）`;
}

/** 确认弹窗里的推送目标, 不展示提交 hash。 */
function describePushConfirmationRow(row: PushConfirmRow): string {
    const prefix = row.repositoryLabel ? `${row.repositoryLabel}：` : '';
    return `${prefix}${describeSourceLabel(row.source)} → ${row.target.remoteName}${row.target.isNewBranch ? '（即将新建远程分支）' : ''}`;
}

function pushRemoteDetail(pushRemotes: readonly string[]): string {
    const remotes = [...new Set(pushRemotes.filter(Boolean))];
    return `推送到远程仓库：${remotes.length > 0 ? remotes.join('、') : '无'}`;
}

/** 原生模态弹窗逐行展示推送分支, 显式取消项同时承接 Esc 和关闭操作。 */
export async function confirmPush(
    rows: readonly PushConfirmRow[],
    repositoryLabel?: string,
    pushRemotes: readonly string[] = [],
): Promise<boolean> {
    const pushItem: vscode.MessageItem = { title: '推送' };
    const cancelItem: vscode.MessageItem = { title: '取消', isCloseAffordance: true };
    const repositoryDetail = repositoryLabel ? `仓库名：${repositoryLabel}\n` : '';
    const choice = await vscode.window.showInformationMessage(
        '确认推送',
        { modal: true, detail: `${repositoryDetail}${pushRemoteDetail(pushRemotes)}\n\n需要推送的分支：\n${rows.map(describePushConfirmationRow).join('\n')}` },
        pushItem,
        cancelItem,
    );
    return choice === pushItem;
}

/** 同步确认的结果: sync = 先拉取再推送, push = 跳过拉取只推送。 */
export type SyncChoice = 'sync' | 'push';

/**
 * 同步确认弹窗始终显示「同步 / 仅推送 / 取消」。
 * pullFrom 是「同步」会先拉取的远程分支(多仓库时已带仓库名前缀); repositoryLabel 显示在弹窗内容顶部。
 */
export async function confirmSync(
    rows: readonly PushConfirmRow[],
    pullFrom: readonly string[],
    repositoryLabel?: string,
    pushRemotes: readonly string[] = [],
): Promise<SyncChoice | undefined> {
    const syncItem: vscode.MessageItem = { title: '同步' };
    const pushOnlyItem: vscode.MessageItem = { title: '仅推送' };
    const cancelItem: vscode.MessageItem = { title: '取消', isCloseAffordance: true };
    const repositoryDetail = repositoryLabel ? `仓库名：${repositoryLabel}\n` : '';
    const choice = await vscode.window.showInformationMessage(
        '确认同步',
        {
            modal: true,
            detail: `${repositoryDetail}${pushRemoteDetail(pushRemotes)}\n\n先拉取：\n${pullFrom.length > 0 ? pullFrom.join('\n') : '无可拉取的远程分支，将直接推送'}\n\n需要推送的分支：\n${rows.map(describePushConfirmationRow).join('\n')}\n\n同步按钮：先拉取，再推送。`,
        },
        syncItem,
        pushOnlyItem,
        cancelItem,
    );
    return choice === syncItem ? 'sync' : choice === pushOnlyItem ? 'push' : undefined;
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
