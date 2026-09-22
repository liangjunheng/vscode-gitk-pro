use crate::support::{
    NativeResult, format_git_error, open_repository, path_text, repository_root, string_arg,
};
use serde_json::{Value, json};

pub fn discover(payload: &Value) -> NativeResult<Value> {
    let path = string_arg(payload, "path")?;
    let repo = open_repository(path)?;
    Ok(json!({
        "workdir": path_text(&repository_root(&repo)?),
        "gitDir": path_text(repo.path()),
        "commonDir": path_text(repo.commondir()),
        "bare": repo.is_bare(),
        "shallow": repo.is_shallow(),
        "worktree": repo.is_worktree(),
    }))
}

pub fn config_get(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let key = string_arg(payload, "key")?;
    let default_value = payload
        .get("defaultValue")
        .and_then(Value::as_str)
        .unwrap_or("");
    let repo = open_repository(root_path)?;
    let config = repo.config().map_err(format_git_error)?;
    let value = config
        .get_string(key)
        .unwrap_or_else(|_| default_value.to_owned());
    Ok(Value::String(value))
}

pub fn submodules(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let root = repository_root(&repo)?;
    let modules = repo.submodules().map_err(format_git_error)?;
    Ok(Value::Array(
        modules
            .into_iter()
            .map(|module| {
                json!({
                    "name": module.name().unwrap_or_default(),
                    "path": path_text(module.path()),
                    "absolutePath": path_text(&root.join(module.path())),
                    "url": module.url().ok().flatten(),
                    "branch": module.branch().ok().flatten(),
                    "headId": module.head_id().map(|oid| oid.to_string()),
                    "indexId": module.index_id().map(|oid| oid.to_string()),
                    "workdirId": module.workdir_id().map(|oid| oid.to_string()),
                })
            })
            .collect(),
    ))
}
