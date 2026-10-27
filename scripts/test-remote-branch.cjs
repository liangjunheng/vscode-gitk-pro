const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
let checkoutRemoteBranch;
try {
  Module._load = function(name, ...args) { return name === 'vscode' ? {} : originalLoad.call(this, name, ...args); };
  ({ checkoutRemoteBranch } = require('../out/git/gitNativeOperations'));
} finally { Module._load = originalLoad; }

const scratch = path.resolve(os.tmpdir());
// Local endpoint policy blocks .git/config writes under temp directories named gitk-r*/gitk-t*.
const root = fs.mkdtempSync(path.join(scratch, 'gitk-branch-checkout-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
}).trim();

async function main() {
  try {
    git('init', '--template=', '-b', 'main');
    git('config', 'user.name', 'Gitk Test'); git('config', 'user.email', 'gitk@example.com');
    git('config', 'core.autocrlf', 'false');
    const file = path.join(root, 'fixture.gkt');
    fs.writeFileSync(file, 'base\n'); git('add', '.'); git('commit', '-m', 'base');
    git('checkout', '-b', 'fixture-source');
    fs.writeFileSync(file, 'remote\n'); git('commit', '-am', 'remote');
    const remoteHead = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    const mainHead = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', path.join(root, 'unused-remote'));
    git('update-ref', 'refs/remotes/origin/team/topic', remoteHead);
    fs.writeFileSync(file, 'local edits\n');
    await assert.rejects(checkoutRemoteBranch({ fsPath: root }, 'refs/remotes/origin/team/topic', 'team/topic'));
    assert.equal(git('branch', '--list', 'team/topic'), '', 'refused checkout does not leave the new branch behind');
    assert.equal(git('rev-parse', 'HEAD'), mainHead, 'failed checkout must retain HEAD');
    assert.equal(fs.readFileSync(file, 'utf8'), 'local edits\n', 'failed checkout must retain local edits');
    fs.writeFileSync(file, 'base\n');
    await checkoutRemoteBranch({ fsPath: root }, 'refs/remotes/origin/team/topic', 'team/topic');
    assert.equal(git('branch', '--show-current'), 'team/topic');
    assert.equal(git('rev-parse', 'HEAD'), remoteHead);
    assert.equal(git('rev-parse', '--symbolic-full-name', '@{upstream}'), 'refs/remotes/origin/team/topic');
    assert.equal(fs.readFileSync(file, 'utf8'), 'remote\n');
    await assert.rejects(checkoutRemoteBranch({ fsPath: root }, 'refs/remotes/origin/team/topic', 'team/topic'), /already exists/);
    await assert.rejects(checkoutRemoteBranch({ fsPath: root }, 'refs/remotes/origin/team/topic', 'invalid name'), /not a valid branch name/);
    await assert.rejects(checkoutRemoteBranch({ fsPath: root }, 'refs/remotes/origin/HEAD', 'alias'), /名称无效/);
    assert.equal(git('branch', '--show-current'), 'team/topic');
    console.log('Remote branch tests passed: safe checkout preserves local edits, nested local branch creation, exact upstream, existing branch and invalid ref rejection.');
  } finally {
    const relative = path.relative(scratch, path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
