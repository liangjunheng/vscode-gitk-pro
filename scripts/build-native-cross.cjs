const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetDefinition } = require('./native-targets.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find(value => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

const vscodeTarget = argument('--vscode-target');
const rustTarget = argument('--target');
if (!vscodeTarget || !rustTarget) throw new Error('Both --vscode-target and --target are required');
const definition = targetDefinition(vscodeTarget);
if (!definition || definition.rustTarget !== rustTarget) {
  throw new Error(`Unexpected native target pair: ${vscodeTarget} / ${rustTarget}`);
}

const manifest = path.join(root, 'native', 'git2-backend', 'Cargo.toml');
const targetDirectory = process.env.VSCODE_GITK_CARGO_TARGET_DIR || path.join(root, 'native', 'git2-backend', 'target');
fs.mkdirSync(targetDirectory, { recursive: true });
const childEnv = {
  ...process.env,
  MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || '10.13',
};
const envTarget = rustTarget.replaceAll('-', '_');
if (process.env.VSCODE_GITK_ZIG_AR) childEnv[`AR_${envTarget}`] = process.env.VSCODE_GITK_ZIG_AR;
if (process.env.VSCODE_GITK_ZIG_RANLIB) childEnv[`RANLIB_${envTarget}`] = process.env.VSCODE_GITK_ZIG_RANLIB;
const result = spawnSync('cargo', [
  'zigbuild',
  '--release',
  '--manifest-path',
  manifest,
  '--target',
  rustTarget,
  '--target-dir',
  targetDirectory,
], {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

let artifactName;
if (rustTarget.includes('windows')) artifactName = 'vscode_gitk_libgit2.dll';
else if (rustTarget.includes('apple-darwin')) artifactName = 'libvscode_gitk_libgit2.dylib';
else artifactName = 'libvscode_gitk_libgit2.so';

const artifact = path.join(targetDirectory, rustTarget, 'release', artifactName);
if (!fs.existsSync(artifact)) throw new Error(`Cargo did not produce ${path.relative(root, artifact)}`);

const output = path.join(root, 'lib', vscodeTarget);
fs.mkdirSync(output, { recursive: true });
for (const name of fs.readdirSync(output)) {
  if (name.endsWith('.node')) fs.rmSync(path.join(output, name), { force: true });
}
const destination = path.join(output, definition.bindings[0]);
fs.copyFileSync(artifact, destination);
console.log(`${vscodeTarget}: ${path.relative(root, destination)}`);
