// The build copies the runtime beside this module; VSIX excludes node_modules.
const { diff3Merge }: typeof import('node-diff3') = require('./vendor/diff3.cjs');

export type MergeChoice = 'base' | 'current' | 'incoming' | 'both' | 'incomingFirst' | 'manual';
export interface MergeConflict {
    id: number; start: number; end: number;
    base: string; current: string; incoming: string;
    baseLine: number; currentLine: number; incomingLine: number;
    choice?: MergeChoice;
}
export interface MergePlan { result: string; conflicts: MergeConflict[]; manualOnly: boolean; }
export interface MergeInputLabels { currentLabel: string; incomingLabel: string; }

function lines(text: string): string[] {
    return text.replace(/\r\n/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function uniqueContextIndex(text: string, anchor: string, from: number): number | undefined {
    const index = text.indexOf(anchor, from);
    return index >= 0 && text.indexOf(anchor, index + 1) < 0 ? index : undefined;
}

function contextCandidates(text: string, offset: number, direction: 'before' | 'after'): string[] {
    const parts = direction === 'before' ? lines(text.slice(0, offset)) : lines(text.slice(offset));
    const candidates: string[] = [];
    for (let count = Math.min(3, parts.length); count >= 1; count--) {
        const candidate = direction === 'before' ? parts.slice(-count).join('') : parts.slice(0, count).join('');
        if (candidate.trim() && !candidates.includes(candidate)) { candidates.push(candidate); }
    }
    return candidates;
}

/** Recover safe insertion-conflict anchors in a marker-free, manually edited Result. */
function reconcileMarkerFreeInsertions(plan: MergePlan, text: string): boolean {
    if (!plan.conflicts.length || plan.conflicts.some(conflict => conflict.base.length > 0)) { return false; }
    let cursor = 0;
    for (const conflict of plan.conflicts) {
        const before = contextCandidates(plan.result, conflict.start, 'before');
        const after = contextCandidates(plan.result, conflict.end, 'after');
        let beforeEnd: number | undefined;
        for (const anchor of before) {
            const index = uniqueContextIndex(text, anchor, cursor);
            if (index !== undefined) { beforeEnd = index + anchor.length; break; }
        }
        let afterStart: number | undefined;
        for (const anchor of after) {
            const index = uniqueContextIndex(text, anchor, beforeEnd ?? cursor);
            if (index !== undefined) { afterStart = index; break; }
        }
        if (beforeEnd === undefined && afterStart === undefined) { return false; }
        const boundary = afterStart ?? beforeEnd!;
        const choices: Array<{ choice: MergeChoice; text: string }> = [
            { choice: 'both', text: conflict.current + conflict.incoming },
            { choice: 'incomingFirst', text: conflict.incoming + conflict.current },
            { choice: 'current', text: conflict.current },
            { choice: 'incoming', text: conflict.incoming },
        ];
        choices.sort((left, right) => right.text.length - left.text.length);
        const accepted = choices.find(candidate => candidate.text.length > 0
            && boundary >= candidate.text.length
            && text.slice(boundary - candidate.text.length, boundary) === candidate.text);
        conflict.start = accepted ? boundary - accepted.text.length : boundary;
        conflict.end = boundary;
        conflict.choice = accepted?.choice;
        cursor = boundary;
    }
    plan.result = text;
    return true;
}

/** Conflict-marker labels are used only for presentation; stage 2/3 remain the source of truth. */
export function mergeInputLabels(worktree?: string | null): MergeInputLabels {
    const labels: MergeInputLabels = { currentLabel: 'Current', incomingLabel: 'Incoming' };
    if (!worktree) { return labels; }
    const current = worktree.match(/^<{7,}\s*([^\r\n]*)/m)?.[1]?.trim() ?? '';
    const incoming = worktree.match(/^>{7,}\s*([^\r\n]*)/m)?.[1]?.trim() ?? '';
    // libgit2's stash apply uses "Updated upstream" / "Stashed changes".
    // Keep the stage-2 side named Current, matching VS Code's conflict terminology.
    if (/^stashed changes$/i.test(incoming)) { labels.incomingLabel = 'Stashed Changes'; }
    else if (/^incoming$/i.test(incoming)) { labels.incomingLabel = 'Incoming'; }
    if (/^current$/i.test(current)) { labels.currentLabel = 'Current'; }
    return labels;
}

/** Diff3 handles automatic and identical changes before exposing conflicts. */
export function createMergePlan(base: string, current: string, incoming: string, worktree?: string): MergePlan {
    const regions = diff3Merge(lines(current), lines(base), lines(incoming), { excludeFalseConflicts: true });
    const plan: MergePlan = { result: '', conflicts: [], manualOnly: false };
    for (const region of regions) {
        if (region.ok) { plan.result += region.ok.join(''); continue; }
        const c = region.conflict!, start = plan.result.length;
        plan.result += c.o.join('');
        plan.conflicts.push({ id: plan.conflicts.length, start, end: plan.result.length,
            base: c.o.join(''), current: c.a.join(''), incoming: c.b.join(''),
            baseLine: c.oIndex + 1, currentLine: c.aIndex + 1, incomingLine: c.bIndex + 1 });
    }
    if (worktree === undefined) { return plan; }
    const text = worktree.replace(/\r\n/g, '\n');
    const marker = /^<{7,}[^\n]*\n([\s\S]*?)(?:^\|{7,}[^\n]*\n[\s\S]*?)?^={7,}[^\n]*\n([\s\S]*?)^>{7,}[^\n]*(?:\n|$)/gm;
    const matches = [...text.matchAll(marker)];
    if (matches.length === plan.conflicts.length && matches.length > 0
        && matches.every((m, i) => m[1] === plan.conflicts[i].current && m[2] === plan.conflicts[i].incoming)) {
        let result = '', cursor = 0;
        matches.forEach((m, i) => {
            result += text.slice(cursor, m.index);
            const c = plan.conflicts[i];
            c.start = result.length; result += c.base; c.end = result.length;
            cursor = m.index! + m[0].length;
        });
        plan.result = result + text.slice(cursor);
    } else if (text !== plan.result && !reconcileMarkerFreeInsertions(plan, text)) {
        // Never silently regenerate an edited result that cannot be anchored safely.
        plan.result = text; plan.manualOnly = true;
    }
    return plan;
}

/** Offset edits preserve unrelated manual changes when selecting conflict inputs. */
export class MergeEditor {
    result: string;
    conflicts: MergeConflict[];
    manualOnly: boolean;
    constructor(plan: MergePlan) {
        this.result = plan.result;
        this.conflicts = plan.conflicts.map(c => ({ ...c }));
        this.manualOnly = plan.manualOnly;
    }
    get remaining(): number { return this.conflicts.filter(c => !c.choice).length; }
    choose(id: number, choice: MergeChoice): { start: number; end: number; text: string } | undefined {
        const c = this.conflicts.find(item => item.id === id);
        if (!c || (this.manualOnly && choice !== 'manual' && c.base.length > 0)) { return; }
        if (choice === 'manual') { c.choice = choice; return; }
        const text = this.choiceText(c, choice);
        return this.replaceConflict(c, choice, text);
    }
    /** VS Code-style Ignore removes only that input; ignoring both restores the unresolved base. */
    ignore(id: number, side: 'current' | 'incoming'): { start: number; end: number; text: string } | undefined {
        const c = this.conflicts.find(item => item.id === id);
        if (!c || (this.manualOnly && c.base.length > 0)) { return; }
        let choice: Exclude<MergeChoice, 'manual'> | undefined;
        if (side === 'current') {
            if (c.choice === 'current') { choice = undefined; }
            else if (c.choice === 'both' || c.choice === 'incomingFirst') { choice = 'incoming'; }
            else { return; }
        } else {
            if (c.choice === 'incoming') { choice = undefined; }
            else if (c.choice === 'both' || c.choice === 'incomingFirst') { choice = 'current'; }
            else { return; }
        }
        return this.replaceConflict(c, choice, choice ? this.choiceText(c, choice) : c.base);
    }
    edit(offset: number, length: number, text: string, selectedId?: number): void {
        const end = offset + length, delta = text.length - length;
        this.result = this.result.slice(0, offset) + text + this.result.slice(end);
        for (const c of this.conflicts) {
            if (c.id === selectedId) { continue; }
            if (end < c.start || (end === c.start && (length > 0 || offset < c.start))) {
                c.start += delta; c.end += delta;
            } else if (offset < c.end || (c.start === c.end && offset === c.start)) {
                c.start = Math.min(c.start, offset);
                c.end = Math.max(c.start, Math.max(end, c.end) + delta);
                c.choice = undefined;
            }
        }
    }
    markAllHandled(): void { this.conflicts.forEach(c => { c.choice = 'manual'; }); }

    private choiceText(c: MergeConflict, choice: Exclude<MergeChoice, 'manual'>): string {
        return choice === 'both' ? c.current + c.incoming
            : choice === 'incomingFirst' ? c.incoming + c.current : c[choice];
    }
    private replaceConflict(c: MergeConflict, choice: MergeChoice | undefined, text: string): { start: number; end: number; text: string } {
        const edit = { start: c.start, end: c.end, text };
        this.edit(edit.start, edit.end - edit.start, text, c.id);
        c.start = edit.start; c.end = edit.start + text.length; c.choice = choice;
        return edit;
    }
}

export function mergeEditorBrowserSource(): string { return `const MergeEditor = ${MergeEditor.toString()};`; }
