const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'src', 'webview', 'gitkViewProvider.ts'), 'utf8');
const controller = fs.readFileSync(path.join(repo, 'src', 'git', 'gitCommitController.ts'), 'utf8');
const backend = fs.readFileSync(path.join(repo, 'src', 'git', 'libGit2Backend.ts'), 'utf8');
const document = fs.readFileSync(path.join(repo, 'src', 'webview', 'multiDiffPanelDocument.ts'), 'utf8');

assert.ok(source.includes('Open exactly the direct child Gitlink target'), 'Gitlink navigation must remain direct-child only');
assert.ok(source.includes("const targetHash = isDirtyWorktreeGitlink ? 'uncommitted' : hash"), 'dirty direct Gitlinks must open child Uncommitted Changes');
assert.ok(!source.includes('projectNestedGitlinkChanges'), 'must not synthesize recursive Gitlink cards');
assert.ok(!source.includes('selectGitlinkTarget'), 'must not auto-descend through nested Gitlinks');
assert.ok(controller.includes("Preserve selectCommit's explicit branch fallback"), 'unselected direct child worktree must not resolve to an empty MultiDiff');
assert.ok(backend.includes('file.oldObjectId === file.newObjectId'), 'equal Gitlink OIDs must identify dirty child worktrees');
assert.ok(source.includes('gitlinkWorktreeChangeCount = new Set'), 'dirty Gitlink metadata must count direct child changed paths without duplicates');
assert.ok(document.includes('if(diff.gitlinkWorktreeDirty){const count='), 'dirty Gitlink cards must have a dedicated worktree state');
assert.ok(document.includes("'子模块有 '+count+' 个未提交变更文件'"), 'dirty Gitlink cards must show the direct child worktree file count');
assert.ok(!document.includes("targetHash=diff.gitlinkWorktreeDirty"), 'dirty Gitlink cards must not render a commit target');
assert.ok(source.includes('retain the previously published Uncommitted Changes row'), 'commit-list Uncommitted Changes row must remain visible while child status loads');
assert.ok(source.includes('pendingGitlinkWorktreeSnapshot'), 'Gitlink navigation must retain a prepared child worktree snapshot');
assert.ok(source.includes('getUncommittedFilesByHeadBranch(branch)'), 'Gitlink navigation must read the direct child worktree before changing selection');
assert.ok(source.includes('preparedWorktree?.changes'), 'selected child worktree must consume the prepared snapshot atomically');

const renderRoot = 'D:\\project\\inkengine\\ink-engine-core\\core\\ink-render';
if (fs.existsSync(renderRoot)) {
  const raw = execFileSync('git', ['-C', renderRoot, 'diff', '--raw', '--', 'ink-gfx'], { encoding: 'utf8' });
  // This is optional live evidence, not a permanent fixture: the shared checkout may be clean.
  if (raw) console.log('Live ink-render Gitlink diff:', raw.trim());
}

console.log('Direct dirty Gitlink tests passed: equal OID opens only the direct child Uncommitted Changes.');
