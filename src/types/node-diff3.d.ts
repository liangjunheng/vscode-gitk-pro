declare module 'node-diff3' {
    export function diff3Merge<T>(a: T[], base: T[], b: T[], options: { excludeFalseConflicts: boolean }): Array<{
        ok?: T[];
        conflict?: { a: T[]; aIndex: number; b: T[]; bIndex: number; o: T[]; oIndex: number };
    }>;
}
