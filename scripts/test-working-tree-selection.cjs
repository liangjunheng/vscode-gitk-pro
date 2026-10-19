const assert = require('node:assert/strict');
const { CommitFile } = require('../out/types');
const { resolveWorkingTreeSelection } = require('../out/webview/workingTreeSelection');

function file(group, name) {
  return new CommitFile({ path: name, diffKey: `${group}:${name}`, workingTreeKind: group });
}

function pick(previous, next, selected) {
  return resolveWorkingTreeSelection(previous, next, selected);
}

const mergeA = file('conflict', 'merge-a');
const mergeB = file('conflict', 'merge-b');
const unstagedA = file('unstaged', 'unstaged-a');
const unstagedB = file('unstaged', 'unstaged-b');
const stagedA = file('staged', 'staged-a');
const moved = file('unstaged', 'same-path');
const movedStaged = file('staged', 'same-path');
const laterA = file('later', 'later-a');
const laterB = file('later', 'later-b');
const untrackedA = new CommitFile({ path: 'untracked-a', diffKey: 'unstaged:untracked-a', workingTreeKind: 'untracked' });

assert.equal(pick([mergeA, mergeB], [mergeB], mergeA.diffKey), mergeB.diffKey, 'same group prefers the next item');
assert.equal(pick([mergeA, mergeB, stagedA], [mergeA, stagedA], mergeB.diffKey), mergeA.diffKey, 'a remaining item in the same group wins before crossing groups');
assert.equal(pick([unstagedA, unstagedB], [unstagedA], unstagedB.diffKey), unstagedA.diffKey, 'same group falls back to the previous item at the end');
assert.equal(pick([unstagedA, unstagedB], [unstagedA, unstagedB], unstagedA.diffKey), unstagedA.diffKey, 'existing selection is preserved');
assert.equal(pick([mergeA, unstagedA, stagedA], [unstagedA, stagedA], mergeA.diffKey), unstagedA.diffKey, 'empty group prefers the next group');
assert.equal(pick([mergeA, unstagedA, stagedA, laterA], [stagedA, laterA], mergeA.diffKey), stagedA.diffKey, 'multiple empty groups skip to the next remaining group');
assert.equal(pick([mergeA, unstagedA, stagedA, laterA, laterB], [mergeA, laterA, laterB], unstagedA.diffKey), laterA.diffKey, 'empty group prefers the next group even when an intermediate group remains empty');
assert.equal(pick([unstagedA, stagedA], [unstagedA], stagedA.diffKey), unstagedA.diffKey, 'empty last group falls back to the previous group');
assert.equal(pick([moved], [movedStaged], moved.diffKey), movedStaged.diffKey, 'same path in another group follows the new group');
assert.equal(pick([untrackedA, stagedA], [stagedA], untrackedA.diffKey), stagedA.diffKey, 'untracked follows the unstaged group');
assert.equal(pick([unstagedA], [], unstagedA.diffKey), undefined, 'empty worktree clears selection');

console.log('working-tree selection tests passed');
