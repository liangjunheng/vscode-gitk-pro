const fs = require('node:fs');
const path = require('node:path');
const { bindings } = require('./native-targets.cjs');

const target = process.argv[2];
const root = path.resolve(__dirname, '..');
const libRoot = path.join(root, 'lib');

function nativeFiles(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(name => name.endsWith('.node')).sort()
    : [];
}

function verifyTarget(platform, load) {
  const directory = path.join(libRoot, platform);
  const actual = nativeFiles(directory);
  const matches = bindings[platform].filter(name => actual.includes(name));
  if (actual.length !== 1 || matches.length !== 1) {
    throw new Error(`${platform} requires exactly one of ${bindings[platform].join(' or ')} in lib/${platform}, found: ${actual.join(', ') || '(none)'}`);
  }
  const modulePath = path.join(directory, matches[0]);
  if (load) {
    const binding = require(modulePath);
    if (!binding.bindingVersion() || !binding.libgit2Version()) {
      throw new Error(`Could not call the ${platform} native binding`);
    }
    console.log(`${platform}: binding ${binding.bindingVersion()}, libgit2 ${binding.libgit2Version()}`);
  } else {
    console.log(`${platform}: ${path.relative(root, modulePath)}`);
  }
  return modulePath;
}

if (target === 'universal') {
  const selected = Object.keys(bindings).map(platform => verifyTarget(platform, false));
  const expected = new Set(selected.map(file => path.resolve(file)));
  const extras = [];
  if (fs.existsSync(libRoot)) {
    for (const entry of fs.readdirSync(libRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of nativeFiles(path.join(libRoot, entry.name))) {
        const file = path.resolve(libRoot, entry.name, name);
        if (!expected.has(file)) extras.push(path.relative(root, file));
      }
    }
  }
  if (extras.length > 0) throw new Error(`Unexpected native modules: ${extras.join(', ')}`);
  console.log(`universal: ${selected.length} platform modules under lib/`);
  process.exit(0);
}

if (!Object.hasOwn(bindings, target)) {
  throw new Error(`Unknown VS Code target: ${target}; expected universal or one of ${Object.keys(bindings).join(', ')}`);
}
verifyTarget(target, process.argv.includes('--load'));
