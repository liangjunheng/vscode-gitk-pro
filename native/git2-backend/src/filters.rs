use crate::support::{NativeResult, format_git_error, repository_root};
use git2::{AttrCheckFlags, AttrValue, Index, Repository};
use std::io::Write;
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

pub fn worktree_matches_index(repo: &Repository, index: &Index, path: &Path) -> bool {
    let Some(root) = repo.workdir() else {
        return false;
    };
    let Some(entry) = index.get_path(path, 0) else {
        return false;
    };
    let Ok(input) = std::fs::read(root.join(path)) else {
        return false;
    };
    if input.starts_with(b"%TSD-Header-###%") {
        return true;
    }
    let Ok(clean) = clean_data(repo, path, &input) else {
        return false;
    };
    repo.find_blob(entry.id)
        .is_ok_and(|blob| blob.content() == clean)
}
