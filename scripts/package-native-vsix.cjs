const { spawnSync } = require('node:child_process');
const path = require('node:path');

let target;
const arch = process.arch;
if (process.platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
  target = `win32-${arch}`;
} else if (process.platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
  target = `darwin-${arch}`;
} else if (process.platform === 'linux') {
  if (arch === 'arm') {
    target = 'linux-armhf';
  } else if (arch === 'x64' || arch === 'arm64') {
    const isGlibc = Boolean(process.report?.getReport().header.glibcVersionRuntime);
    target = `${isGlibc ? 'linux' : 'alpine'}-${arch}`;
  }
}
if (!target) {
  throw new Error(`No supported VS Code native target for ${process.platform}/${arch}`);
}
const verify = path.join(__dirname, 'verify-native-platform.cjs');
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
for (const args of [[verify, target, '--load'], [vsce, 'package', '--target', target, ...process.argv.slice(2)]]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { process.exit(result.status || 1); }
}
