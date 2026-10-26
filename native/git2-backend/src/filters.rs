use crate::support::{NativeResult, format_git_error, repository_root};
use git2::{AttrCheckFlags, AttrValue, Binding, Index, Repository};
use std::ffi::{CString, c_void};
use std::io::Write;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn attribute_string(repo: &Repository, path: &Path, name: &str) -> Option<String> {
    let raw = repo
        .get_attr(path, name, AttrCheckFlags::FILE_THEN_INDEX)
        .ok()
        .flatten();
    match AttrValue::from_string(raw) {
        AttrValue::String(value) => Some(value.to_owned()),
        _ => None,
    }
}

fn attribute_enabled(repo: &Repository, path: &Path, name: &str) -> Option<bool> {
    let raw = repo
        .get_attr(path, name, AttrCheckFlags::FILE_THEN_INDEX)
        .ok()
        .flatten();
    match AttrValue::from_string(raw) {
        AttrValue::True => Some(true),
        AttrValue::False => Some(false),
        AttrValue::String(_) => Some(true),
        AttrValue::Bytes(_) | AttrValue::Unspecified => None,
    }
}

fn shell_quote(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        format!("\"{}\"", value.replace('"', "\\\""))
    }
    #[cfg(not(windows))]
    {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn run_filter(
    repo: &Repository,
    path: &Path,
    command: &str,
    input: &[u8],
) -> NativeResult<Vec<u8>> {
    let root = repository_root(repo)?;
    let command = command.replace("%f", &shell_quote(path));
    #[cfg(windows)]
    let mut child = Command::new("cmd");
    #[cfg(windows)]
    child.args(["/D", "/C", &command]);
    #[cfg(not(windows))]
    let mut child = Command::new("sh");
    #[cfg(not(windows))]
    child.args(["-c", &command]);
    let mut child = child
        .current_dir(&root)
        .env("GIT_DIR", repo.path())
        .env("GIT_WORK_TREE", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Git filter `{command}`: {error}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "无法打开 filter 标准输入".to_owned())?
        .write_all(input)
        .map_err(|error| format!("写入 Git filter 失败: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 Git filter 失败: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(format!(
        "Git filter `{command}` 失败: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn filter_command(repo: &Repository, path: &Path, direction: &str) -> Option<(String, bool)> {
    let name = attribute_string(repo, path, "filter")?;
    let config = repo.config().ok()?;
    let command = config
        .get_string(&format!("filter.{name}.{direction}"))
        .ok()?;
    let required = config
        .get_bool(&format!("filter.{name}.required"))
        .unwrap_or(false);
    Some((command, required))
}

fn packet(output: &mut Vec<u8>, data: &[u8]) {
    output.extend_from_slice(format!("{:04x}", data.len() + 4).as_bytes());
    output.extend_from_slice(data);
}

fn parse_packets(data: &[u8]) -> NativeResult<Vec<Option<Vec<u8>>>> {
    let mut packets = Vec::new();
    let mut offset = 0;
    while offset + 4 <= data.len() {
        let length_text =
            std::str::from_utf8(&data[offset..offset + 4]).map_err(|error| error.to_string())?;
        let length = usize::from_str_radix(length_text, 16).map_err(|error| error.to_string())?;
        offset += 4;
        if length == 0 {
            packets.push(None);
            continue;
        }
        if length < 4 || offset + length - 4 > data.len() {
            return Err("filter-process 返回了无效 pkt-line".to_owned());
        }
        packets.push(Some(data[offset..offset + length - 4].to_vec()));
        offset += length - 4;
    }
    Ok(packets)
}

fn run_process_filter(
    repo: &Repository,
    path: &Path,
    command: &str,
    direction: &str,
    input: &[u8],
) -> NativeResult<Vec<u8>> {
    let mut request = Vec::new();
    packet(&mut request, b"git-filter-client\n");
    packet(&mut request, b"version=2\n");
    request.extend_from_slice(b"0000");
    packet(&mut request, b"capability=clean\n");
    packet(&mut request, b"capability=smudge\n");
    request.extend_from_slice(b"0000");
    packet(&mut request, format!("command={direction}\n").as_bytes());
    packet(
        &mut request,
        format!("pathname={}\n", path.to_string_lossy().replace('\\', "/")).as_bytes(),
    );
    request.extend_from_slice(b"0000");
    for chunk in input.chunks(65_000) {
        packet(&mut request, chunk);
    }
    request.extend_from_slice(b"0000");
    let response = run_filter(repo, path, command, &request)?;
    let packets = parse_packets(&response)?;
    let status_index = packets
        .iter()
        .position(|value| value.as_deref() == Some(b"status=success\n"))
        .ok_or_else(|| format!("filter-process {direction} 未返回成功状态"))?;
    let content_start = packets
        .iter()
        .enumerate()
        .skip(status_index + 1)
        .find_map(|(index, value)| value.is_none().then_some(index + 1))
        .ok_or_else(|| "filter-process 响应缺少内容分隔符".to_owned())?;
    let mut output = Vec::new();
    for value in packets.iter().skip(content_start) {
        let Some(value) = value else {
            break;
        };
        output.extend_from_slice(value);
    }
    Ok(output)
}

fn process_filter_command(repo: &Repository, path: &Path) -> Option<(String, bool)> {
    let name = attribute_string(repo, path, "filter")?;
    let config = repo.config().ok()?;
    let command = config.get_string(&format!("filter.{name}.process")).ok()?;
    let required = config
        .get_bool(&format!("filter.{name}.required"))
        .unwrap_or(false);
    Some((command, required))
}

fn is_binary(data: &[u8]) -> bool {
    data.iter().take(8000).any(|byte| *byte == 0)
}

fn normalize_lf(data: &[u8]) -> Vec<u8> {
    if !data.windows(2).any(|pair| pair == b"\r\n") {
        return data.to_vec();
    }
    let mut output = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if index + 1 < data.len() && data[index] == b'\r' && data[index + 1] == b'\n' {
            output.push(b'\n');
            index += 2;
        } else {
            output.push(data[index]);
            index += 1;
        }
    }
    output
}

fn expand_crlf(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len() + data.len() / 20);
    for (index, byte) in data.iter().enumerate() {
        if *byte == b'\n' && (index == 0 || data[index - 1] != b'\r') {
            output.push(b'\r');
        }
        output.push(*byte);
    }
    output
}

fn should_normalize(repo: &Repository, path: &Path, data: &[u8]) -> bool {
    if is_binary(data) || attribute_enabled(repo, path, "text") == Some(false) {
        return false;
    }
    if attribute_enabled(repo, path, "text") == Some(true) {
        return true;
    }
    repo.config()
        .ok()
        .and_then(|config| config.get_string("core.autocrlf").ok())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("input")
        })
}

pub fn clean_data(repo: &Repository, path: &Path, input: &[u8]) -> NativeResult<Vec<u8>> {
    if input.starts_with(b"%TSD-Header-###%") {
        return Err(format!(
            "{} 受到透明加密保护，当前进程无法读取明文",
            path.display()
        ));
    }
    let mut data = input.to_vec();
    if let Some((command, required)) = filter_command(repo, path, "clean") {
        match run_filter(repo, path, &command, &data) {
            Ok(output) => data = output,
            Err(error) if required => return Err(error),
            Err(_) => {}
        }
    } else if let Some((command, required)) = process_filter_command(repo, path) {
        match run_process_filter(repo, path, &command, "clean", &data) {
            Ok(output) => data = output,
            Err(error) if required => return Err(error),
            Err(_) => {}
        }
    }
    if should_normalize(repo, path, &data) {
        data = normalize_lf(&data);
    }
    Ok(data)
}

pub fn smudge_data(repo: &Repository, path: &Path, input: &[u8]) -> NativeResult<Vec<u8>> {
    let mut data = input.to_vec();
    let eol = attribute_string(repo, path, "eol");
    let auto_crlf = repo
        .config()
        .ok()
        .and_then(|config| config.get_string("core.autocrlf").ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("true"));
    if !is_binary(&data)
        && (eol.as_deref() == Some("crlf")
            || (eol.is_none() && auto_crlf && attribute_enabled(repo, path, "text") != Some(false)))
    {
        data = expand_crlf(&data);
    }
    if let Some((command, required)) = filter_command(repo, path, "smudge") {
        match run_filter(repo, path, &command, &data) {
            Ok(output) => data = output,
            Err(error) if required => return Err(error),
            Err(_) => {}
        }
    } else if let Some((command, required)) = process_filter_command(repo, path) {
        match run_process_filter(repo, path, &command, "smudge", &data) {
            Ok(output) => data = output,
            Err(error) if required => return Err(error),
            Err(_) => {}
        }
    }
    Ok(data)
}

pub fn apply_clean_filters(
    repo: &Repository,
    index: &mut Index,
    candidates: &[String],
) -> NativeResult<()> {
    let root = repository_root(repo)?;
    // 调用方传入的是状态清单中的精确文件路径；直接按 stage-0 查找，
    // 避免暂存一个文件时再次遍历整个 index。
    let entries = candidates
        .iter()
        .filter_map(|value| index.get_path(Path::new(value), 0))
        .collect::<Vec<_>>();
    for entry in entries {
        let path_text = String::from_utf8_lossy(&entry.path).into_owned();
        let path = Path::new(&path_text);
        // git_index_add_all already applies libgit2's built-in EOL filters.
        // Re-adding every file from a buffer needlessly rehashes it and clears
        // the index stat data, leaving a phantom worktree modification.
        if filter_command(repo, path, "clean").is_none()
            && process_filter_command(repo, path).is_none()
        {
            continue;
        }
        let absolute = root.join(path);
        if !absolute.is_file() {
            continue;
        }
        let input = std::fs::read(&absolute)
            .map_err(|error| format!("读取 {} 失败: {error}", absolute.display()))?;
        let clean = clean_data(repo, path, &input)?;
        index
            .add_frombuffer(&entry, &clean)
            .map_err(format_git_error)?;
    }
    Ok(())
}

const STASH_FILTER_EXTERNAL: u8 = 1 << 0;
const STASH_FILTER_BUILTIN: u8 = 1 << 1;
const STASH_FILTER_DEFAULT_ATTRIBUTES: u8 = 1 << 2;

unsafe extern "C" {
    fn git_stash_filter_flags_from_workdir(
        output: *mut u8,
        repository: *mut c_void,
        path_count: usize,
        paths: *const *const c_char,
    ) -> i32;
}

pub fn stash_filter_flags(repo: &Repository, paths: &[String]) -> NativeResult<Vec<u8>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = paths
        .iter()
        .map(|path| {
            CString::new(path.as_bytes()).map_err(|_| format!("路径包含无效的 NUL 字符: {path}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let pointers = encoded.iter().map(|path| path.as_ptr()).collect::<Vec<_>>();
    let mut flags = vec![0u8; paths.len()];
    // SAFETY: all C strings, the pointer array and the output buffer remain
    // alive and fixed for the duration of this synchronous libgit2 call.
    let result = unsafe {
        git_stash_filter_flags_from_workdir(
            flags.as_mut_ptr(),
            repo.raw().cast(),
            pointers.len(),
            pointers.as_ptr(),
        )
    };
    if result < 0 {
        return Err(format!(
            "读取 Git attributes 失败（libgit2 error {result}）"
        ));
    }
    Ok(flags)
}

/// Inspect stash paths before mutation. External filters are returned to the
/// caller for explicit clean/smudge execution; unreadable transparent-encryption
/// payloads are rejected before refs or worktree state change.
fn ensure_stashable_paths(root: &Path, paths: &[String], operation: &str) -> NativeResult<()> {
    use std::io::Read;

    if paths.is_empty() {
        return Ok(());
    }
    let worker_count = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .min(paths.len());
    let chunk_size = paths.len().div_ceil(worker_count);
    let encrypted = std::thread::scope(|scope| {
        let handles = paths
            .chunks(chunk_size)
            .enumerate()
            .map(|(chunk_index, chunk)| {
                scope.spawn(move || {
                    for (offset, value) in chunk.iter().enumerate() {
                        let mut header = [0u8; 16];
                        if let Ok(mut file) = std::fs::File::open(root.join(Path::new(value))) {
                            let read = file.read(&mut header).unwrap_or(0);
                            if header[..read].starts_with(b"%TSD-Header-###%") {
                                return Some((chunk_index * chunk_size + offset, value.clone()));
                            }
                        }
                    }
                    None
                })
            })
            .collect::<Vec<_>>();
        let mut encrypted = None;
        for handle in handles {
            let result = handle
                .join()
                .map_err(|_| "stash 文件安全预检线程异常".to_owned())?;
            if result.as_ref().is_some_and(|item| {
                encrypted
                    .as_ref()
                    .is_none_or(|current: &(usize, String)| item.0 < current.0)
            }) {
                encrypted = result;
            }
        }
        Ok::<_, String>(encrypted)
    })?;
    if let Some((_, value)) = encrypted {
        return Err(format!(
            "{value} 受到透明加密保护，当前进程无法读取明文，已拒绝{operation}"
        ));
    }
    Ok(())
}

pub fn stash_filter_flags_and_ensure_stashable(
    repo: &Repository,
    flag_paths: &[String],
    scan_paths: &[String],
    operation: &str,
) -> NativeResult<Vec<u8>> {
    let root = repository_root(repo)?;
    std::thread::scope(|scope| {
        let scan = scope.spawn(|| ensure_stashable_paths(&root, scan_paths, operation));
        let flags = stash_filter_flags(repo, flag_paths);
        let scan_result = scan
            .join()
            .map_err(|_| "stash 文件安全预检线程异常".to_owned());
        let flags = flags?;
        scan_result??;
        Ok(flags)
    })
}

pub fn ensure_stashable(
    repo: &Repository,
    paths: &[String],
    operation: &str,
) -> NativeResult<Vec<u8>> {
    stash_filter_flags_and_ensure_stashable(repo, paths, paths, operation)
}
pub fn stash_path_uses_external_filter(flags: u8) -> bool {
    flags & STASH_FILTER_EXTERNAL != 0
}

fn stash_filterable_worktree_file(index: &Index, absolute: &Path, relative: &Path) -> bool {
    if index
        .get_path(relative, 0)
        .is_some_and(|entry| entry.mode == 0o120000 || entry.mode == 0o160000)
    {
        return false;
    }
    std::fs::symlink_metadata(absolute).is_ok_and(|metadata| metadata.file_type().is_file())
}

pub fn clean_worktree_for_stash(
    repo: &Repository,
    paths: &[String],
) -> NativeResult<Vec<(PathBuf, Vec<u8>)>> {
    let root = repository_root(repo)?;
    let index = repo.index().map_err(format_git_error)?;
    let mut backups = Vec::new();
    let result = (|| {
        for value in paths {
            let relative = PathBuf::from(value);
            let absolute = root.join(&relative);
            if !stash_filterable_worktree_file(&index, &absolute, &relative) {
                continue;
            }
            let input = std::fs::read(&absolute)
                .map_err(|error| format!("读取 {} 失败: {error}", absolute.display()))?;
            let clean = clean_data(repo, &relative, &input)?;
            if clean != input {
                std::fs::write(&absolute, &clean)
                    .map_err(|error| format!("写入 {} 失败: {error}", absolute.display()))?;
                backups.push((absolute, input));
            }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        if let Err(restore_error) = restore_worktree_backups(backups) {
            return Err(format!(
                "{error}；同时还原 filter 输入失败: {restore_error}"
            ));
        }
        return Err(error);
    }
    Ok(backups)
}

pub fn restore_worktree_backups(backups: Vec<(PathBuf, Vec<u8>)>) -> NativeResult<()> {
    for (path, contents) in backups {
        std::fs::write(&path, contents)
            .map_err(|error| format!("还原 {} 失败: {error}", path.display()))?;
    }
    Ok(())
}

pub fn smudge_worktree_paths(repo: &Repository, paths: &[String]) -> NativeResult<()> {
    let root = repository_root(repo)?;
    let index = repo.index().map_err(format_git_error)?;
    for value in paths {
        let relative = PathBuf::from(value);
        let absolute = root.join(&relative);
        if !stash_filterable_worktree_file(&index, &absolute, &relative) {
            continue;
        }
        let input = std::fs::read(&absolute)
            .map_err(|error| format!("读取 {} 失败: {error}", absolute.display()))?;
        let output = smudge_data(repo, &relative, &input)?;
        if output != input {
            std::fs::write(&absolute, output)
                .map_err(|error| format!("写入 {} 失败: {error}", absolute.display()))?;
        }
    }
    Ok(())
}

pub fn stash_path_needs_builtin_filter(flags: u8) -> bool {
    flags & STASH_FILTER_BUILTIN != 0
}

pub fn stash_path_uses_default_attributes(flags: u8) -> bool {
    flags & STASH_FILTER_DEFAULT_ATTRIBUTES != 0 && flags & STASH_FILTER_EXTERNAL == 0
}

pub fn apply_smudge_filters(repo: &Repository, paths: &[String]) -> NativeResult<()> {
    let root = repository_root(repo)?;
    let index = repo.index().map_err(format_git_error)?;
    for value in paths {
        let path = PathBuf::from(value);
        let Some(entry) = index.get_path(&path, 0) else {
            continue;
        };
        let blob = repo.find_blob(entry.id).map_err(format_git_error)?;
        let output = smudge_data(repo, &path, blob.content())?;
        let absolute = root.join(&path);
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&absolute, output)
            .map_err(|error| format!("写入 {} 失败: {error}", absolute.display()))?;
    }
    Ok(())
}

pub fn apply_smudge_all_filtered(repo: &Repository) -> NativeResult<()> {
    let index = repo.index().map_err(format_git_error)?;
    let paths = index
        .iter()
        .filter_map(|entry| {
            let value = String::from_utf8_lossy(&entry.path).into_owned();
            filter_command(repo, Path::new(&value), "smudge").map(|_| value)
        })
        .collect::<Vec<_>>();
    apply_smudge_filters(repo, &paths)
}

pub fn worktree_data_uses_external_filter(repo: &Repository, path: &Path, input: &[u8]) -> bool {
    !input.starts_with(b"%TSD-Header-###%")
        && (filter_command(repo, path, "clean").is_some()
            || filter_command(repo, path, "smudge").is_some()
            || process_filter_command(repo, path).is_some())
}

pub fn worktree_data_matches_index(
    repo: &Repository,
    index: &Index,
    path: &Path,
    input: &[u8],
) -> bool {
    let Some(entry) = index.get_path(path, 0) else {
        return false;
    };
    if input.starts_with(b"%TSD-Header-###%") {
        return true;
    }
    let Ok(clean) = clean_data(repo, path, input) else {
        return false;
    };
    let Ok(blob) = repo.find_blob(entry.id) else {
        return false;
    };
    if blob.content() != clean {
        return false;
    }
    // External filters are defined by arbitrary processes and are not safely
    // reversible during a status read. Preserve the established clean-match
    // behavior for them; built-in EOL rules can be checked in both directions.
    if worktree_data_uses_external_filter(repo, path, input) {
        return true;
    }
    smudge_data(repo, path, blob.content()).is_ok_and(|expected| expected == input)
}
