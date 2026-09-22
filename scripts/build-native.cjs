const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bindings, detectNativeTarget } = require('./native-targets.cjs');

const forwardedArgs = process.argv.slice(2);
let target;
for (let index = 0; index < forwardedArgs.length; index++) {
  const argument = forwardedArgs[index];
  if (argument === '--vscode-target') {
    target = forwardedArgs[index + 1];
    if (!target) throw new Error('--vscode-target requires a value');
    forwardedArgs.splice(index, 2);
    break;
  }
  if (argument.startsWith('--vscode-target=')) {
    target = argument.slice('--vscode-target='.length);
    forwardedArgs.splice(index, 1);
    break;
  }
}
target ||= detectNativeTarget();
if (!Object.hasOwn(bindings, target)) {
  throw new Error(`Unknown VS Code target: ${target}; expected one of ${Object.keys(bindings).join(', ')}`);
}

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'lib', target);
fs.mkdirSync(output, { recursive: true });


const cliPackagePath = require.resolve('@napi-rs/cli/package.json');
const cliPackage = require(cliPackagePath);
const napi = path.resolve(path.dirname(cliPackagePath), cliPackage.bin.napi);
const args = [
  napi,
  'build',
  '--platform',
  '--no-js',
  '--release',
  '--manifest-path',
  path.join(root, 'native', 'git2-backend', 'Cargo.toml'),
  '-o',
  output,
  ...forwardedArgs,
];
const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || '10.13',
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const declaration = path.join(output, 'index.d.ts');
if (fs.existsSync(declaration)) fs.unlinkSync(declaration);

const actual = fs.readdirSync(output).filter(name => name.endsWith('.node')).sort();
const matches = bindings[target].filter(name => actual.includes(name));
if (actual.length !== 1 || matches.length !== 1) {
  throw new Error(`${target} build must produce exactly one of ${bindings[target].join(' or ')}, found: ${actual.join(', ') || '(none)'}`);
}
console.log(`${target}: ${path.relative(root, path.join(output, matches[0]))}`);
