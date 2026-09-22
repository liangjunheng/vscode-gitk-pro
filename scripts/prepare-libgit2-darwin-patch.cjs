const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolsRoot } = require('./prepare-native-tools.cjs');

const LIBGIT2_SYS_VERSION = '0.18.8+1.9.7';
const PATCH_REVISION = 1;
const STAMP_FILE = '.vscode-gitk-darwin-openssl-patch.json';

const replacements = Object.freeze([
  Object.freeze([
`        if windows {
            features.push_str("#define GIT_WINHTTP 1\\n");
        } else if target.contains("apple") {
            features.push_str("#define GIT_SECURE_TRANSPORT 1\\n");
        } else {
            features.push_str("#define GIT_OPENSSL 1\\n");
            if let Some(path) = env::var_os("DEP_OPENSSL_INCLUDE") {
                cfg.include(path);
            }
        }`,
`        if windows {
            features.push_str("#define GIT_WINHTTP 1\\n");
        } else {
            features.push_str("#define GIT_OPENSSL 1\\n");
            if let Some(path) = env::var_os("DEP_OPENSSL_INCLUDE") {
                cfg.include(path);
            }
        }`,
  ]),
  Object.freeze([
`        if windows {
            features.push_str("#define GIT_SHA256_WIN32 1\\n");
            cfg.file("libgit2/src/util/hash/win32.c");
        } else if target.contains("apple") {
            features.push_str("#define GIT_SHA256_COMMON_CRYPTO 1\\n");
            cfg.file("libgit2/src/util/hash/common_crypto.c");
        } else {
            features.push_str("#define GIT_SHA256_OPENSSL 1\\n");
            cfg.file("libgit2/src/util/hash/openssl.c");
        }`,
`        if windows {
            features.push_str("#define GIT_SHA256_WIN32 1\\n");
            cfg.file("libgit2/src/util/hash/win32.c");
        } else {
            features.push_str("#define GIT_SHA256_OPENSSL 1\\n");
            cfg.file("libgit2/src/util/hash/openssl.c");
        }`,
  ]),
  Object.freeze([
`    if target.contains("apple") {
        println!("cargo:rustc-link-lib=iconv");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }`,
`    if target.contains("apple") {
        println!("cargo:rustc-link-lib=iconv");
    }`,
  ]),
]);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertInsideTools(candidate) {
  const root = path.resolve(toolsRoot());
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to modify a path outside the native tools directory: ${resolved}`);
  }
  return resolved;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function validPatch(directory) {
  const stampPath = path.join(directory, STAMP_FILE);
  const buildScript = path.join(directory, 'build.rs');
  if (!fs.existsSync(stampPath) || !fs.existsSync(buildScript)) return false;
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    const contents = fs.readFileSync(buildScript, 'utf8');
    return stamp.version === LIBGIT2_SYS_VERSION
      && stamp.patchRevision === PATCH_REVISION
      && stamp.buildScriptSha256 === sha256(buildScript)
      && contents.includes('#define GIT_OPENSSL 1')
      && contents.includes('#define GIT_SHA256_OPENSSL 1')
      && !contents.includes('#define GIT_SECURE_TRANSPORT 1')
      && !contents.includes('cargo:rustc-link-lib=framework=Security')
      && !contents.includes('cargo:rustc-link-lib=framework=CoreFoundation');
  } catch {
    return false;
  }
}

function cargoMetadata(manifest, env) {
  const result = spawnSync('cargo', [
    'metadata',
    '--format-version', '1',
    '--locked',
    '--manifest-path', manifest,
  ], { cwd: path.dirname(manifest), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`);
  }
  return JSON.parse(result.stdout);
}

function locateRegistryCrate(manifest, env) {
  const metadata = cargoMetadata(manifest, env);
  const package = metadata.packages.find(candidate => (
    candidate.name === 'libgit2-sys' && candidate.version === LIBGIT2_SYS_VERSION
  ));
  if (!package) {
    throw new Error(`Cargo metadata does not contain libgit2-sys ${LIBGIT2_SYS_VERSION}`);
  }
  if (!String(package.source || '').startsWith('registry+')) {
    throw new Error(`Expected a registry libgit2-sys package, received ${package.source || 'no source'}`);
  }
  return path.dirname(package.manifest_path);
}

function patchBuildScript(file) {
  let contents = fs.readFileSync(file, 'utf8');
  for (const [original, replacement] of replacements) {
    if (!contents.includes(original)) {
      throw new Error(`libgit2-sys ${LIBGIT2_SYS_VERSION} build.rs no longer matches the expected patch context`);
    }
    contents = contents.replace(original, replacement);
  }
  fs.writeFileSync(file, contents);
}

function prepareDarwinLibgit2Patch(manifest, env = process.env) {
  const patchRoot = assertInsideTools(path.join(toolsRoot(), 'patched-crates'));
  const destination = assertInsideTools(path.join(patchRoot, `libgit2-sys-${LIBGIT2_SYS_VERSION}`));
  if (validPatch(destination)) return destination;

  fs.mkdirSync(patchRoot, { recursive: true });
  const lockDirectory = assertInsideTools(`${destination}.lock`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let ownsLock = false;
  while (!ownsLock) {
    try {
      fs.mkdirSync(lockDirectory);
      ownsLock = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (validPatch(destination)) return destination;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockDirectory}`);
      sleep(250);
    }
  }

  const staging = assertInsideTools(`${destination}.tmp-${process.pid}-${Date.now()}`);
  try {
    if (validPatch(destination)) return destination;
    const source = locateRegistryCrate(path.resolve(manifest), env);
    fs.cpSync(source, staging, { recursive: true });
    const buildScript = path.join(staging, 'build.rs');
    patchBuildScript(buildScript);
    fs.writeFileSync(path.join(staging, STAMP_FILE), `${JSON.stringify({
      version: LIBGIT2_SYS_VERSION,
      patchRevision: PATCH_REVISION,
      buildScriptSha256: sha256(buildScript),
    }, null, 2)}\n`);
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    console.log(`native: prepared Darwin OpenSSL libgit2 patch at ${destination}`);
    return destination;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (ownsLock && fs.existsSync(lockDirectory)) fs.rmdirSync(lockDirectory);
  }
}


function prepareDarwinBuildWorkspace(repositoryRoot, vscodeTarget) {
  if (!/^darwin-(x64|arm64)$/.test(vscodeTarget)) {
    throw new Error(`Unexpected Darwin build workspace target: ${vscodeTarget}`);
  }
  const workspace = assertInsideTools(path.join(toolsRoot(), 'build-workspaces', vscodeTarget));
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
  const backend = path.join(workspace, 'git2-backend');
  const napiBuildPatch = path.join(workspace, 'napi-build-patch');
  fs.mkdirSync(backend, { recursive: true });

  const sourceBackend = path.join(repositoryRoot, 'native', 'git2-backend');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src', 'examples']) {
    const source = path.join(sourceBackend, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backend, name), { recursive: true });
  }
  fs.cpSync(path.join(repositoryRoot, 'native', 'napi-build-patch'), napiBuildPatch, { recursive: true });
  return path.join(backend, 'Cargo.toml');
}

function libgit2PatchConfig(directory) {
  const normalized = path.resolve(directory).replaceAll('\\', '/');
  return `patch.crates-io.libgit2-sys.path=${JSON.stringify(normalized)}`;
}

module.exports = {
  LIBGIT2_SYS_VERSION,
  libgit2PatchConfig,
  prepareDarwinBuildWorkspace,
  prepareDarwinLibgit2Patch,
};
