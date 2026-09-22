const fs = require('node:fs');
const path = require('node:path');

// Keep this list in sync with the target matrix in .github/workflows/native-libgit2.yml.
// Local Windows development may use GNU, while GitHub's Windows runners use MSVC.
const bindings = Object.freeze({
  'win32-x64': ['index.win32-x64-msvc.node', 'index.win32-x64-gnu.node'],
  'win32-arm64': ['index.win32-arm64-msvc.node', 'index.win32-arm64-gnu.node'],
  'linux-x64': ['index.linux-x64-gnu.node'],
  'linux-arm64': ['index.linux-arm64-gnu.node'],
  'linux-armhf': ['index.linux-arm-gnueabihf.node'],
  'darwin-x64': ['index.darwin-x64.node'],
  'darwin-arm64': ['index.darwin-arm64.node'],
  'alpine-x64': ['index.linux-x64-musl.node'],
  'alpine-arm64': ['index.linux-arm64-musl.node'],
});

const target = process.argv[2];
if (!Object.hasOwn(bindings, target)) {
  throw new Error(`Unknown VS Code target: ${target}; expected one of ${Object.keys(bindings).join(', ')}`);
}
const directory = path.resolve(__dirname, '..', 'native');
const actual = fs.readdirSync(directory).filter(name => name.endsWith('.node'));
if (actual.length !== 1 || !bindings[target].includes(actual[0])) {
  throw new Error(`${target} requires only ${bindings[target].join(' or ')}, found: ${actual.join(', ') || '(none)'}`);
}
if (process.argv.includes('--load')) {
  const binding = require(path.join(directory, actual[0]));
  if (!binding.bindingVersion() || !binding.libgit2Version()) {
    throw new Error(`Could not call the ${target} native binding`);
  }
  console.log(`${target}: binding ${binding.bindingVersion()}, libgit2 ${binding.libgit2Version()}`);
} else {
  console.log(`${target}: ${actual[0]}`);
}
