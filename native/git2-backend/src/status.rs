use crate::filters::worktree_matches_index;
use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use git2::{Delta, DiffDelta, FileMode, IndexEntry, Oid, Repository, Status, StatusOptions};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn mode_text(mode: FileMode) -> String {
    format!("{:06o}", u32::from(mode))
}

fn index_mode_text(mode: u32) -> String {
    format!("{:06o}", mode)
}

fn zero_oid(length: usize) -> String {
    "0".repeat(length.max(40))
}

fn delta_status(delta: &DiffDelta<'_>) -> &'static str {
    match delta.status() {
        Delta::Added | Delta::Untracked => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        Delta::Conflicted => "U",
        _ => "M",
    }
}

fn path_of(delta: &DiffDelta<'_>) -> String {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn file_from_delta(delta: DiffDelta<'_>, conflict: bool, untracked: bool) -> Value {
    let old_file = delta.old_file();
    let new_file = delta.new_file();
    let path = path_of(&delta);
    let old_path = if matches!(delta.status(), Delta::Renamed | Delta::Copied) {
        old_file
            .path()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
    } else {
        None
    };
    let old_id = old_file.id().to_string();
    let new_id = new_file.id().to_string();
    let old_mode = mode_text(old_file.mode());
    let new_mode = mode_text(new_file.mode());
    json!({
        "path": path,
        "status": delta_status(&delta),
        "oldPath": old_path,
        "oldObjectId": old_id,
        "newObjectId": new_id,
        "oldMode": old_mode,
        "newMode": new_mode,
        "isGitlink": old_mode == "160000" || new_mode == "160000",
        "isConflict": conflict,
        "isUntracked": untracked,
    })
}

fn conflict_entry(entry: &IndexEntry) -> (String, String, String) {
    (
        String::from_utf8_lossy(&entry.path).into_owned(),
        entry.id.to_string(),
        index_mode_text(entry.mode),
    )
}

fn selected_path(paths: &[String], path: &str) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|selected| path == selected || path.starts_with(&format!("{selected}/")))
}

fn gitlink_pointer_value(path: &str, old: Option<Oid>, new: Option<Oid>) -> Value {
    let status = match (old, new) {
        (None, Some(_)) => "A",
        (Some(_), None) => "D",
        _ => "M",
    };
    json!({
        "path": path,
        "status": status,
        "oldObjectId": old.map(|oid| oid.to_string()).unwrap_or_else(|| zero_oid(40)),
        "newObjectId": new.map(|oid| oid.to_string()).unwrap_or_else(|| zero_oid(40)),
        "oldMode": if old.is_some() { "160000" } else { "000000" },
        "newMode": if new.is_some() { "160000" } else { "000000" },
        "isGitlink": true,
        "isConflict": false,
        "isUntracked": false,
    })
}

/// Fast parent-repository mode: do not recurse into child worktrees, but retain
/// actual Gitlink pointer changes by comparing HEAD, index and child HEAD OIDs.
fn append_submodule_pointer_changes(
    repo: &Repository,
    paths: &[String],
    staged: &mut Vec<Value>,
    changes: &mut Vec<Value>,
) -> NativeResult<()> {
    for module in repo.submodules().map_err(format_git_error)? {
        let path = module.path().to_string_lossy().replace('\\', "/");
        if !selected_path(paths, &path) {
            continue;
        }
        let head = module.head_id();
        let index = module.index_id();
        let workdir = module.workdir_id();
        if head != index
            && !staged
                .iter()
                .any(|file| file.get("path").and_then(Value::as_str) == Some(path.as_str()))
        {
            staged.push(gitlink_pointer_value(&path, head, index));
        }
        // An uninitialized child has no workdir OID and is not a deletion.
        if index.is_some()
            && workdir.is_some()
            && index != workdir
            && !changes
                .iter()
                .any(|file| file.get("path").and_then(Value::as_str) == Some(path.as_str()))
        {
            changes.push(gitlink_pointer_value(&path, index, workdir));
        }
    }
    Ok(())
}

pub fn status(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    let recurse = payload
        .get("recurseUntrackedDirs")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let skip_submodule_worktrees = payload
        .get("skipSubmoduleWorktrees")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let repo = open_repository(root_path)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(recurse)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .exclude_submodules(skip_submodule_worktrees)
        // A read must not rewrite .git/index: the index watcher would start
        // another full reconciliation for this very status request.
        .update_index(false);
    for path in &paths {
        options.pathspec(path);
    }
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(format_git_error)?;
    // Reuse one index for every worktree comparison instead of reopening and
    // parsing the entire index once per modified file.
    let index = repo.index().map_err(format_git_error)?;
    let mut staged = Vec::new();
    let mut changes = Vec::new();
    for entry in statuses.iter() {
        let flags = entry.status();
        if flags.contains(Status::CONFLICTED) {
            continue;
        }
        if flags.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) && let Some(delta) = entry.head_to_index()
        {
            staged.push(file_from_delta(delta, false, false));
        }
        if flags.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            // Staged + a stale index stat can also report WT_MODIFIED; compare
            // content regardless of the accompanying INDEX_* flags.
            if flags.contains(Status::WT_MODIFIED)
                && !flags.intersects(
                    Status::WT_NEW
                        | Status::WT_DELETED
                        | Status::WT_RENAMED
                        | Status::WT_TYPECHANGE,
                )
                && entry.path().ok().is_some_and(|path| {
                    worktree_matches_index(&repo, &index, std::path::Path::new(path))
                })
            {
                continue;
            }
            if let Some(delta) = entry.index_to_workdir() {
                changes.push(file_from_delta(
                    delta,
                    false,
                    flags.contains(Status::WT_NEW),
                ));
            }
        }
    }
    let mut conflicts = BTreeMap::new();
    if let Ok(iter) = index.conflicts() {
        for conflict in iter.flatten() {
            let chosen = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .or(conflict.ancestor.as_ref());
            let Some(chosen) = chosen else {
                continue;
            };
            let path = String::from_utf8_lossy(&chosen.path).into_owned();
            if !paths.is_empty()
                && !paths
                    .iter()
                    .any(|selected| path == *selected || path.starts_with(&format!("{selected}/")))
            {
                continue;
            }
            conflicts.insert(path, conflict);
        }
    }
    // libgit2 can report the checked-out directory behind a conflicted Gitlink
    // as an additional untracked directory (for example `module/`). The
    // conflict entry is the authoritative parent-repository record; publishing
    // the directory duplicate makes the UI try to read a directory as a file.
    let conflicted_gitlink_paths: BTreeSet<String> = conflicts
        .iter()
        .filter_map(|(path, conflict)| {
            let is_gitlink = conflict
                .ancestor
                .as_ref()
                .or(conflict.our.as_ref())
                .or(conflict.their.as_ref())
                .is_some_and(|entry| index_mode_text(entry.mode) == "160000");
            is_gitlink.then(|| path.clone())
        })
        .collect();
    let is_gitlink_directory_duplicate = |value: &Value| {
        value
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|candidate| {
                conflicted_gitlink_paths
                    .iter()
                    .any(|path| candidate == format!("{path}/"))
            })
    };
    staged.retain(|value| !is_gitlink_directory_duplicate(value));
    changes.retain(|value| !is_gitlink_directory_duplicate(value));

    for (path, conflict) in conflicts {
        let (_, base_id, base_mode) = conflict
            .ancestor
            .as_ref()
            .map(conflict_entry)
            .unwrap_or_else(|| (path.clone(), zero_oid(40), "000000".to_owned()));
        let (_, ours_id, ours_mode) = conflict
            .our
            .as_ref()
            .map(conflict_entry)
            .unwrap_or_else(|| (path.clone(), zero_oid(40), "000000".to_owned()));
        let (_, incoming_id, incoming_mode) = conflict
            .their
            .as_ref()
            .map(conflict_entry)
            .unwrap_or_else(|| (path.clone(), zero_oid(40), "000000".to_owned()));
        let is_gitlink =
            base_mode == "160000" || ours_mode == "160000" || incoming_mode == "160000";
        staged.push(json!({
            "path": path,
            "status": "U",
            "oldObjectId": base_id,
            "newObjectId": ours_id,
            "oldMode": base_mode,
            "newMode": ours_mode,
            "gitlinkConflictBaseObjectId": base_id,
            "gitlinkConflictCurrentObjectId": ours_id,
            "gitlinkConflictIncomingObjectId": incoming_id,
            "isGitlink": is_gitlink,
            "isConflict": true,
        }));
        changes.push(json!({
            "path": path,
            "status": "U",
            "oldObjectId": ours_id,
            "newObjectId": zero_oid(ours_id.len()),
            "oldMode": ours_mode,
            "newMode": ours_mode,
            "gitlinkConflictBaseObjectId": base_id,
            "gitlinkConflictCurrentObjectId": ours_id,
            "gitlinkConflictIncomingObjectId": incoming_id,
            "isGitlink": is_gitlink,
            "isConflict": true,
        }));
    }
    let has_gitlink_result = staged.iter().chain(&changes).any(|file| {
        file.get("isGitlink")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let targets_gitlink = paths.iter().any(|path| {
        index
            .get_path(std::path::Path::new(path), 0)
            .is_some_and(|entry| index_mode_text(entry.mode) == "160000")
    });
    if skip_submodule_worktrees && (paths.is_empty() || has_gitlink_result || targets_gitlink) {
        append_submodule_pointer_changes(&repo, &paths, &mut staged, &mut changes)?;
    }
    let by_path = |left: &Value, right: &Value| {
        left.get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    };
    staged.sort_by(by_path);
    changes.sort_by(by_path);
    Ok(json!({ "staged": staged, "changes": changes }))
}

pub fn has_changes(payload: &Value) -> NativeResult<Value> {
    let value = status(payload)?;
    let staged = value
        .get("staged")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let changes = value
        .get("changes")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    Ok(Value::Bool(staged || changes))
}
