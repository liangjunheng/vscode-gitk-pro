use crate::filters::worktree_matches_index;
use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use git2::{Delta, DiffDelta, FileMode, IndexEntry, Status, StatusOptions};
use serde_json::{Value, json};
use std::collections::BTreeMap;

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

pub fn status(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    let recurse = payload
        .get("recurseUntrackedDirs")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let repo = open_repository(root_path)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(recurse)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .exclude_submodules(false)
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
        staged.push(json!({
            "path": path,
            "status": "U",
            "oldObjectId": base_id,
            "newObjectId": ours_id,
            "oldMode": base_mode,
            "newMode": ours_mode,
            "isGitlink": base_mode == "160000" || ours_mode == "160000",
            "isConflict": true,
        }));
        changes.push(json!({
            "path": path,
            "status": "U",
            "oldObjectId": ours_id,
            "newObjectId": zero_oid(ours_id.len()),
            "oldMode": ours_mode,
            "newMode": ours_mode,
            "isGitlink": ours_mode == "160000",
            "isConflict": true,
        }));
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
