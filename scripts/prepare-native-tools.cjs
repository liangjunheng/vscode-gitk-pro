const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ZIG_VERSION = '0.14.1';
const CARGO_ZIGBUILD_VERSION = '0.23.4';
const DOWNLOADS = Object.freeze({
  zig: Object.freeze({
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-windows-${ZIG_VERSION}.zip`,
    sha256: '554f5378228923ffd558eac35e21af020c73789d87afeabf4bfd16f2e6feed2c',
    file: `zig-x86_64-windows-${ZIG_VERSION}.zip`,
  }),
  make: Object.freeze({
    url: 'https://raw.githubusercontent.com/mbuilov/gnumake-windows/master/gnumake-4.4.1-x64.exe',
    sha256: '368df1dcb3d768cda767809c21e4084c3398c9c9817f5819a8851e95782b44a5',
    file: 'make.exe',
  }),
  localeMaketextSimple: Object.freeze({
    url: 'https://cpan.metacpan.org/authors/id/J/JE/JESSE/Locale-Maketext-Simple-0.21.tar.gz',
    sha256: 'b009ff51f4fb108d19961a523e99b4373ccf958d37ca35bf1583215908dca9a9',
    file: 'Locale-Maketext-Simple-0.21.tar.gz',
    directory: 'Locale-Maketext-Simple-0.21',
  }),
  extUtilsMakeMaker: Object.freeze({
    url: 'https://cpan.metacpan.org/authors/id/B/BI/BINGOS/ExtUtils-MakeMaker-7.76.tar.gz',
    sha256: '30bcfd75fec4d512e9081c792f7cb590009d9de2fe285ffa8eec1be35a5ae7ca',
    file: 'ExtUtils-MakeMaker-7.76.tar.gz',
    directory: 'ExtUtils-MakeMaker-7.76',
  }),
});

function toolsRoot() {
  if (process.env.VSCODE_GITK_NATIVE_TOOLS) return path.resolve(process.env.VSCODE_GITK_NATIVE_TOOLS);
  return path.resolve(__dirname, '..', 'vscode-gitk-native-tools');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validDownload(file, expected) {
  return fs.existsSync(file) && sha256(file).toLowerCase() === expected.toLowerCase();
}

function download(url, destination, redirects = 0) {
  if (redirects > 10) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'vscode-gitk-native-builder' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        download(redirected, destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }
      const temporary = `${destination}.download`;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const stream = fs.createWriteStream(temporary);
      response.pipe(stream);
      stream.on('finish', () => {
        stream.close(() => {
          fs.renameSync(temporary, destination);
          resolve();
        });
      });
      stream.on('error', error => {
        stream.close(() => {
          fs.rmSync(temporary, { force: true });
          reject(error);
        });
      });
    });
    request.setTimeout(120000, () => request.destroy(new Error(`Download timed out for ${url}`)));
    request.on('error', reject);
  });
}

async function ensureDownload(definition, destination) {
  if (validDownload(destination, definition.sha256)) return;
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  console.log(`Downloading ${definition.url}`);
  await download(definition.url, destination);
  if (!validDownload(destination, definition.sha256)) {
    fs.rmSync(destination, { force: true });
    throw new Error(`SHA-256 verification failed for ${definition.file}`);
  }
}

function findGitUnixTools() {
  const execPath = run('git', ['--exec-path']);
  let current = path.resolve(execPath);
  while (path.dirname(current) !== current) {
    const perl = path.join(current, 'usr', 'bin', 'perl.exe');
    const sh = path.join(current, 'usr', 'bin', 'sh.exe');
    const bash = path.join(current, 'usr', 'bin', 'bash.exe');
    if (fs.existsSync(perl) && fs.existsSync(sh) && fs.existsSync(bash)) {
      return { bin: path.dirname(perl), perl, sh, bash };
    }
    current = path.dirname(current);
  }
  throw new Error('Git for Windows with usr\\bin\\perl.exe and usr\\bin\\sh.exe is required to build vendored OpenSSL.');
}

function toMsysPath(value) {
  const resolved = path.resolve(value).replaceAll('\\', '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(resolved);
  return match ? `/${match[1].toLowerCase()}/${match[2]}` : resolved;
}

async function ensureWindowsTools() {
  const root = toolsRoot();
  const downloads = path.join(root, 'downloads');
  const bin = path.join(root, 'bin');
  const modules = path.join(root, 'perl-modules');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(modules, { recursive: true });

  const zigArchive = path.join(downloads, DOWNLOADS.zig.file);
  const zigDirectory = path.join(root, `zig-${ZIG_VERSION}`, `zig-x86_64-windows-${ZIG_VERSION}`);
  const zig = path.join(zigDirectory, 'zig.exe');
  if (!fs.existsSync(zig)) {
    await ensureDownload(DOWNLOADS.zig, zigArchive);
    const destination = path.dirname(zigDirectory);
    fs.mkdirSync(destination, { recursive: true });
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zigArchive, destination]);
  }
  if (run(zig, ['version']) !== ZIG_VERSION) throw new Error(`Expected Zig ${ZIG_VERSION} at ${zig}`);

  const copyScript = path.join(bin, 'native-copy.cjs');
  fs.writeFileSync(copyScript, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "function nativePath(value) {",
    "  const match = /^\\/([A-Za-z])\\/(.*)$/.exec(value);",
    "  return match ? match[1] + ':\\\\' + match[2].replaceAll('/', '\\\\') : value;",
    "}",
    "const values = process.argv.slice(2).filter(value => !value.startsWith('-')).map(nativePath);",
    "if (values.length < 2) { console.error('usage: cp SOURCE... DESTINATION'); process.exit(2); }",
    "const destination = values.pop();",
    "const multiple = values.length > 1;",
    "for (const source of values) {",
    "  const destinationExists = fs.existsSync(destination);",
    "  const target = multiple || (destinationExists && fs.statSync(destination).isDirectory())",
    "    ? path.join(destination, path.basename(source))",
    "    : destination;",
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, fs.readFileSync(source));",
    "}",
    "",
  ].join('\n'));

  const copySource = path.join(bin, 'copy-file.rs');
  const copyExecutable = path.join(bin, 'cp.exe');
  fs.writeFileSync(copySource, String.raw`use std::{env, process::{Command, Stdio}};

fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

fn main() {
    let node = env::var("VSCODE_GITK_NODE").expect("VSCODE_GITK_NODE is required");
    let script = env::var("VSCODE_GITK_NATIVE_COPY").expect("VSCODE_GITK_NATIVE_COPY is required");
    let status = Command::new(node)
        .arg(script)
        .args(env::args().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("failed to launch native copy helper");
    std::process::exit(exit_code(status));
}
`);
  run('rustc', [copySource, '-O', '-o', copyExecutable]);


  const writerScript = path.join(bin, 'native-write.cjs');
  fs.writeFileSync(writerScript, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "let target = process.argv[2];",
    "const match = /^\\/([A-Za-z])\\/(.*)$/.exec(target);",
    "if (match) target = match[1] + ':\\\\' + match[2].replaceAll('/', '\\\\');",
    "const chunks = [];",
    "process.stdin.on('data', chunk => chunks.push(chunk));",
    "process.stdin.on('end', () => {",
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, Buffer.concat(chunks));",
    "});",
    "process.stdin.resume();",
    "",
  ].join('\n'));

  const shellSource = path.join(bin, 'native-shell.rs');
  const shellWrapper = path.join(bin, 'native-shell.exe');
  fs.writeFileSync(shellSource, String.raw`use std::{env, io::{self, Write}, process::{Command, Stdio}};

fn redirected(command: &str) -> Option<(&str, &str)> {
    let index = command.rfind(" > ")?;
    let destination = command[index + 3..].trim();
    if destination.is_empty() || destination.contains(['|', ';', '&', '>', '<']) {
        return None;
    }
    Some((command[..index].trim_end(), destination.trim_matches(|character| character == '"' || character == '\'')))
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

fn main() {
    let bash = env::var("VSCODE_GITK_REAL_BASH").expect("VSCODE_GITK_REAL_BASH is required");
    let node = env::var("VSCODE_GITK_NODE").expect("VSCODE_GITK_NODE is required");
    let writer = env::var("VSCODE_GITK_NATIVE_WRITER").expect("VSCODE_GITK_NATIVE_WRITER is required");
    let args: Vec<String> = env::args().skip(1).collect();
    if let Some(index) = args.iter().position(|argument| argument == "-c") {
        if let Some(command) = args.get(index + 1) {
            if let Some((source, destination)) = redirected(command) {
                let output = Command::new(&bash)
                    .arg("-c")
                    .arg(source)
                    .stdin(Stdio::inherit())
                    .output()
                    .expect("failed to launch bash");
                io::stderr().write_all(&output.stderr).expect("failed to forward stderr");
                if !output.status.success() {
                    std::process::exit(exit_code(output.status));
                }
                let mut child = Command::new(&node)
                    .arg(&writer)
                    .arg(destination)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .expect("failed to launch native writer");
                child.stdin.take().expect("native writer stdin unavailable")
                    .write_all(&output.stdout).expect("failed to send redirected output");
                let status = child.wait().expect("failed to wait for native writer");
                std::process::exit(exit_code(status));
            }
        }
    }
    let status = Command::new(&bash)
        .args(&args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("failed to launch bash");
    std::process::exit(exit_code(status));
}
`);
  run('rustc', [shellSource, '-O', '-o', shellWrapper]);

  const make = path.join(bin, 'make.exe');
  let makeWorks = false;
  if (fs.existsSync(make)) {
    const check = spawnSync(make, ['--version'], { encoding: 'utf8' });
    makeWorks = !check.error && check.status === 0;
  }
  if (!makeWorks) await ensureDownload(DOWNLOADS.make, make);
  run(make, ['--version']);

  for (const definition of [DOWNLOADS.localeMaketextSimple, DOWNLOADS.extUtilsMakeMaker]) {
    const archive = path.join(downloads, definition.file);
    const directory = path.join(modules, definition.directory);
    if (!fs.existsSync(directory)) {
      await ensureDownload(definition, archive);
      run('tar.exe', ['-xzf', archive, '-C', modules]);
    }
  }

  const stubs = path.join(root, 'perl-stubs');
  const podUsage = path.join(stubs, 'Pod', 'Usage.pm');
  fs.mkdirSync(path.dirname(podUsage), { recursive: true });
  fs.writeFileSync(podUsage, [
    'package Pod::Usage;',
    "use strict;",
    "use warnings;",
    "use Exporter 'import';",
    'our @EXPORT = qw(pod2usage);',
    'our @EXPORT_OK = qw(pod2usage);',
    'sub pod2usage { die "pod2usage was invoked while configuring OpenSSL\\n"; }',
    '1;',
    '',
  ].join('\n'));

  const zigCommand = zig.replaceAll('\\', '/');
  const zigAr = path.join(bin, 'ar.exe');
  const zigRanlib = path.join(bin, 'zig-ranlib.sh');
  fs.writeFileSync(zigRanlib, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `zig='${zigCommand}'`,
    'arguments=()',
    'for item in "$@"; do',
    '  if [[ "$item" =~ ^/[A-Za-z]/ ]]; then item="$(cygpath -w "$item")"; fi',
    '  arguments+=("$item")',
    'done',
    '"$zig" ranlib "${arguments[@]}"',
    '',
  ].join('\n'));

  const gitTools = findGitUnixTools();
  const bashEnvironment = path.join(root, 'bash-env.sh');
  fs.writeFileSync(bashEnvironment, `export PATH='${toMsysPath(bin)}':\"$PATH\"\n`);
  const perl5lib = [
    stubs,
    path.join(modules, DOWNLOADS.localeMaketextSimple.directory, 'lib'),
    path.join(modules, DOWNLOADS.extUtilsMakeMaker.directory, 'lib'),
  ].map(toMsysPath).join(':');
  const env = {
    ...process.env,
    CARGO_ZIGBUILD_ZIG_COMMAND: zig,
    CARGO_ZIGBUILD_ZIG_VERSION: ZIG_VERSION,
    CARGO_MAKEFLAGS: process.env.VSCODE_GITK_MAKEFLAGS || '-j8',
    MAKEFLAGS: [process.env.MAKEFLAGS, `SHELL=${shellWrapper.replaceAll('\\', '/')}`, `PERL=${gitTools.perl.replaceAll('\\', '/')}`].filter(Boolean).join(' '),
    BASH_ENV: toMsysPath(bashEnvironment),
    MSYSTEM: process.env.MSYSTEM || 'MINGW64',
    SHELL: process.env.SHELL || '/usr/bin/bash',
    MSYS2_ENV_CONV_EXCL: [process.env.MSYS2_ENV_CONV_EXCL, 'PERL5LIB'].filter(Boolean).join(';'),
    MSYS2_ARG_CONV_EXCL: process.env.MSYS2_ARG_CONV_EXCL || '*',
    PERL5LIB: perl5lib,
    PERL: gitTools.perl,
    VSCODE_GITK_REAL_BASH: gitTools.bash,
    VSCODE_GITK_NODE: process.execPath,
    VSCODE_GITK_NATIVE_COPY: copyScript,
    VSCODE_GITK_NATIVE_WRITER: writerScript,
    VSCODE_GITK_ZIG_AR: zigAr.replaceAll('\\', '/'),
    VSCODE_GITK_ZIG_RANLIB: zigRanlib.replaceAll('\\', '/'),
    VSCODE_GITK_CARGO_TARGET_DIR: process.env.VSCODE_GITK_CARGO_TARGET_DIR || path.join(root, 'cargo-target'),
    PATH: [bin, path.dirname(zig), gitTools.bin, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  run(gitTools.perl, ['-MPod::Usage', '-MLocale::Maketext::Simple', '-MExtUtils::MakeMaker', '-MIPC::Cmd', '-e', '1'], { env });
  return env;
}

function ensureCargoZigbuild(env) {
  const check = spawnSync('cargo-zigbuild', ['--version'], { env, encoding: 'utf8' });
  if (!check.error && check.status === 0 && String(check.stdout).includes(CARGO_ZIGBUILD_VERSION)) return;
  console.log(`Installing cargo-zigbuild ${CARGO_ZIGBUILD_VERSION}`);
  run('cargo', ['install', 'cargo-zigbuild', '--version', CARGO_ZIGBUILD_VERSION, '--locked'], { env, stdio: 'inherit' });
}

function ensureWindowsArchiveWrapper(env) {
  const located = run('where.exe', ['cargo-zigbuild.exe'], { env }).split(/\r?\n/).find(Boolean);
  if (!located) throw new Error('cargo-zigbuild.exe was installed but cannot be located');
  const destination = path.join(toolsRoot(), 'bin', 'ar.exe');
  fs.copyFileSync(located, destination);
  env.VSCODE_GITK_ZIG_AR = destination.replaceAll('\\', '/');
  run(destination, ['--version'], { env });
}

async function prepareNativeBuildEnvironment() {
  if (process.platform !== 'win32') return { ...process.env };
  const env = await ensureWindowsTools();
  ensureCargoZigbuild(env);
  ensureWindowsArchiveWrapper(env);
  return env;
}

module.exports = { prepareNativeBuildEnvironment, toolsRoot, toMsysPath };
