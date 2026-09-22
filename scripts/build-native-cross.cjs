const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetDefinition } = require('./native-targets.cjs');
const {
  libgit2PatchConfig,
  prepareDarwinBuildWorkspace,
  prepareDarwinLibgit2Patch,
} = require('./prepare-libgit2-darwin-patch.cjs');

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
let buildManifest = manifest;
const targetDirectory = process.env.VSCODE_GITK_CARGO_TARGET_DIR || path.join(root, 'native', 'git2-backend', 'target');
fs.mkdirSync(targetDirectory, { recursive: true });
const childEnv = {
  ...process.env,
  MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || '10.13',
};
function startsWithEncryptedHeader(file) {
  if (!fs.existsSync(file)) return false;
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8').includes('%TSD-Header-');
  } finally {
    fs.closeSync(descriptor);
  }
}

function reusableOpenSslDirectory() {
  const buildRoot = path.join(targetDirectory, rustTarget, 'release', 'build');
  if (!fs.existsSync(buildRoot)) return undefined;
  for (const name of fs.readdirSync(buildRoot)) {
    if (!name.startsWith('openssl-sys-')) continue;
    const install = path.join(buildRoot, name, 'out', 'openssl-build', 'install');
    const include = path.join(install, 'include', 'openssl');
    const library = path.join(install, 'lib');
    const required = [
      path.join(include, 'ssl.h'),
      path.join(include, 'opensslv.h'),
      path.join(include, 'opensslconf.h'),
      path.join(library, 'libssl.a'),
      path.join(library, 'libcrypto.a'),
    ];
    if (required.every(file => fs.existsSync(file) && !startsWithEncryptedHeader(file))) return install;
  }
  return undefined;
}

const reusableOpenSsl = reusableOpenSslDirectory();
if (reusableOpenSsl) {
  childEnv.OPENSSL_DIR = reusableOpenSsl;
  childEnv.OPENSSL_INCLUDE_DIR = path.join(reusableOpenSsl, 'include');
  childEnv.OPENSSL_LIB_DIR = path.join(reusableOpenSsl, 'lib');
  childEnv.OPENSSL_STATIC = '1';
  childEnv.OPENSSL_NO_VENDOR = '1';
  console.log(`${vscodeTarget}: reusing OpenSSL from ${reusableOpenSsl}`);
}

let darwinPatchConfig;
if (rustTarget.endsWith('-apple-darwin')) {
  childEnv.CFLAGS = [process.env.CFLAGS, '-DOPENSSL_NO_APPLE_CRYPTO_RANDOM'].filter(Boolean).join(' ');
  const patchDirectory = process.env.VSCODE_GITK_LIBGIT2_PATCH
    || prepareDarwinLibgit2Patch(manifest, childEnv);
  darwinPatchConfig = libgit2PatchConfig(patchDirectory);
  buildManifest = prepareDarwinBuildWorkspace(root, vscodeTarget);
}
const envTarget = rustTarget.replaceAll('-', '_');
if (rustTarget.endsWith('-musl')) {
  childEnv.RUSTFLAGS = [process.env.RUSTFLAGS, '-C target-feature=-crt-static'].filter(Boolean).join(' ');
}
if (process.env.VSCODE_GITK_ZIG_AR) childEnv[`AR_${envTarget}`] = process.env.VSCODE_GITK_ZIG_AR;
if (process.env.VSCODE_GITK_ZIG_RANLIB) childEnv[`RANLIB_${envTarget}`] = process.env.VSCODE_GITK_ZIG_RANLIB;
const result = spawnSync('cargo', [
  'zigbuild',
  '--release',
  '--manifest-path',
  buildManifest,
  '--target',
  rustTarget,
  '--target-dir',
  targetDirectory,
  ...(darwinPatchConfig ? ['--config', darwinPatchConfig] : []),
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
