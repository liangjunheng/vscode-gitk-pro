const targets = Object.freeze([
  Object.freeze({ vscodeTarget: 'win32-x64', rustTarget: 'x86_64-pc-windows-msvc', bindings: Object.freeze(['index.win32-x64-msvc.node', 'index.win32-x64-gnu.node']) }),
  Object.freeze({ vscodeTarget: 'win32-arm64', rustTarget: 'aarch64-pc-windows-gnullvm', bindings: Object.freeze(['index.win32-arm64-msvc.node', 'index.win32-arm64-gnu.node']) }),
  Object.freeze({ vscodeTarget: 'linux-x64', rustTarget: 'x86_64-unknown-linux-gnu', bindings: Object.freeze(['index.linux-x64-gnu.node']) }),
  Object.freeze({ vscodeTarget: 'linux-arm64', rustTarget: 'aarch64-unknown-linux-gnu', bindings: Object.freeze(['index.linux-arm64-gnu.node']) }),
  Object.freeze({ vscodeTarget: 'linux-armhf', rustTarget: 'armv7-unknown-linux-gnueabihf', bindings: Object.freeze(['index.linux-arm-gnueabihf.node']) }),
  Object.freeze({ vscodeTarget: 'alpine-x64', rustTarget: 'x86_64-unknown-linux-musl', bindings: Object.freeze(['index.linux-x64-musl.node']) }),
  Object.freeze({ vscodeTarget: 'alpine-arm64', rustTarget: 'aarch64-unknown-linux-musl', bindings: Object.freeze(['index.linux-arm64-musl.node']) }),
  Object.freeze({ vscodeTarget: 'darwin-x64', rustTarget: 'x86_64-apple-darwin', bindings: Object.freeze(['index.darwin-x64.node']) }),
  Object.freeze({ vscodeTarget: 'darwin-arm64', rustTarget: 'aarch64-apple-darwin', bindings: Object.freeze(['index.darwin-arm64.node']) }),
]);

const bindings = Object.freeze(Object.fromEntries(targets.map(target => [target.vscodeTarget, target.bindings])));

function detectNativeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `win32-${arch}`;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return `darwin-${arch}`;
  if (platform === 'linux') {
    if (arch === 'arm') return 'linux-armhf';
    if (arch === 'x64' || arch === 'arm64') {
      const isGlibc = Boolean(process.report?.getReport().header.glibcVersionRuntime);
      return `${isGlibc ? 'linux' : 'alpine'}-${arch}`;
    }
  }
  throw new Error(`No supported VS Code native target for ${platform}/${arch}`);
}

function targetDefinition(vscodeTarget) {
  return targets.find(target => target.vscodeTarget === vscodeTarget);
}

module.exports = { bindings, targets, detectNativeTarget, targetDefinition };
