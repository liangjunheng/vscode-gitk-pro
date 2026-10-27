use crate::support::{
    NativeResult, format_git_error, open_repository, path_text, repository_root, string_arg,
};
use git2::ConfigLevel;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

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

fn remote_name_arg(payload: &Value) -> NativeResult<&str> {
    let name = string_arg(payload, "remoteName")?.trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(char::is_whitespace)
        || !git2::Reference::is_valid_name(&format!("refs/remotes/{name}/test"))
    {
        return Err("Invalid remote name".to_owned());
    }
    Ok(name)
}

fn remove_config_values(config: &mut git2::Config, key: &str) -> NativeResult<()> {
    match config.remove_multivar(key, ".*") {
        Ok(()) => Ok(()),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(()),
        Err(error) => Err(format_git_error(error)),
    }
}

/// Mirror `git config --get-regexp '^(http\.proxy|remote\..*\.proxy)$'` across every
/// config level: any such key, even with an empty value, counts as an explicit proxy choice.
pub fn explicit_proxy_configured(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let config = repo.config().map_err(format_git_error)?;
    let mut entries = config.entries(None).map_err(format_git_error)?;
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(format_git_error)?;
        let Ok(name) = entry.name() else { continue };
        if name == "http.proxy"
            || name.strip_prefix("remote.").is_some_and(|rest| {
                rest.rsplit_once('.')
                    .is_some_and(|(remote, key)| !remote.is_empty() && key == "proxy")
            })
        {
            return Ok(Value::Bool(true));
        }
    }
    Ok(Value::Bool(false))
}

/// Local tag targets (annotated tags peeled to their commit) plus remote names, replacing
/// `git for-each-ref refs/tags` and `git remote`.
pub fn tag_targets(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let mut tags = serde_json::Map::new();
    for reference in repo
        .references_glob("refs/tags/*")
        .map_err(format_git_error)?
    {
        let reference = reference.map_err(format_git_error)?;
        let Ok(name) = reference.name() else { continue };
        let Some(short) = name.strip_prefix("refs/tags/") else {
            continue;
        };
        let target = reference.peel(git2::ObjectType::Any).ok().map(|object| {
            match object.peel(git2::ObjectType::Commit) {
                Ok(commit) => commit.id(),
                Err(_) => object.id(),
            }
        });
        if let Some(target) = target {
            tags.insert(short.to_owned(), Value::String(target.to_string()));
        }
    }
    let remotes = repo
        .remotes()
        .map_err(format_git_error)?
        .iter()
        .filter_map(|name| name.ok().flatten().map(str::to_owned))
        .collect::<Vec<_>>();
    Ok(json!({ "tags": tags, "remotes": remotes }))
}

pub fn add_remote(payload: &Value) -> NativeResult<Value> {
    let name = remote_name_arg(payload)?;
    let url = string_arg(payload, "url")?.trim();
    if url.is_empty() {
        return Err("Remote URL is empty".to_owned());
    }
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    repo.remote(name, url).map_err(format_git_error)?;
    Ok(Value::Null)
}

pub fn clear_remote_operations(payload: &Value) -> NativeResult<Value> {
    let name = remote_name_arg(payload)?;
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let mut config = repo
        .config()
        .map_err(format_git_error)?
        .open_level(ConfigLevel::Local)
        .map_err(format_git_error)?;
    // Push selection was retired; remove its old key as migration cleanup.
    for operation in ["fetch", "pull", "push"] {
        remove_config_values(&mut config, &format!("fastergit.remote.{name}.{operation}"))?;
    }
    Ok(Value::Null)
}

pub fn remove_remote(payload: &Value) -> NativeResult<Value> {
    let name = remote_name_arg(payload)?;
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let remote = repo.find_remote(name).map_err(format_git_error)?;
    let names = repo.remotes().map_err(format_git_error)?;
    let others = names
        .iter()
        .filter_map(|name| name.ok().flatten())
        .filter(|other| *other != name)
        .map(|other| repo.find_remote(other).map_err(format_git_error))
        .collect::<NativeResult<Vec<_>>>()?;
    let fetch_matches = |remote: &git2::Remote<'_>, reference: &str| {
        remote
            .refspecs()
            .any(|spec| spec.direction() == git2::Direction::Fetch && spec.dst_matches(reference))
    };
    // libgit2 remote_delete also deletes local/shared destinations. Git remote
    // remove protects both, so select only exclusively owned tracking refs.
    let mut references = Vec::new();
    for reference in repo.references().map_err(format_git_error)? {
        let reference = reference.map_err(format_git_error)?;
        let reference_name = reference.name().map_err(format_git_error)?;
        if reference_name.starts_with("refs/remotes/")
            && fetch_matches(&remote, reference_name)
            && !others
                .iter()
                .any(|other| fetch_matches(other, reference_name))
        {
            references.push(reference_name.to_owned());
        }
    }
    let mut config = repo
        .config()
        .map_err(format_git_error)?
        .open_level(ConfigLevel::Local)
        .map_err(format_git_error)?;
    let prefix = format!("remote.{name}.");
    let mut keys = std::collections::BTreeSet::new();
    let mut merge_counts = HashMap::<String, usize>::new();
    let mut merge_candidates = Vec::new();
    {
        let mut entries = config.entries(None).map_err(format_git_error)?;
        while let Some(entry) = entries.next() {
            let entry = entry.map_err(format_git_error)?;
            let key = entry.name().map_err(format_git_error)?;
            if let Some(branch) = key
                .strip_prefix("branch.")
                .and_then(|branch| branch.strip_suffix(".merge"))
            {
                *merge_counts.entry(branch.to_owned()).or_default() += 1;
            }
            if key
                .rsplit_once('.')
                .is_some_and(|(section, _)| section == prefix.trim_end_matches('.'))
            {
                keys.insert(key.to_owned());
            }
            if entry.value().ok() != Some(name) {
                continue;
            }
            if key == "remote.pushdefault" {
                keys.insert(key.to_owned());
            }
            if let Some(branch) = key.strip_prefix("branch.") {
                if let Some(branch) = branch.strip_suffix(".remote") {
                    keys.insert(key.to_owned());
                    merge_candidates.push(branch.to_owned());
                } else if branch.ends_with(".pushremote") {
                    keys.insert(key.to_owned());
                }
            }
        }
    }
    // Git deletes branch.<name>.merge only when it is a single value; a
    // multi-valued merge list survives because `git config --unset` refuses it.
    for branch in merge_candidates {
        if merge_counts.get(&branch) == Some(&1) {
            keys.insert(format!("branch.{branch}.merge"));
        }
    }
    // Clean active Fetch/Pull settings and the retired Push key only after confirming the remote exists.
    for operation in ["fetch", "pull", "push"] {
        keys.insert(format!("fastergit.remote.{name}.{operation}"));
    }
    for key in keys {
        remove_config_values(&mut config, &key)?;
    }
    for name in references {
        repo.find_reference(&name)
            .map_err(format_git_error)?
            .delete()
            .map_err(format_git_error)?;
    }
    Ok(Value::Null)
}

/// Persist one FasterGit remote operation setting directly through libgit2.
pub fn set_remote_operation(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let remote_name = string_arg(payload, "remoteName")?;
    let operation = string_arg(payload, "operation")?;
    if !matches!(operation, "fetch" | "pull") {
        return Err(format!("不支持的 remote 操作: {operation}"));
    }
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "缺少参数: enabled".to_owned())?;
    let repo = open_repository(root_path)?;
    let remote_names = repo
        .remotes()
        .map_err(format_git_error)?
        .iter()
        .filter_map(|name| name.ok().flatten().map(str::to_owned))
        .collect::<Vec<_>>();
    let canonical_remote = remote_names
        .iter()
        .find(|name| name.as_str() == remote_name)
        .ok_or_else(|| format!("不存在 remote: {remote_name}"))?;
    let config = repo.config().map_err(format_git_error)?;
    let mut local_config = config
        .open_level(ConfigLevel::Local)
        .map_err(format_git_error)?;
    local_config
        .set_str(
            &format!("fastergit.remote.{canonical_remote}.{operation}"),
            if enabled { "true" } else { "false" },
        )
        .map_err(format_git_error)?;
    Ok(Value::Null)
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
        if !matches!(operation, "fetch" | "pull")
            || !remote_name_set.iter().any(|name| name.as_str() == remote)
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
        operations
            .entry(remote.to_owned())
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

fn resolve_path(base: &Path, value: &str) -> PathBuf {
    let candidate = Path::new(value);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base.join(candidate)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

fn javascript_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
        | '\u{3000}' | '\u{feff}')
}

fn javascript_trimmed(value: &str) -> &str {
    value.trim_matches(javascript_whitespace)
}

fn declared_submodule_path(line: &str) -> Option<&str> {
    let value = line
        .trim_start_matches(javascript_whitespace)
        .strip_prefix("path")?
        .trim_start_matches(javascript_whitespace)
        .strip_prefix('=')?;
    let value = javascript_trimmed(value);
    (!value.is_empty()).then_some(value)
}

fn gitdir_value(contents: &str) -> Option<&str> {
    contents.lines().find_map(|line| {
        let value = line.strip_prefix("gitdir:")?;
        let value = javascript_trimmed(value);
        (!value.is_empty()).then_some(value)
    })
}

fn read_utf8_or_missing(path: &Path) -> NativeResult<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
            "submodule metadata is not UTF-8; use the compatibility scanner".to_owned()
        }),
        Err(_) => Ok(None),
    }
}

fn initialized_submodule(path: &Path) -> NativeResult<bool> {
    let git_path = path.join(".git");
    let Ok(metadata) = fs::metadata(&git_path) else {
        return Ok(false);
    };
    if metadata.is_dir() {
        return Ok(fs::metadata(git_path.join("HEAD")).is_ok());
    }
    let Some(contents) = read_utf8_or_missing(&git_path)? else {
        return Ok(false);
    };
    let Some(gitdir) = gitdir_value(&contents) else {
        return Ok(false);
    };
    Ok(fs::metadata(resolve_path(path, gitdir).join("HEAD")).is_ok())
}

fn collect_submodule_topology(parent: &Path, output: &mut Vec<Value>) -> NativeResult<()> {
    let Some(contents) = read_utf8_or_missing(&parent.join(".gitmodules"))? else {
        return Ok(());
    };
    // Match the previous scanner: declaration order, initialized HEAD check,
    // and depth-first ordering are part of repository-card stability.
    for module_path in contents
        .lines()
        .filter_map(declared_submodule_path)
        .map(|value| resolve_path(parent, value))
    {
        if !initialized_submodule(&module_path)? {
            continue;
        }
        output.push(json!({
            "path": path_text(&module_path),
            "parentPath": path_text(parent),
        }));
        collect_submodule_topology(&module_path, output)?;
    }
    Ok(())
}

pub fn submodule_topology(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let mut output = Vec::new();
    collect_submodule_topology(Path::new(root_path), &mut output)?;
    Ok(Value::Array(output))
}

fn short_reference_name(repo: &git2::Repository, full_name: &str) -> String {
    const RULES: [(&str, &str); 6] = [
        ("", ""),
        ("refs/", ""),
        ("refs/tags/", ""),
        ("refs/heads/", ""),
        ("refs/remotes/", ""),
        ("refs/remotes/", "/HEAD"),
    ];
    let strict = repo
        .config()
        .ok()
        .and_then(|config| config.get_bool("core.warnAmbiguousRefs").ok())
        .unwrap_or(true);
    for index in (1..RULES.len()).rev() {
        let (prefix, suffix) = RULES[index];
        let Some(candidate) = full_name
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(suffix))
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let limit = if strict { RULES.len() } else { index };
        let ambiguous =
            RULES[..limit]
                .iter()
                .enumerate()
                .any(|(other_index, (other_prefix, other_suffix))| {
                    if other_index == index {
                        return false;
                    }
                    let other = format!("{other_prefix}{candidate}{other_suffix}");
                    repo.find_reference(&other).is_ok()
                });
        if !ambiguous {
            return candidate.to_owned();
        }
    }
    full_name.to_owned()
}

pub fn remote_branches_containing_head(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    // libgit2 does not apply Git's replace/graft ancestry rewriting. Let the
    // caller use its compatibility path rather than choose a different remote.
    if repo
        .references_glob("refs/replace/*")
        .map_err(format_git_error)?
        .next()
        .is_some()
        || repo.commondir().join("info/grafts").exists()
    {
        return Err("Git replace/graft ancestry requires the compatibility reader".to_owned());
    }
    let head = repo
        .head()
        .map_err(format_git_error)?
        .peel_to_commit()
        .map_err(format_git_error)?
        .id();
    let mut result = Vec::new();
    let references = repo
        .references_glob("refs/remotes/*")
        .map_err(format_git_error)?;
    for reference in references {
        let reference = reference.map_err(format_git_error)?;
        let Ok(name) = reference.name() else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        let contains = commit.id() == head
            || repo
                .graph_descendant_of(commit.id(), head)
                .map_err(format_git_error)?;
        if contains {
            result.push(name.to_owned());
        }
    }
    result.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(Value::Array(
        result
            .into_iter()
            .map(|name| short_reference_name(&repo, &name))
            .filter(|name| !name.ends_with("/HEAD"))
            .map(Value::String)
            .collect(),
    ))
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
