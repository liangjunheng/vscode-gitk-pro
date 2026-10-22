// Use the same pinned libgit2 patch in tests/clippy as in all shipped modules.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareBuildWorkspace, prepareLibgit2Patch, libgit2PatchConfig } = require('./prepare-libgit2-darwin-patch.cjs');
const root = path.resolve(__dirname, '..');
const [command, ...args] = process.argv.slice(2);
if (!['test', 'clippy', 'check'].includes(command)) throw new Error('Expected test, clippy or check');
const sourceManifest = path.join(root, 'native', 'git2-backend', 'Cargo.toml');
const patch = prepareLibgit2Patch(sourceManifest);
const manifest = prepareBuildWorkspace(root, command);
const result = spawnSync('cargo', [
  '--config', libgit2PatchConfig(patch), command,
  '--manifest-path', manifest,
  '--target-dir', process.env.CARGO_TARGET_DIR || path.join(root, 'native', 'git2-backend', 'target'),
  ...args,
], { cwd: root, env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status || 0;
