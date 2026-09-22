const { spawnSync } = require('node:child_process');
const path = require('node:path');

const packageArgs = process.argv.slice(2);
if (packageArgs.some(arg => arg === '--target' || arg.startsWith('--target='))) {
  throw new Error('The universal VSIX must be packaged without --target');
}

const verify = path.join(__dirname, 'verify-native-platform.cjs');
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
for (const args of [[verify, 'universal'], [vsce, 'package', ...packageArgs]]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { process.exit(result.status || 1); }
}
