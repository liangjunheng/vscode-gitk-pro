const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const original = Module._load;
const { classifyStashOperationError } = require('../out/git/stashOperationError');
let beginStashOperation, clearStashOperation, identifyStashConflict, markStashOperationConflicted, readMergeOperation, runMergeOperation, writeStashOperation;
try {
    Module._load = function(name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
    ({ beginStashOperation, clearStashOperation, identifyStashConflict, markStashOperationConflicted, readMergeOperation, runMergeOperation, writeStashOperation } = require('../out/git/mergeOperation'));
} finally { Module._load = original; }
async function main() {
    assert.equal(classifyStashOperationError(new Error('No stash found.')), 'no-stash');
    assert.equal(classifyStashOperationError(new Error('Your local changes would be overwritten')), 'local-changes-overwritten');
    assert.equal(classifyStashOperationError(new Error('CONFLICT (content): Merge conflict')), 'stash-conflict');
    assert.equal(classifyStashOperationError(new Error('index is not clean')), 'uncommitted-index');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-continue-'));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
    const uri = { fsPath: root };
    try {
        git('init'); git('config','user.name','Test');git('config','user.email','test@example.com');git('config','core.autocrlf','false');
        const file=path.join(root,'file.gkt');fs.writeFileSync(file,'base\n');git('add','.');git('commit','-m','base');
        const branch=git('branch','--show-current');git('checkout','-b','incoming');
        fs.writeFileSync(file,'incoming\n');git('commit','-am','incoming');git('checkout',branch);
        fs.writeFileSync(file,'current\n');git('commit','-am','current');
        const head=git('rev-parse','HEAD');
        const merge=()=>{try{git('merge','incoming')}catch{}};
        merge();assert.equal(await readMergeOperation(uri),'merge');
        await assert.rejects(()=>runMergeOperation(uri,'rebase','abort'),/已改变/);
        await assert.rejects(()=>runMergeOperation(uri,'merge','continue'),/暂存/);
        fs.writeFileSync(path.join(root,'unrelated.gkt'),'preserve\n');
        await runMergeOperation(uri,'merge','abort');
        assert.equal(git('rev-parse','HEAD'),head);assert.equal(fs.readFileSync(file,'utf8'),'current\n');
        assert.equal(fs.readFileSync(path.join(root,'unrelated.gkt'),'utf8'),'preserve\n');
        assert.equal(await readMergeOperation(uri),undefined);
        merge();fs.writeFileSync(file,'resolved\n');git('add','file.gkt');
        await runMergeOperation(uri,'merge','continue');
        assert.equal(await readMergeOperation(uri),undefined);
        assert.equal(git('rev-list','--parents','-n','1','HEAD').split(' ').length,3);
        assert.equal(git('show','HEAD:file.gkt'),'resolved');

        const stagedFile = path.join(root, 'staged.gkt');
        const unstagedFile = path.join(root, 'unstaged.gkt');
        const untrackedFile = path.join(root, 'untracked.gkt');
        const stashNewFile = path.join(root, 'stash-new.gkt');
        fs.writeFileSync(stagedFile, 'base staged\n');
        fs.writeFileSync(unstagedFile, 'base unstaged\n');
        git('add', 'staged.gkt', 'unstaged.gkt');
        git('commit', '-m', 'stash baseline');
        fs.writeFileSync(file, 'stashed value\n');
        fs.writeFileSync(stashNewFile, 'stashed new\n');
        git('stash', 'push', '-u', '-m', 'operation');
        const stashHash = git('rev-parse', 'refs/stash');
        fs.writeFileSync(file, 'upstream value\n');
        git('add', 'file.gkt');
        git('commit', '-m', 'stash upstream');
        const stashHead = git('rev-parse', 'HEAD');
        await assert.rejects(
            () => writeStashOperation(uri, 'stash-apply', stashHash, stashHead, ['../outside']),
            /无效路径/,
        );

        const markerPath = path.join(root, '.git', 'fastergit-stash-operation.json');
        fs.writeFileSync(file, 'pre-existing local value\n');
        await writeStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt'], 'applying');
        assert.equal(await readMergeOperation(uri), 'stash-apply', 'an applying marker still blocks another Stash operation');
        assert.equal(await readMergeOperation(uri, false), undefined, 'an applying marker is never exposed as an actionable Merge Changes operation');
        const applyingMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        assert.equal(applyingMarker.version, 3);
        assert.equal(applyingMarker.action, 'stash-apply');
        assert.equal(applyingMarker.phase, 'applying');
        assert.equal(applyingMarker.stash, stashHash);
        assert.equal(applyingMarker.head, stashHead);
        assert.deepEqual(applyingMarker.paths, ['file.gkt']);
        assert.deepEqual(applyingMarker.conflictPaths, []);
        assert.match(applyingMarker.operationId, /^[0-9a-f-]{16,64}$/i);
        assert.equal(typeof applyingMarker.processId, 'number');
        assert.equal(typeof applyingMarker.startedAt, 'number');
        assert.equal(fs.existsSync(path.join(root, '.git', 'fastergit-stash-checkpoints', applyingMarker.operationId, 'manifest.json')), true);
        await assert.rejects(() => runMergeOperation(uri, 'stash-apply', 'continue'), /不能继续或中止/);
        await assert.rejects(() => runMergeOperation(uri, 'stash-apply', 'abort'), /不能继续或中止/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'pre-existing local value\n', 'Abort never resets pre-existing worktree data while Apply is still unconfirmed');
        git('checkout', '--', 'file.gkt');
        await writeStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt', 'stash-new.gkt'], 'conflicted');
        const conflictedMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        assert.equal(conflictedMarker.version, 3);
        assert.equal(conflictedMarker.phase, 'conflicted');
        assert.equal(conflictedMarker.operationId, applyingMarker.operationId);
        assert.deepEqual(conflictedMarker.paths, ['file.gkt', 'stash-new.gkt']);
        await clearStashOperation(uri);
        assert.equal(fs.existsSync(path.join(root, '.git', 'fastergit-stash-checkpoints', applyingMarker.operationId)), false, 'clearing the marker removes its checkpoint');

        fs.writeFileSync(file, 'checkpoint preimage\n');
        const checkpointHandle = await beginStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt'], ['file.gkt']);
        fs.writeFileSync(file, 'checkpoint postimage\n');
        await markStashOperationConflicted(uri, checkpointHandle, ['file.gkt'], ['file.gkt']);
        const abortingMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        fs.writeFileSync(markerPath, JSON.stringify({ ...abortingMarker, phase: 'aborting' }));
        await runMergeOperation(uri, 'stash-apply', 'abort');
        assert.equal(fs.readFileSync(file, 'utf8'), 'checkpoint preimage\n', 'Abort restores the exact pre-operation worktree bytes, not HEAD');
        const checkpointStatus = git('status', '--porcelain').split(/\r?\n/);
        assert.ok(checkpointStatus.some(line => line.endsWith(' file.gkt')), checkpointStatus.join(' | '));
        assert.equal(git('show', ':file.gkt'), 'upstream value', 'checkpoint restores the original index blob');
        git('checkout', '--', 'file.gkt');

        const protectedHandle = await beginStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt', 'staged.gkt'], ['file.gkt', 'staged.gkt']);
        fs.writeFileSync(file, 'conflict output\n');
        fs.writeFileSync(stagedFile, 'stash-applied output\n');
        await markStashOperationConflicted(uri, protectedHandle, ['file.gkt', 'staged.gkt'], ['file.gkt']);
        fs.writeFileSync(stagedFile, 'new local edit after conflict\n');
        await assert.rejects(() => runMergeOperation(uri, 'stash-apply', 'abort'), /新的本地修改/);
        assert.equal(fs.readFileSync(stagedFile, 'utf8'), 'new local edit after conflict\n', 'Abort refuses to overwrite later edits on non-conflict paths');
        await clearStashOperation(uri);
        git('checkout', '--', 'file.gkt', 'staged.gkt');

        const tokenHandle = await beginStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt']);
        await assert.rejects(() => markStashOperationConflicted(uri, { ...tokenHandle, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, ['file.gkt'], ['file.gkt']), /token 已改变/);
        await clearStashOperation(uri);

        const staleHandle = await beginStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt']);
        const staleMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        fs.writeFileSync(markerPath, JSON.stringify({ ...staleMarker, processId: -1, head: stashHash }));
        assert.equal(await readMergeOperation(uri), undefined, 'a stale applying marker from a dead Extension Host is reconciled');
        assert.equal(fs.existsSync(markerPath), false);
        assert.equal(fs.existsSync(path.join(root, '.git', 'fastergit-stash-checkpoints', staleHandle.operationId)), false);

        const concurrent = await Promise.allSettled([
            beginStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt']),
            beginStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt']),
        ]);
        assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1, 'cross-window begin lock allows one operation');
        assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
        await clearStashOperation(uri);

        fs.writeFileSync(markerPath, JSON.stringify({ version: 1, action: 'stash-apply', stash: stashHash, head: stashHead, paths: ['file.gkt'] }));
        assert.equal(await readMergeOperation(uri), 'stash-apply', 'version 1 conflict markers remain compatible');
        await clearStashOperation(uri);

        await writeStashOperation(uri, 'stash-apply', stashHash, stashHash, ['file.gkt'], 'conflicted');
        await assert.rejects(() => readMergeOperation(uri), /HEAD 已改变/);
        assert.equal(fs.existsSync(markerPath), true, 'a HEAD mismatch preserves recovery data');
        await clearStashOperation(uri);

        fs.writeFileSync(stagedFile, 'keep staged\n'); git('add', 'staged.gkt');
        fs.writeFileSync(unstagedFile, 'keep unstaged\n');
        fs.writeFileSync(untrackedFile, 'keep untracked\n');
        const realConflictHandle = await beginStashOperation(
            uri, 'stash-apply', stashHash, stashHead, ['file.gkt', 'stash-new.gkt'],
            ['file.gkt', 'stash-new.gkt', 'staged.gkt', 'unstaged.gkt', 'untracked.gkt'],
        );
        try { git('stash', 'apply'); } catch {}
        const stashParents = git('rev-list', '--parents', '-n', '1', stashHash).split(' ').slice(1);
        const duplicateStash = git('commit-tree', `${stashHash}^{tree}`, ...stashParents.flatMap(parent => ['-p', parent]), '-m', 'duplicate stash candidate');
        assert.equal(await identifyStashConflict(uri, [stashHash, duplicateStash]), undefined, 'ambiguous identical Stash candidates are never guessed');
        assert.deepEqual(await identifyStashConflict(uri, [stashHead, stashHash]), { stash: stashHash, conflictPaths: ['file.gkt'] }, 'index stages identify the exact orphaned stash without guessing');
        await markStashOperationConflicted(uri, realConflictHandle, ['file.gkt', 'stash-new.gkt'], ['file.gkt']);
        assert.equal(await readMergeOperation(uri), 'stash-apply');
        await runMergeOperation(uri, 'stash-apply', 'abort');
        const abortStatus = git('status', '--porcelain').split(/\r?\n/);
        assert.ok(abortStatus.includes('M  staged.gkt'), abortStatus.join(' | '));
        assert.ok(abortStatus.includes(' M unstaged.gkt'), abortStatus.join(' | '));
        assert.ok(abortStatus.includes('?? untracked.gkt'), abortStatus.join(' | '));
        assert.equal(fs.readFileSync(file, 'utf8'), 'upstream value\n');
        assert.equal(fs.existsSync(stashNewFile), false);
        assert.equal(git('rev-parse', 'refs/stash'), stashHash);
        assert.equal(await readMergeOperation(uri), undefined);

        git('reset', '--hard', 'HEAD'); git('clean', '-fd');
        fs.writeFileSync(file, 'staged local\n'); git('add', 'file.gkt');
        const stagedStatusBefore = git('status', '--porcelain', '-uall');
        const stagedIndexBefore = git('ls-files', '--stage');
        const stagedStashPaths = ['file.gkt', 'stash-new.gkt', 'unrelated.gkt'];
        const stagedHandle = await beginStashOperation(
            uri, 'stash-apply', stashHash, stashHead, stagedStashPaths, stagedStashPaths,
        );
        try { git('stash', 'apply'); } catch {}
        assert.ok(git('ls-files', '-u').includes('file.gkt'), 'Git merges a staged-only Stash path into a real conflict');
        await markStashOperationConflicted(uri, stagedHandle, stagedStashPaths, ['file.gkt']);
        await runMergeOperation(uri, 'stash-apply', 'abort');
        assert.equal(git('ls-files', '-u'), '', 'Abort clears every unmerged stage');
        assert.equal(git('status', '--porcelain', '-uall'), stagedStatusBefore, 'Abort restores the staged-only pre-state and preserves unrelated files');
        assert.equal(git('ls-files', '--stage'), stagedIndexBefore, 'Abort restores the complete pre-operation index');
        assert.equal(git('show', ':file.gkt'), 'staged local', 'Abort restores the exact staged blob');
        assert.equal(fs.readFileSync(file, 'utf8'), 'staged local\n');
        assert.equal(fs.existsSync(stashNewFile), false);
        assert.equal(git('rev-parse', 'refs/stash'), stashHash);

        git('reset', '--hard', 'HEAD'); git('clean', '-fd');
        try { git('stash', 'apply'); } catch {}
        await writeStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt', 'stash-new.gkt']);
        fs.writeFileSync(file, 'resolved apply\n'); git('add', 'file.gkt');
        await runMergeOperation(uri, 'stash-apply', 'continue');
        assert.equal(await readMergeOperation(uri), undefined);
        assert.equal(git('rev-parse', 'refs/stash'), stashHash, 'completing Apply keeps the stash');

        git('reset', '--hard', 'HEAD'); git('clean', '-fd');
        try { git('stash', 'apply'); } catch {}
        await writeStashOperation(uri, 'stash-pop', stashHash, stashHead, ['file.gkt', 'stash-new.gkt']);
        fs.writeFileSync(file, 'resolved pop\n'); git('add', 'file.gkt');
        await runMergeOperation(uri, 'stash-pop', 'continue');
        assert.equal(await readMergeOperation(uri), undefined);
        assert.throws(() => git('rev-parse', '--verify', 'refs/stash'), 'completing Pop drops the stash');
        await writeStashOperation(uri, 'stash-pop', stashHash, stashHead, ['file.gkt'], 'conflicted');
        const finishingMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        fs.writeFileSync(markerPath, JSON.stringify({ ...finishingMarker, phase: 'finishing' }));
        await runMergeOperation(uri, 'stash-pop', 'continue');
        assert.equal(await readMergeOperation(uri), undefined, 'retrying a finished Pop clears the marker even when the exact stash was already dropped');
        console.log('Merge operations: sequencer continue/abort plus persistent Stash Apply/Pop finish and path-scoped rollback passed');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
