mod conflicts;
mod filters;
mod history;
mod hooks;
mod mutations;
mod objects;
mod operations;
mod remote;
mod repository;
mod signing;
mod stash;
mod status;
mod submodule;
mod support;

use napi::{
    Env, Error, Result, Task,
    bindgen_prelude::{AsyncTask, spawn_blocking},
};
use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex, RwLock};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
struct MutationState {
    generation: u64,
    pending: usize,
}

#[derive(Default)]
struct RepositoryState {
    lock: RwLock<()>,
    mutation: Mutex<MutationState>,
    mutation_finished: Condvar,
}

impl RepositoryState {
    fn stable_generation(&self) -> u64 {
        let mut mutation = self.mutation.lock();
        while mutation.pending > 0 {
            self.mutation_finished.wait(&mut mutation);
        }
        mutation.generation
    }

    fn is_generation_current(&self, generation: u64) -> bool {
        let mutation = self.mutation.lock();
        mutation.pending == 0 && mutation.generation == generation
    }
}

struct MutationIntent {
    state: Arc<RepositoryState>,
}

impl MutationIntent {
    fn new(state: Arc<RepositoryState>) -> Self {
        {
            let mut mutation = state.mutation.lock();
            mutation.pending += 1;
            mutation.generation = mutation.generation.wrapping_add(1);
        }
        Self { state }
    }
}

impl Drop for MutationIntent {
    fn drop(&mut self) {
        let mut mutation = self.state.mutation.lock();
        mutation.generation = mutation.generation.wrapping_add(1);
        mutation.pending -= 1;
        if mutation.pending == 0 {
            self.state.mutation_finished.notify_all();
        }
    }
}

static REPOSITORY_STATES: Lazy<Mutex<HashMap<String, Arc<RepositoryState>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn repository_state(payload: &Value) -> Option<Arc<RepositoryState>> {
    let path = payload
        .get("rootPath")
        .or_else(|| payload.get("path"))
        .and_then(Value::as_str)?;
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_owned();
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();
    Some(
        REPOSITORY_STATES
            .lock()
            .entry(normalized)
            .or_insert_with(|| Arc::new(RepositoryState::default()))
            .clone(),
    )
}

fn is_mutating_operation(operation: &str) -> bool {
    matches!(
        operation,
        "stage"
            | "saveMergeResult"
            | "stageAll"
            | "setRemoteOperation"
            | "addRemote"
            | "removeRemote"
            | "clearRemoteOperations"
            | "deleteTag"
            | "checkoutRemoteBranch"
            | "unstage"
            | "restoreWorktree"
            | "restoreAll"
            | "stashCreate"
            | "stashApply"
            | "stashRestorePaths"
            | "stashPop"
            | "stashDrop"
            | "commit"
            | "createBranch"
            | "createTag"
            | "checkout"
            | "reset"
            | "merge"
            | "cherryPick"
            | "revert"
            | "rebase"
            | "fetch"
            | "push"
            | "pull"
            | "checkoutBranch"
            | "updateSubmodules"
            | "restoreSubmodule"
            | "indexGitlink"
    )
}

fn dispatch_operation(operation: &str, payload: &Value) -> std::result::Result<Value, String> {
    match operation {
        "discover" => repository::discover(payload),
        "configGet" => repository::config_get(payload),
        "setRemoteOperation" => repository::set_remote_operation(payload),
        "addRemote" => repository::add_remote(payload),
        "removeRemote" => repository::remove_remote(payload),
        "clearRemoteOperations" => repository::clear_remote_operations(payload),
        "explicitProxyConfigured" => repository::explicit_proxy_configured(payload),
        "tagTargets" => repository::tag_targets(payload),
        "deleteTag" => operations::delete_tag(payload),
        "checkoutRemoteBranch" => operations::checkout_remote_branch(payload),
        "remoteState" => repository::remote_state(payload),
        "submoduleTopology" => repository::submodule_topology(payload),
        "remoteBranchesContainingHead" => repository::remote_branches_containing_head(payload),
        "submodules" => repository::submodules(payload),
        "readObjects" => objects::read_objects(payload),
        "readMergeConflict" => conflicts::read(payload),
        "saveMergeResult" => conflicts::save(payload),
        "resolveRevision" => objects::resolve_revision(payload),
        "status" => status::status(payload),
        "hasChanges" => status::has_changes(payload),
        "branches" => history::branches(payload),
        "head" => history::head(payload),
        "commits" => history::commits(payload),
        "commitFiles" => history::commit_files(payload),
        "gitlinkPaths" => history::gitlink_paths(payload),
        "aheadBehind" => history::ahead_behind(payload),
        "commitDetails" => history::commit_details(payload),
        "rangeCommits" => history::range_commits(payload),
        "repositoryState" => history::repository_state(payload),
        "changedPaths" => history::changed_paths(payload),
        "gitlinkChanges" => history::gitlink_changes(payload),
        "pushBranches" => history::push_branches(payload),
        "stage" => mutations::stage(payload),
        "stageAll" => mutations::stage_all(payload),
        "unstage" => mutations::unstage(payload),
        "restoreWorktree" => mutations::restore_worktree(payload),
        "restoreAll" => mutations::restore_all(payload),
        "stashCreate" => stash::create(payload),
        "stashApply" => stash::apply(payload),
        "stashRestorePaths" => stash::restore_paths(payload),
        "stashPop" => stash::pop(payload),
        "stashDrop" => stash::drop_stash(payload),
        "stashList" => stash::list(payload),
        "stashFiles" => stash::files(payload),
        "trackedPaths" => mutations::tracked_paths(payload),
        "indexChangedPaths" => mutations::index_changed_paths(payload),
        "hasConflicts" => mutations::has_conflicts(payload),
        "commit" => operations::commit(payload),
        "createBranch" => operations::create_branch(payload),
        "createTag" => operations::create_tag(payload),
        "checkout" => operations::checkout(payload),
        "reset" => operations::reset(payload),
        "merge" => operations::merge(payload),
        "cherryPick" => operations::cherry_pick(payload),
        "revert" => operations::revert(payload),
        "rebase" => operations::rebase(payload),
        "fetch" => remote::fetch(payload),
        "push" => remote::push(payload),
        "pull" => remote::pull(payload),
        "checkoutBranch" => remote::checkout_branch(payload),
        "updateSubmodules" => submodule::update(payload),
        "restoreSubmodule" => submodule::restore(payload),
        "indexGitlink" => submodule::index_gitlink(payload),
        operation => Err(format!("不支持的 libgit2 操作: {operation}")),
    }
}

fn is_optimistic_snapshot(operation: &str) -> bool {
    matches!(operation, "status" | "hasChanges")
}

fn optimistic_snapshot<T, E>(
    state: &RepositoryState,
    mut read: impl FnMut() -> std::result::Result<T, E>,
) -> std::result::Result<T, E> {
    loop {
        let generation = state.stable_generation();
        let result = read();
        if state.is_generation_current(generation) {
            return result;
        }
    }
}

fn execute_parsed_operation(
    operation: &str,
    payload: &Value,
    state: Option<Arc<RepositoryState>>,
    mutation_announced: bool,
) -> Result<String> {
    let result = if let Some(state) = state {
        if is_mutating_operation(operation) {
            let _intent = (!mutation_announced).then(|| MutationIntent::new(state.clone()));
            let _guard = state.lock.write();
            dispatch_operation(operation, payload)
        } else if is_optimistic_snapshot(operation) {
            // Status can be expensive on large worktrees. Do not make a user
            // mutation wait for an already-running snapshot: if a mutation
            // overlaps the read, discard that snapshot and retry afterwards.
            optimistic_snapshot(&state, || dispatch_operation(operation, payload))
        } else {
            let _guard = state.lock.read();
            dispatch_operation(operation, payload)
        }
    } else {
        dispatch_operation(operation, payload)
    }
    .map_err(Error::from_reason)?;
    serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
}

fn execute_operation(operation: &str, payload_text: &str) -> Result<String> {
    let payload: Value = serde_json::from_str(payload_text)
        .map_err(|error| Error::from_reason(format!("参数 JSON 无效: {error}")))?;
    let state = repository_state(&payload);
    execute_parsed_operation(operation, &payload, state, false)
}

pub struct InvokeTask {
    operation: String,
    payload: String,
}

impl Task for InvokeTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        execute_operation(&self.operation, &self.payload)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn invoke(operation: String, payload: String) -> AsyncTask<InvokeTask> {
    AsyncTask::new(InvokeTask { operation, payload })
}

#[napi]
pub async fn invoke_mutation(operation: String, payload: String) -> Result<String> {
    if !is_mutating_operation(&operation) {
        return Err(Error::from_reason(format!(
            "invokeMutation 只允许修改操作: {operation}"
        )));
    }
    let payload: Value = serde_json::from_str(&payload)
        .map_err(|error| Error::from_reason(format!("参数 JSON 无效: {error}")))?;
    let state = repository_state(&payload);
    let intent = state.clone().map(MutationIntent::new);
    spawn_blocking(move || {
        let _intent = intent;
        execute_parsed_operation(&operation, &payload, state, true)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Native Git 修改线程异常: {error}")))?
}

#[napi]
pub async fn invoke_priority_read(operation: String, payload: String) -> Result<String> {
    if is_mutating_operation(&operation) {
        return Err(Error::from_reason(format!(
            "invokePriorityRead 只允许读取操作: {operation}"
        )));
    }
    spawn_blocking(move || execute_operation(&operation, &payload))
        .await
        .map_err(|error| Error::from_reason(format!("Native Git 优先读取线程异常: {error}")))?
}

#[napi]
pub fn libgit2_version() -> String {
    let (major, minor, patch) = git2::Version::get().libgit2_version();
    format!("{major}.{minor}.{patch}")
}

#[napi]
pub fn binding_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use serde_json::json;
    use std::fs;

    fn fixture() -> (tempfile::TempDir, Repository) {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Gitk Test").unwrap();
        config.set_str("user.email", "gitk@example.com").unwrap();
        drop(config);
        (directory, repo)
    }

    #[test]
    fn stage_commit_and_read_multiline_message() {
        let (directory, _repo) = fixture();
        fs::write(directory.path().join("file.txt"), "first\r\nsecond\r\n").unwrap();
        let root = directory.path().to_string_lossy();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        let oid = operations::commit(&json!({
            "rootPath": root,
            "message": "subject\n\nbody line 1\nbody line 2",
            "amend": false
        }))
        .unwrap();
        let values =
            history::commit_details(&json!({ "rootPath": root, "hashes": [oid] })).unwrap();
        assert_eq!(values[0]["message"], "subject\n\nbody line 1\nbody line 2");
        assert_eq!(
            status::has_changes(&json!({ "rootPath": root })).unwrap(),
            Value::Bool(false)
        );
    }

    #[test]
    fn stage_unstage_and_partial_edits_keep_separate_sections() {
        let (directory, repo) = fixture();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "true")
            .unwrap();
        let root = directory.path().to_string_lossy();
        let file = directory.path().join("file.txt");
        fs::write(&file, "initial\r\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        fs::write(&file, "staged\r\n").unwrap();
        mutations::stage(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 0);

        // The index and worktree really differ only after another edit.
        fs::write(&file, "unstaged\r\n").unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);

        mutations::unstage(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn discard_only_unstaged_half_of_the_same_file() {
        let (directory, repo) = fixture();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "true")
            .unwrap();
        let root = directory.path().to_string_lossy();
        let file = directory.path().join("file.txt");
        fs::write(&file, "original\r\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        fs::write(&file, "staged\r\n").unwrap();
        mutations::stage(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        fs::write(&file, "unstaged\r\n").unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);

        mutations::restore_worktree(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 0);
        assert_eq!(
            fs::read_to_string(&file).unwrap().replace("\r\n", "\n"),
            "staged\n"
        );
    }

    #[test]
    fn multi_file_stage_unstage_and_restore_update_the_right_lists() {
        let (directory, _repo) = fixture();
        let root = directory.path().to_string_lossy();
        for name in ["one.txt", "two.txt"] {
            fs::write(directory.path().join(name), "initial\n").unwrap();
        }
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        for name in ["one.txt", "two.txt", "new.txt"] {
            fs::write(directory.path().join(name), "changed\n").unwrap();
        }
        let before = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(
            before["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|file| file["path"] == "new.txt")
                .unwrap()["isUntracked"],
            true
        );
        mutations::stage(&json!({ "rootPath": root, "paths": ["one.txt", "new.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);

        mutations::unstage(&json!({ "rootPath": root, "paths": ["one.txt", "new.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 3);
        assert_eq!(
            snapshot["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|file| file["path"] == "new.txt")
                .unwrap()["isUntracked"],
            true
        );

        mutations::restore_worktree(&json!({ "rootPath": root, "paths": ["one.txt", "two.txt"] }))
            .unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"][0]["path"], "new.txt");
    }

    #[test]
    fn status_read_does_not_rewrite_index() {
        let (directory, repo) = fixture();
        let root = directory.path().to_string_lossy();
        fs::write(directory.path().join("file.txt"), "first\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        fs::write(directory.path().join("file.txt"), "second\n").unwrap();
        let index = repo.path().join("index");
        let before = fs::read(&index).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(index).unwrap(), before);
    }

    #[test]
    fn branch_checkout_and_revert_work_without_git_cli() {
        let (directory, _repo) = fixture();
        let root = directory.path().to_string_lossy();
        fs::write(directory.path().join("file.txt"), "one\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        let first =
            operations::commit(&json!({ "rootPath": root, "message": "first", "amend": false }))
                .unwrap();
        fs::write(directory.path().join("file.txt"), "two\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        let second =
            operations::commit(&json!({ "rootPath": root, "message": "second", "amend": false }))
                .unwrap();
        operations::create_branch(&json!({ "rootPath": root, "name": "topic", "revision": first }))
            .unwrap();
        operations::checkout(&json!({ "rootPath": root, "revision": "topic", "detach": false }))
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "one\n"
        );
        operations::checkout(&json!({ "rootPath": root, "revision": second, "detach": true }))
            .unwrap();
        operations::revert(&json!({ "rootPath": root, "revision": second })).unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "one\n"
        );
    }
}
#[cfg(test)]
mod compat_tests;
#[cfg(test)]
mod eol_tests;
