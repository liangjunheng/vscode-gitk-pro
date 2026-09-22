use git2::{Error as GitError, Repository};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub type NativeResult<T> = Result<T, String>;

pub fn open_repository(path: &str) -> NativeResult<Repository> {
    Repository::discover(path).map_err(format_git_error)
}

pub fn repository_root(repo: &Repository) -> NativeResult<PathBuf> {
    repo.workdir()
        .map(Path::to_path_buf)
        .or_else(|| repo.path().parent().map(Path::to_path_buf))
        .ok_or_else(|| "无法确定仓库工作目录".to_owned())
}

pub fn string_arg<'a>(payload: &'a Value, name: &str) -> NativeResult<&'a str> {
    payload
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数: {name}"))
}

pub fn string_array(payload: &Value, name: &str) -> NativeResult<Vec<String>> {
    let Some(values) = payload.get(name) else {
        return Ok(Vec::new());
    };
    let array = values
        .as_array()
        .ok_or_else(|| format!("参数不是数组: {name}"))?;
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("参数包含非字符串: {name}"))
        })
        .collect()
}

pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn format_git_error(error: GitError) -> String {
    format!(
        "{} (class={:?}, code={:?})",
        error.message(),
        error.class(),
        error.code()
    )
}
