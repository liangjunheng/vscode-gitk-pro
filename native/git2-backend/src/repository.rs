use crate::support::{
    NativeResult, format_git_error, open_repository, path_text, repository_root, string_arg,
};
use git2::ConfigLevel;
use serde_json::{Value, json};
use std::collections::HashMap;

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

/// Read the remote URLs, local FasterGit remote-operation settings, and the
/// configured upstream remote without spawning Git CLI child processes.
pub fn remote_state(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let remote_names = repo
        .remotes()
        .map_err(format_git_error)?
        .iter()
        .filter_map(|name| name.ok().flatten().map(str::to_owned))
        .collect::<Vec<_>>();
    let remote_name_set = remote_names
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let remotes = remote_names
        .iter()
        .map(|name| {
            let remote = repo.find_remote(name).map_err(format_git_error)?;
            let fetch_url = remote.url().ok().unwrap_or_default().to_owned();
            let push_url = remote
                .pushurl()
                .ok()
                .flatten()
                .unwrap_or(fetch_url.as_str())
                .to_owned();
            Ok(json!({
                "name": name,
                "fetchUrl": fetch_url,
                "pushUrl": push_url,
            }))
        })
        .collect::<NativeResult<Vec<_>>>()?;

    let config = repo.config().map_err(format_git_error)?;
    let local_config = config
        .open_level(ConfigLevel::Local)
        .map_err(format_git_error)?;
    let mut operations: HashMap<String, HashMap<String, bool>> = HashMap::new();
    let mut entries = local_config.entries(None).map_err(format_git_error)?;
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(format_git_error)?;
        let Ok(name) = entry.name() else {
            continue;
        };
        let Some(rest) = name.strip_prefix("fastergit.remote.") else {
            continue;
        };
        let Some((remote, operation)) = rest.rsplit_once('.') else {
            continue;
        };
        if !matches!(operation, "fetch" | "pull" | "push")
            || !remote_name_set
                .iter()
                .any(|name| name.eq_ignore_ascii_case(remote))
        {
            continue;
        }
        let Ok(value) = entry.value() else {
            continue;
        };
        let Some(enabled) = (match value.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => Some(true),
            "false" | "no" | "off" | "0" => Some(false),
            _ => None,
        }) else {
            continue;
        };
        let canonical_remote = remote_names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(remote))
            .expect("remote was checked above");
        operations
            .entry(canonical_remote.clone())
            .or_default()
            .insert(operation.to_owned(), enabled);
    }

    let upstream_remote = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().ok().map(str::to_owned))
        .and_then(|branch| {
            local_config
                .get_string(&format!("branch.{branch}.remote"))
                .ok()
        })
        .filter(|remote| remote_name_set.iter().any(|name| *name == remote))
        .unwrap_or_default();

    Ok(json!({
        "remotes": remotes,
        "operations": operations,
        "upstreamRemote": upstream_remote,
    }))
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
