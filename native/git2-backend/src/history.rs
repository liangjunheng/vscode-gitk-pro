use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use chrono::{DateTime, FixedOffset, Utc};
use git2::{
    BranchType, DiffDelta, DiffFindOptions, DiffOptions, ObjectType, Oid, Sort, TreeWalkMode,
    TreeWalkResult,
};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

fn signature_text(bytes: &[u8], fallback: &str) -> String {
    let value = String::from_utf8_lossy(bytes).into_owned();
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value
    }
}

fn iso_time(time: git2::Time) -> String {
    let Some(utc) = DateTime::<Utc>::from_timestamp(time.seconds(), 0) else {
        return String::new();
    };
    let offset = FixedOffset::east_opt(time.offset_minutes() * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
    utc.with_timezone(&offset).to_rfc3339()
}

fn refs_by_oid(repo: &git2::Repository) -> HashMap<Oid, Vec<String>> {
    let mut values: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let name = reference.name().unwrap_or_default();
            if name.ends_with("/HEAD") {
                continue;
            }
            let target = reference
                .peel(ObjectType::Commit)
                .ok()
                .map(|object| object.id());
            let Some(target) = target else {
                continue;
            };
            let label = if let Some(rest) = name.strip_prefix("refs/tags/") {
                format!("tag: {rest}")
            } else if let Some(rest) = name.strip_prefix("refs/heads/") {
                rest.to_owned()
            } else if let Some(rest) = name.strip_prefix("refs/remotes/") {
                rest.to_owned()
            } else {
                reference.shorthand().unwrap_or(name).to_owned()
            };
            values.entry(target).or_default().push(label);
        }
    }
    values
}

pub fn branches(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let head = repo.head().ok();
    let current_name = head
        .as_ref()
        .and_then(|value| value.name().ok())
        .and_then(|name| name.strip_prefix("refs/heads/"))
        .map(str::to_owned);
    let head_id = head
        .as_ref()
        .and_then(|value| value.target())
        .map(|oid| oid.to_string());
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for entry in repo.branches(None).map_err(format_git_error)? {
        let (branch, kind) = entry.map_err(format_git_error)?;
        let Some(name) = branch.name().map_err(format_git_error)? else {
            continue;
        };
        if kind == BranchType::Remote && name.ends_with("/HEAD") {
            continue;
        }
        let reference = branch.get();
        let Some(target) = reference
            .peel(ObjectType::Commit)
            .ok()
            .map(|object| object.id())
        else {
            continue;
        };
        let upstream_name = if kind == BranchType::Local {
            branch
                .upstream()
                .ok()
                .and_then(|upstream| upstream.name().ok().flatten().map(str::to_owned))
        } else {
            None
        };
        let value = json!({
            "hash": target.to_string(),
            "label": name,
            "name": reference.name().unwrap_or_default(),
            "upstreamName": upstream_name,
        });
        if kind == BranchType::Local {
            local.push(value);
        } else {
            remote.push(value);
        }
    }
    Ok(json!({
        "currentBranch": current_name.as_ref().map(|name| format!("refs/heads/{name}")),
        "detachedHead": if current_name.is_none() { head_id } else { None },
        "local": local,
        "remote": remote,
    }))
}

pub fn head(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let Ok(head) = repo.head() else {
        return Ok(Value::Null);
    };
    let id = head
        .peel(ObjectType::Commit)
        .map_err(format_git_error)?
        .id()
        .to_string();
    let branch = if head.is_branch() {
        head.shorthand().ok().map(str::to_owned)
    } else {
        None
    };
    Ok(json!({ "hash": id, "branch": branch, "detached": repo.head_detached().unwrap_or(false) }))
}

pub fn commits(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let refs = string_array(payload, "refs")?;
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize);
    let skip = payload.get("skip").and_then(Value::as_u64).unwrap_or(0) as usize;
    let repo = open_repository(root_path)?;
    let mut walk = repo.revwalk().map_err(format_git_error)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(format_git_error)?;
    if payload.get("all").and_then(Value::as_bool).unwrap_or(false) {
        let _ = walk.push_glob("refs/*");
    } else if refs.is_empty() {
        if walk.push_head().is_err() {
            return Ok(Value::Array(Vec::new()));
        }
    } else {
        for reference in refs {
            if let Ok(object) = repo.revparse_single(&reference) {
                let _ = walk.push(object.id());
            }
        }
    }
    let decorations = refs_by_oid(&repo);
    let mut result = Vec::new();
    for oid in walk.skip(skip).filter_map(Result::ok) {
        if limit.is_some_and(|limit| result.len() >= limit) {
            break;
        }
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let author = commit.author();
        let committer = commit.committer();
        let raw_message = String::from_utf8_lossy(commit.message_bytes()).into_owned();
        let subject = commit.summary().unwrap_or_default().to_owned();
        let body = commit.body().unwrap_or_default().to_owned();
        result.push(json!({
            "hash": oid.to_string(),
            "shortHash": oid.to_string().chars().take(8).collect::<String>(),
            "parents": commit.parent_ids().map(|id| id.to_string()).collect::<Vec<_>>(),
            "author": signature_text(author.name_bytes(), "Unknown author"),
            "authorEmail": signature_text(author.email_bytes(), ""),
            "committer": signature_text(committer.name_bytes(), "Unknown committer"),
            "committerEmail": signature_text(committer.email_bytes(), ""),
            "authorDate": iso_time(author.when()),
            "message": subject,
            "body": body,
            "rawMessage": raw_message,
            "refs": decorations.get(&oid).cloned().unwrap_or_default(),
            "commitTime": commit.time().seconds(),
        }));
    }
    Ok(Value::Array(result))
}

fn mode_text(mode: git2::FileMode) -> String {
    format!("{:06o}", u32::from(mode))
}

fn status_text(status: git2::Delta) -> &'static str {
    match status {
        git2::Delta::Added => "A",
        git2::Delta::Deleted => "D",
        git2::Delta::Renamed => "R",
        git2::Delta::Copied => "C",
        git2::Delta::Typechange => "T",
        git2::Delta::Conflicted => "U",
        _ => "M",
    }
}

fn delta_value(delta: DiffDelta<'_>) -> Value {
    let old = delta.old_file();
    let new = delta.new_file();
    let old_mode = mode_text(old.mode());
    let new_mode = mode_text(new.mode());
    let path = new
        .path()
        .or_else(|| old.path())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let old_path = if matches!(delta.status(), git2::Delta::Renamed | git2::Delta::Copied) {
        old.path()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
    } else {
        None
    };
    json!({
        "path": path,
        "status": status_text(delta.status()),
        "oldPath": old_path,
        "oldObjectId": old.id().to_string(),
        "newObjectId": new.id().to_string(),
        "oldMode": old_mode,
        "newMode": new_mode,
        "isGitlink": old_mode == "160000" || new_mode == "160000",
    })
}

pub fn commit_files(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let revision = string_arg(payload, "revision")?;
    let repo = open_repository(root_path)?;
    let commit = repo
        .revparse_single(revision)
        .map_err(format_git_error)?
        .peel_to_commit()
        .map_err(format_git_error)?;
    let tree = commit.tree().map_err(format_git_error)?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let mut options = DiffOptions::new();
    options
        .include_typechange(true)
        .recurse_untracked_dirs(true);
    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut options))
        .map_err(format_git_error)?;
    let mut find = DiffFindOptions::new();
    find.renames(true);
    let _ = diff.find_similar(Some(&mut find));
    Ok(Value::Array(diff.deltas().map(delta_value).collect()))
}

pub fn gitlink_paths(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let revision = string_arg(payload, "revision")?;
    let repo = open_repository(root_path)?;
    let tree = repo
        .revparse_single(revision)
        .map_err(format_git_error)?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let mut result = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if entry.filemode() == 0o160000 {
            let name = entry.name().unwrap_or_default();
            result.push(format!("{root}{name}"));
        }
        TreeWalkResult::Ok
    })
    .map_err(format_git_error)?;
    Ok(json!(result))
}

pub fn ahead_behind(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let head = repo
        .head()
        .map_err(format_git_error)?
        .peel_to_commit()
        .map_err(format_git_error)?;
    let branch = repo
        .find_branch(
            repo.head()
                .map_err(format_git_error)?
                .shorthand()
                .unwrap_or_default(),
            BranchType::Local,
        )
        .map_err(format_git_error)?;
    let upstream = branch
        .upstream()
        .map_err(format_git_error)?
        .get()
        .peel_to_commit()
        .map_err(format_git_error)?;
    let (ahead, behind) = repo
        .graph_ahead_behind(head.id(), upstream.id())
        .map_err(format_git_error)?;
    Ok(json!({ "ahead": ahead, "behind": behind }))
}

pub fn commit_details(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let hashes = string_array(payload, "hashes")?;
    let repo = open_repository(root_path)?;
    let mut values = Vec::new();
    for hash in hashes {
        let Ok(oid) = Oid::from_str(&hash) else {
            continue;
        };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        values.push(json!({
            "hash": hash,
            "shortHash": hash.chars().take(8).collect::<String>(),
            "message": String::from_utf8_lossy(commit.message_bytes()).into_owned(),
            "subject": commit.summary().unwrap_or_default(),
            "author": signature_text(commit.author().name_bytes(), "Unknown author"),
            "authorEmail": signature_text(commit.author().email_bytes(), ""),
            "authorDate": iso_time(commit.author().when()),
        }));
    }
    Ok(Value::Array(values))
}

pub fn range_commits(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let from = string_arg(payload, "from")?;
    let to = string_arg(payload, "to")?;
    let repo = open_repository(root_path)?;
    let mut walk = repo.revwalk().map_err(format_git_error)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(format_git_error)?;
    walk.push_range(&format!("{from}..{to}"))
        .map_err(format_git_error)?;
    let hashes = walk
        .filter_map(Result::ok)
        .map(|id| id.to_string())
        .collect::<Vec<_>>();
    commit_details(&json!({ "rootPath": root_path, "hashes": hashes }))
}

pub fn changed_paths(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let before = string_arg(payload, "before")?;
    let after = string_arg(payload, "after")?;
    let repo = open_repository(root_path)?;
    let before_tree = repo
        .revparse_single(before)
        .map_err(format_git_error)?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let after_tree = repo
        .revparse_single(after)
        .map_err(format_git_error)?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&before_tree), Some(&after_tree), Some(&mut options))
        .map_err(format_git_error)?;
    let mut paths = BTreeSet::new();
    for delta in diff.deltas() {
        if let Some(path) = delta.old_file().path() {
            paths.insert(path.to_string_lossy().replace('\\', "/"));
        }
        if let Some(path) = delta.new_file().path() {
            paths.insert(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(json!(paths))
}

pub fn push_branches(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
    let repo = open_repository(root_path)?;
    let current = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().ok().map(str::to_owned));
    let mut remote_targets = Vec::new();
    let mut remotes = Vec::new();
    for entry in repo
        .branches(Some(BranchType::Remote))
        .map_err(format_git_error)?
    {
        let (branch, _) = entry.map_err(format_git_error)?;
        let Some(name) = branch.name().map_err(format_git_error)? else {
            continue;
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        if let Some(target) = branch.get().target() {
            remote_targets.push(target);
        }
        let mut parts = name.splitn(2, '/');
        let remote = parts.next().unwrap_or_default();
        let branch_name = parts.next().unwrap_or_default();
        if !remote.is_empty() && !branch_name.is_empty() {
            remotes.push((remote.to_owned(), branch_name.to_owned(), name.to_owned()));
        }
    }
    let mut result = Vec::new();
    for entry in repo
        .branches(Some(BranchType::Local))
        .map_err(format_git_error)?
    {
        let (branch, _) = entry.map_err(format_git_error)?;
        let Some(name) = branch.name().map_err(format_git_error)? else {
            continue;
        };
        let Some(local_oid) = branch.get().target() else {
            continue;
        };
        let upstream = branch.upstream().ok();
        let upstream_name = upstream
            .as_ref()
            .and_then(|value| value.name().ok().flatten())
            .unwrap_or_default()
            .to_owned();
        let preferred = if !upstream_name.is_empty() {
            let mut parts = upstream_name.splitn(2, '/');
            let remote = parts.next().unwrap_or_default().to_owned();
            let branch_name = parts.next().unwrap_or_default().to_owned();
            if !remote.is_empty() && !branch_name.is_empty() {
                Some((remote, branch_name, upstream_name.clone()))
            } else {
                None
            }
        } else {
            None
        };
        let mut targets = Vec::new();
        if let Some(value) = preferred.clone() {
            targets.push(value);
        }
        for remote in &remotes {
            if preferred
                .as_ref()
                .is_some_and(|value| value.0 == remote.0 && value.1 == remote.1)
            {
                continue;
            }
            targets.push(remote.clone());
        }
        let mut walk = repo.revwalk().map_err(format_git_error)?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
            .map_err(format_git_error)?;
        walk.push(local_oid).map_err(format_git_error)?;
        for oid in &remote_targets {
            let _ = walk.hide(*oid);
        }
        let mut recent = Vec::new();
        for oid in walk.filter_map(Result::ok).take(limit) {
            if let Ok(commit) = repo.find_commit(oid) {
                recent.push(json!({ "subject": commit.summary().unwrap_or_default(), "timestamp": commit.time().seconds() }));
            }
        }
        for (remote, remote_branch, label) in targets {
            result.push(json!({
                "name": name,
                "upstreamName": label,
                "upstreamRemote": remote,
                "upstreamBranch": remote_branch,
                "isCurrent": current.as_deref() == Some(name),
                "recentUnpushedCommits": recent,
            }));
        }
    }
    result.sort_by(|left, right| {
        let left_current = left
            .get("isCurrent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let right_current = right
            .get("isCurrent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        right_current
            .cmp(&left_current)
            .then_with(|| {
                left.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .cmp(
                        right
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
            })
            .then_with(|| {
                left.get("upstreamName")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .cmp(
                        right
                            .get("upstreamName")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
            })
    });
    Ok(Value::Array(result))
}

pub fn repository_state(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let head = repo.head().ok();
    let head_id = head
        .as_ref()
        .and_then(|reference| reference.peel_to_commit().ok())
        .map(|commit| commit.id().to_string())
        .unwrap_or_default();
    let branch = head
        .as_ref()
        .and_then(|reference| reference.shorthand().ok())
        .unwrap_or("HEAD")
        .to_owned();
    let mut refs = BTreeSet::new();
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let name = reference.name().unwrap_or_default();
            let target = reference
                .peel(ObjectType::Commit)
                .ok()
                .map(|object| object.id().to_string())
                .unwrap_or_default();
            refs.insert(format!("{name} {target}"));
        }
    }
    Ok(
        json!({ "head": head_id, "branch": branch, "refs": refs.into_iter().collect::<Vec<_>>().join("\n"), "status": "" }),
    )
}

pub fn gitlink_changes(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let before = repo
        .revparse_single(string_arg(payload, "before")?)
        .map_err(format_git_error)?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let after = repo
        .revparse_single(string_arg(payload, "after")?)
        .map_err(format_git_error)?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&before), Some(&after), Some(&mut options))
        .map_err(format_git_error)?;
    let mut values = Vec::new();
    for delta in diff.deltas() {
        let old_mode = delta.old_file().mode();
        let new_mode = delta.new_file().mode();
        if old_mode != git2::FileMode::Commit && new_mode != git2::FileMode::Commit {
            continue;
        }
        let status = match delta.status() {
            git2::Delta::Added => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Renamed => "R",
            _ => "M",
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        values.push(json!({ "status": status, "path": path }));
    }
    Ok(Value::Array(values))
}
