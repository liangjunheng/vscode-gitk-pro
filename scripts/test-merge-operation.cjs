const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const original = Module._load;
let readMergeOperation, runMergeOperation, writeStashOperation;
try {
    Module._load = function(name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
    ({ readMergeOperation, runMergeOperation, writeStashOperation } = require('../out/git/mergeOperation'));
} finally { Module._load = original; }
async function main() {
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

        fs.writeFileSync(stagedFile, 'keep staged\n'); git('add', 'staged.gkt');
        fs.writeFileSync(unstagedFile, 'keep unstaged\n');
        fs.writeFileSync(untrackedFile, 'keep untracked\n');
        try { git('stash', 'apply'); } catch {}
        await writeStashOperation(uri, 'stash-apply', stashHash, stashHead, ['file.gkt', 'stash-new.gkt']);
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
        console.log('Merge operations: sequencer continue/abort plus persistent Stash Apply/Pop finish and path-scoped rollback passed');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
