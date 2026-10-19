import type { CommitFile } from '../types';

function workingTreeGroup(file: CommitFile): string {
    return file.workingTreeKind === 'untracked' ? 'unstaged' : (file.workingTreeKind ?? '');
}

/** Resolve the next worktree file after the current list item disappears. */
export function resolveWorkingTreeSelection(
    previousFiles: readonly CommitFile[],
    nextFiles: readonly CommitFile[],
    selectedDiffKey: string | undefined,
): string | undefined {
    if (!selectedDiffKey || nextFiles.length === 0) { return undefined; }
    if (nextFiles.some(file => (file.diffKey || file.path) === selectedDiffKey)) { return selectedDiffKey; }
    const previousSelectedIndex = previousFiles.findIndex(file => (file.diffKey || file.path) === selectedDiffKey);
    if (previousSelectedIndex < 0) { return nextFiles[0]?.diffKey || nextFiles[0]?.path; }
    const groups = new Map<string, CommitFile[]>();
    const groupOrder: string[] = [];
    for (const file of previousFiles) {
        const group = workingTreeGroup(file);
        if (!groups.has(group)) { groups.set(group, []); groupOrder.push(group); }
        groups.get(group)!.push(file);
    }
    const nextGroups = new Map<string, CommitFile[]>();
    for (const file of nextFiles) {
        const group = workingTreeGroup(file);
        const files = nextGroups.get(group);
        if (files) { files.push(file); } else { nextGroups.set(group, [file]); }
    }
    for (const group of nextGroups.keys()) {
        if (!groups.has(group)) { groupOrder.push(group); }
    }
    const previousSelectedFile = previousFiles[previousSelectedIndex];
    const selectedGroup = workingTreeGroup(previousSelectedFile);
    const oldGroupFiles = groups.get(selectedGroup) ?? [];
    const oldGroupIndex = oldGroupFiles.findIndex(file => (file.diffKey || file.path) === selectedDiffKey);
    const newGroupFiles = nextGroups.get(selectedGroup) ?? [];
    const fallback = newGroupFiles[oldGroupIndex] ?? newGroupFiles[oldGroupIndex - 1];
    if (fallback) { return fallback.diffKey || fallback.path; }
    const selectedGroupIndex = groupOrder.indexOf(selectedGroup);
    const nextGroup = groupOrder.slice(selectedGroupIndex + 1).find(group => nextGroups.has(group));
    const previousGroup = groupOrder.slice(0, selectedGroupIndex).reverse().find(group => nextGroups.has(group));
    const crossGroupFallback = nextGroups.get(nextGroup)?.[0] ?? nextGroups.get(previousGroup)?.at(-1);
    return crossGroupFallback?.diffKey || crossGroupFallback?.path;
}
