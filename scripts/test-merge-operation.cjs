const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const original = Module._load;
let readMergeOperation, runMergeOperation;
try {
    Module._load = function(name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
    ({ readMergeOperation, runMergeOperation } = require('../out/git/mergeOperation'));
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
        console.log('Merge operations: conflict gate, state guard, continue parents, abort restores HEAD and preserves unrelated file');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
