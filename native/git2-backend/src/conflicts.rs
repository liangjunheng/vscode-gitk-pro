use crate::support::{
    NativeResult, format_git_error, open_repository, repository_root, string_arg,
};
use git2::{Index, Repository};
use serde_json::{Value, json};
use std::path::{Component, Path};

fn validate_path(path: &str) -> NativeResult<()> {
    if path.is_empty()
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid merge path".to_owned());
    }
    Ok(())
}

fn stages(repo: &Repository, index: &Index, path: &str) -> NativeResult<Value> {
    let mut values = Vec::new();
    for stage in 1..=3 {
        let Some(entry) = index.get_path(Path::new(path), stage) else {
            values.push(Value::Null);
            continue;
        };
        if entry.mode != 0o100644 && entry.mode != 0o100755 {
            return Err("Only regular UTF-8 text conflicts are supported; Gitlinks and symlinks need a separate resolution".to_owned());
        }
        let blob = repo.find_blob(entry.id).map_err(format_git_error)?;
        let content = std::str::from_utf8(blob.content())
            .map_err(|_| "Conflict is not UTF-8 text".to_owned())?;
        if content.contains('\0') {
            return Err("Binary conflicts cannot use the text merge editor".to_owned());
        }
        values.push(json!({"oid": entry.id.to_string(), "mode": entry.mode, "content": content}));
    }
    if values.iter().all(Value::is_null) {
        return Err("The file no longer has an index conflict".to_owned());
    }
    Ok(Value::Array(values))
}

fn worktree(repo: &Repository, path: &str) -> NativeResult<Option<String>> {
    let root = repository_root(repo)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = root.join(path);
    // Check ancestors before following links, including when the target is missing.
    let mut ancestor = Some(target.as_path());
    while let Some(candidate) = ancestor {
        if let Ok(metadata) = std::fs::symlink_metadata(candidate) {
            if metadata.file_type().is_symlink() {
                return Err("Merge path contains a symlink".to_owned());
            }
            let resolved = candidate.canonicalize().map_err(|e| e.to_string())?;
            if !resolved.starts_with(&root) {
                return Err("Merge path escapes the repository".to_owned());
            }
        }
        if candidate == root {
            break;
        }
        ancestor = candidate.parent();
    }
    match std::fs::read(&target) {
        Ok(bytes) => {
            let text =
                String::from_utf8(bytes).map_err(|_| "Result is not UTF-8 text".to_owned())?;
            if text.contains('\0') {
                return Err("Result is binary".to_owned());
            }
            Ok(Some(text))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn read(payload: &Value) -> NativeResult<Value> {
    let path = string_arg(payload, "path")?;
    validate_path(path)?;
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let index = repo.index().map_err(format_git_error)?;
    Ok(json!({"stages": stages(&repo, &index, path)?, "worktree": worktree(&repo, path)?}))
}

pub fn save(payload: &Value) -> NativeResult<Value> {
    let path = string_arg(payload, "path")?;
    validate_path(path)?;
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let mut index = repo.index().map_err(format_git_error)?;
    let actual_stages = stages(&repo, &index, path)?;
    if payload.get("stages") != Some(&actual_stages)
        || payload.get("worktree") != Some(&json!(worktree(&repo, path)?))
    {
        return Err(
            "Conflict or working file changed externally. Reopen the merge editor before saving"
                .to_owned(),
        );
    }
    let content = string_arg(payload, "content")?;
    if content.contains('\0') {
        return Err("Result is binary".to_owned());
    }
    let complete = payload
        .get("complete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if complete
        && content.lines().any(|line| {
            line.starts_with("<<<<<<<")
                || line.starts_with("=======")
                || line.starts_with(">>>>>>>")
                || line.starts_with("|||||||")
        })
    {
        return Err("Resolve conflict markers before completing the merge".to_owned());
    }
    let old = worktree(&repo, path)?;
    let normalized = content.replace("\r\n", "\n");
    let output = if old.as_ref().is_some_and(|text| text.contains("\r\n")) {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let target = repository_root(&repo)?.join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, &output).map_err(|e| e.to_string())?;
    if complete {
        index.add_path(Path::new(path)).map_err(format_git_error)?;
        crate::filters::apply_clean_filters(&repo, &mut index, &[path.to_owned()])?;
        index.write().map_err(format_git_error)?;
    }
    Ok(json!({"worktree": output}))
}
