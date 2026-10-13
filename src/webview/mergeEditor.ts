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

function lines(text: string): string[] {
    return text.replace(/\r\n/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
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
    } else if (text !== plan.result) {
        // Never silently regenerate an edited result or unrecognized markers.
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
        if (!c || (this.manualOnly && choice !== 'manual')) { return; }
        if (choice === 'manual') { c.choice = choice; return; }
        const text = choice === 'both' ? c.current + c.incoming
            : choice === 'incomingFirst' ? c.incoming + c.current : c[choice];
        const edit = { start: c.start, end: c.end, text };
        this.edit(edit.start, edit.end - edit.start, text, id);
        c.start = edit.start; c.end = edit.start + text.length; c.choice = choice;
        return edit;
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
}

export function mergeEditorBrowserSource(): string { return `const MergeEditor = ${MergeEditor.toString()};`; }
