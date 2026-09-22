use crate::support::{NativeResult, format_git_error, open_repository, string_arg};
use git2::{
    BranchType, MergeAnalysis, ObjectType, Oid, Repository, ResetType, build::CheckoutBuilder,
};
use serde_json::{Value, json};

fn signature(repo: &Repository) -> NativeResult<git2::Signature<'static>> {
    repo.signature().map_err(format_git_error)
}

fn resolve_commit<'repo>(
    repo: &'repo Repository,
    revision: &str,
) -> NativeResult<git2::Commit<'repo>> {
    repo.revparse_single(revision)
        .map_err(format_git_error)?
        .peel_to_commit()
        .map_err(format_git_error)
}

fn changed_tree_paths(
    repo: &Repository,
    before: Option<&git2::Tree<'_>>,
    after: &git2::Tree<'_>,
) -> NativeResult<Vec<String>> {
    let diff = repo
        .diff_tree_to_tree(before, Some(after), None)
        .map_err(format_git_error)?;
    let mut paths = std::collections::BTreeSet::new();
    for delta in diff.deltas() {
        if let Some(path) = delta.old_file().path() {
            paths.insert(path.to_string_lossy().replace('\\', "/"));
        }
        if let Some(path) = delta.new_file().path() {
            paths.insert(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(paths.into_iter().collect())
}

fn ensure_no_conflicts(repo: &Repository) -> NativeResult<()> {
    let index = repo.index().map_err(format_git_error)?;
    if index.has_conflicts() {
        Err("操作产生合并冲突，请先解决冲突".to_owned())
    } else {
        Ok(())
    }
}

fn create_index_commit(
    repo: &Repository,
    message: &str,
    author: Option<&git2::Signature<'_>>,
    extra_parents: &[Oid],
) -> NativeResult<Oid> {
    let current_id = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.id());
    let message = crate::hooks::prepare_commit_message(repo, message, false, current_id)?;
    let mut index = repo.index().map_err(format_git_error)?;
    if index.has_conflicts() {
        return Err("Index 中仍有未解决冲突".to_owned());
    }
    let tree_id = index.write_tree().map_err(format_git_error)?;
    let tree = repo.find_tree(tree_id).map_err(format_git_error)?;
    let committer = signature(repo)?;
    let author = author
        .map(git2::Signature::to_owned)
        .unwrap_or_else(|| committer.clone());
    let mut parent_ids = current_id.into_iter().collect::<Vec<_>>();
    for id in extra_parents {
        if !parent_ids.contains(id) {
            parent_ids.push(*id);
        }
    }
    let parents = parent_ids
        .iter()
        .map(|id| repo.find_commit(*id).map_err(format_git_error))
        .collect::<NativeResult<Vec<_>>>()?;
    let parent_refs = parents.iter().collect::<Vec<_>>();
    let content = repo
        .commit_create_buffer(&author, &committer, &message, &tree, &parent_refs)
        .map_err(format_git_error)?;
    let content_text = std::str::from_utf8(&content).map_err(|error| error.to_string())?;
    let oid = if let Some(signature) = crate::signing::sign_commit(repo, content_text)? {
        let oid = repo
            .commit_signed(content_text, &signature, None)
            .map_err(format_git_error)?;
        crate::hooks::update_head(repo, oid, "commit")?;
        oid
    } else {
        repo.commit(
            Some("HEAD"),
            &author,
            &committer,
            &message,
            &tree,
            &parent_refs,
        )
        .map_err(format_git_error)?
    };
    crate::hooks::post_commit(repo, false, current_id, oid)?;
    Ok(oid)
}

pub fn commit(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let requested_message = string_arg(payload, "message")?;
    let amend = payload
        .get("amend")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut repo = open_repository(root_path)?;
    let (old_head_id, old_parent_ids, old_author) =
        match repo.head().ok().and_then(|head| head.peel_to_commit().ok()) {
            Some(commit) => (
                Some(commit.id()),
                commit.parent_ids().collect::<Vec<_>>(),
                Some(commit.author().to_owned()),
            ),
            None => (None, Vec::new(), None),
        };
    if amend && old_head_id.is_none() {
        return Err("无法 amend：当前仓库没有提交".to_owned());
    }
    let message =
        crate::hooks::prepare_commit_message(&repo, requested_message, amend, old_head_id)?;

    let mut parent_ids = if amend {
        old_parent_ids
    } else {
        old_head_id.into_iter().collect::<Vec<_>>()
    };
    if !amend {
        let _ = repo.mergehead_foreach(|id| {
            if !parent_ids.contains(id) {
                parent_ids.push(*id);
            }
            true
        });
    }
    let mut index = repo.index().map_err(format_git_error)?;
    if index.has_conflicts() {
        return Err("无法提交：仍有未解决冲突".to_owned());
    }
    let tree_id = index.write_tree().map_err(format_git_error)?;
    let tree = repo.find_tree(tree_id).map_err(format_git_error)?;
    let committer = signature(&repo)?;
    let author = if amend {
        old_author.unwrap_or_else(|| committer.clone())
    } else {
        committer.clone()
    };
    let parents = parent_ids
        .iter()
        .map(|id| repo.find_commit(*id).map_err(format_git_error))
        .collect::<NativeResult<Vec<_>>>()?;
    let parent_refs = parents.iter().collect::<Vec<_>>();
    let content = repo
        .commit_create_buffer(&author, &committer, &message, &tree, &parent_refs)
        .map_err(format_git_error)?;
    let content_text = std::str::from_utf8(&content).map_err(|error| error.to_string())?;
    let oid = if let Some(signature) = crate::signing::sign_commit(&repo, content_text)? {
        let oid = repo
            .commit_signed(content_text, &signature, None)
            .map_err(format_git_error)?;
        crate::hooks::update_head(&repo, oid, if amend { "commit (amend)" } else { "commit" })?;
        oid
    } else {
        // An amended commit has the old commit's parents, not the current tip.
        // libgit2 rejects commit(Some("HEAD")) in that case; write the object
        // first and move HEAD explicitly, as on the signed-commit path.
        let oid = repo
            .commit(
                if amend { None } else { Some("HEAD") },
                &author,
                &committer,
                &message,
                &tree,
                &parent_refs,
            )
            .map_err(format_git_error)?;
        if amend {
            crate::hooks::update_head(&repo, oid, "commit (amend)")?;
        }
        oid
    };
    let _ = repo.cleanup_state();
    crate::hooks::post_commit(&repo, amend, old_head_id, oid)?;
    Ok(Value::String(oid.to_string()))
}

pub fn create_branch(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let name = string_arg(payload, "name")?;
    let commit = resolve_commit(&repo, string_arg(payload, "revision")?)?;
    repo.branch(name, &commit, false)
        .map_err(format_git_error)?;
    Ok(Value::Null)
}

pub fn create_tag(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let name = string_arg(payload, "name")?;
    let revision = string_arg(payload, "revision")?;
    let message = string_arg(payload, "message")?;
    let object = repo.revparse_single(revision).map_err(format_git_error)?;
    let tagger = signature(&repo)?;
    let oid = repo
        .tag(name, &object, &tagger, message, false)
        .map_err(format_git_error)?;
    Ok(Value::String(oid.to_string()))
}

pub fn checkout(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let revision = string_arg(payload, "revision")?;
    let detach = payload
        .get("detach")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let old_id = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.id())
        .unwrap_or(git2::Oid::ZERO_SHA1);
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let (reference_name, object, branch_checkout) = if !detach {
        if let Ok(branch) = repo.find_branch(revision, BranchType::Local) {
            let reference_name = branch
                .get()
                .name()
                .ok()
                .ok_or_else(|| "分支引用无效".to_owned())?
                .to_owned();
            let object = branch
                .get()
                .peel(ObjectType::Commit)
                .map_err(format_git_error)?;
            (Some(reference_name), object, true)
        } else {
            let object = repo
                .revparse_single(revision)
                .map_err(format_git_error)?
                .peel(ObjectType::Commit)
                .map_err(format_git_error)?;
            (None, object, false)
        }
    } else {
        let object = repo
            .revparse_single(revision)
            .map_err(format_git_error)?
            .peel(ObjectType::Commit)
            .map_err(format_git_error)?;
        (None, object, false)
    };
    let after_tree = object.peel_to_tree().map_err(format_git_error)?;
    let changed_paths = changed_tree_paths(&repo, before_tree.as_ref(), &after_tree)?;
    let new_id = object.id();
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().recreate_missing(true);
    repo.checkout_tree(&object, Some(&mut checkout))
        .map_err(format_git_error)?;
    if let Some(reference_name) = reference_name {
        repo.set_head(&reference_name).map_err(format_git_error)?;
    } else {
        repo.set_head_detached(new_id).map_err(format_git_error)?;
    }
    crate::filters::apply_smudge_filters(&repo, &changed_paths)?;
    crate::hooks::run_hook(
        &repo,
        "post-checkout",
        &[
            old_id.to_string(),
            new_id.to_string(),
            if branch_checkout { "1" } else { "0" }.to_owned(),
        ],
        &[],
    )?;
    Ok(Value::Null)
}

pub fn reset(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let target = repo
        .revparse_single(string_arg(payload, "revision")?)
        .map_err(format_git_error)?;
    let after_tree = target.peel_to_tree().map_err(format_git_error)?;
    let changed_paths = changed_tree_paths(&repo, before_tree.as_ref(), &after_tree)?;
    let mode = match string_arg(payload, "mode")?.to_ascii_lowercase().as_str() {
        "soft" => ResetType::Soft,
        "hard" => ResetType::Hard,
        _ => ResetType::Mixed,
    };
    let mut checkout = CheckoutBuilder::new();
    checkout.force().recreate_missing(true);
    repo.reset(
        &target,
        mode,
        if mode == ResetType::Hard {
            Some(&mut checkout)
        } else {
            None
        },
    )
    .map_err(format_git_error)?;
    if mode == ResetType::Hard {
        crate::filters::apply_smudge_filters(&repo, &changed_paths)?;
    }
    Ok(Value::Null)
}

pub fn merge(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let other = resolve_commit(&repo, string_arg(payload, "revision")?)?;
    let annotated = repo
        .find_annotated_commit(other.id())
        .map_err(format_git_error)?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(format_git_error)?;
    if analysis.contains(MergeAnalysis::ANALYSIS_UP_TO_DATE) {
        return Ok(json!({ "changed": false }));
    }
    let after_tree = other.tree().map_err(format_git_error)?;
    let changed_paths = changed_tree_paths(&repo, before_tree.as_ref(), &after_tree)?;
    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) {
        // Preflight the worktree before advancing the branch, like a normal
        // non-forced Git merge. Never discard edits to a changed path.
        let mut checkout = CheckoutBuilder::new();
        checkout.safe().recreate_missing(true);
        repo.checkout_tree(other.as_object(), Some(&mut checkout))
            .map_err(format_git_error)?;
        let mut head = repo.head().map_err(format_git_error)?;
        head.set_target(other.id(), "libgit2 fast-forward merge")
            .map_err(format_git_error)?;
        crate::filters::apply_smudge_filters(&repo, &changed_paths)?;
        crate::hooks::run_hook(&repo, "post-merge", &["0".to_owned()], &[])?;
        return Ok(json!({ "changed": true, "fastForward": true }));
    }
    crate::hooks::run_hook(&repo, "pre-merge-commit", &[], &[])?;
    let mut checkout = CheckoutBuilder::new();
    checkout
        .safe()
        .allow_conflicts(true)
        .conflict_style_merge(true);
    repo.merge(&[&annotated], None, Some(&mut checkout))
        .map_err(format_git_error)?;
    ensure_no_conflicts(&repo)?;
    let oid = create_index_commit(
        &repo,
        &format!("Merge commit '{}'", other.id()),
        None,
        &[other.id()],
    )?;
    repo.cleanup_state().map_err(format_git_error)?;
    crate::filters::apply_smudge_filters(&repo, &changed_paths)?;
    crate::hooks::run_hook(&repo, "post-merge", &["0".to_owned()], &[])?;
    Ok(json!({ "changed": true, "commit": oid.to_string() }))
}

pub fn cherry_pick(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let picked = resolve_commit(&repo, string_arg(payload, "revision")?)?;
    repo.cherrypick(&picked, None).map_err(format_git_error)?;
    ensure_no_conflicts(&repo)?;
    let message = String::from_utf8_lossy(picked.message_bytes()).into_owned();
    let author = picked.author();
    let oid = create_index_commit(&repo, &message, Some(&author), &[])?;
    repo.cleanup_state().map_err(format_git_error)?;
    let after_tree = repo
        .find_commit(oid)
        .map_err(format_git_error)?
        .tree()
        .map_err(format_git_error)?;
    crate::filters::apply_smudge_filters(
        &repo,
        &changed_tree_paths(&repo, before_tree.as_ref(), &after_tree)?,
    )?;
    Ok(Value::String(oid.to_string()))
}

pub fn revert(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let reverted = resolve_commit(&repo, string_arg(payload, "revision")?)?;
    repo.revert(&reverted, None).map_err(format_git_error)?;
    ensure_no_conflicts(&repo)?;
    let subject = reverted.summary().ok().flatten().unwrap_or_default();
    let message = format!(
        "Revert \"{subject}\"\n\nThis reverts commit {}.\n",
        reverted.id()
    );
    let oid = create_index_commit(&repo, &message, None, &[])?;
    repo.cleanup_state().map_err(format_git_error)?;
    let after_tree = repo
        .find_commit(oid)
        .map_err(format_git_error)?
        .tree()
        .map_err(format_git_error)?;
    crate::filters::apply_smudge_filters(
        &repo,
        &changed_tree_paths(&repo, before_tree.as_ref(), &after_tree)?,
    )?;
    Ok(Value::String(oid.to_string()))
}

pub fn rebase(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let revision = string_arg(payload, "revision")?;
    crate::hooks::run_hook(&repo, "pre-rebase", &[revision.to_owned()], &[])?;
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let upstream_commit = resolve_commit(&repo, revision)?;
    let upstream = repo
        .find_annotated_commit(upstream_commit.id())
        .map_err(format_git_error)?;
    let mut rebase = repo
        .rebase(None, Some(&upstream), None, None)
        .map_err(format_git_error)?;
    let committer = signature(&repo)?;
    let mut rewritten = String::new();
    while let Some(operation) = rebase.next() {
        let operation = operation.map_err(format_git_error)?;
        let index = repo.index().map_err(format_git_error)?;
        if index.has_conflicts() {
            return Err("Rebase 产生冲突，请先解决冲突".to_owned());
        }
        let new_id = rebase
            .commit(None, &committer, None)
            .map_err(format_git_error)?;
        rewritten.push_str(&format!("{} {}\n", operation.id(), new_id));
    }
    rebase.finish(Some(&committer)).map_err(format_git_error)?;
    if !rewritten.is_empty() {
        crate::hooks::run_hook(
            &repo,
            "post-rewrite",
            &["rebase".to_owned()],
            rewritten.as_bytes(),
        )?;
    }
    if let Ok(after_tree) = repo.head().and_then(|head| head.peel_to_tree()) {
        crate::filters::apply_smudge_filters(
            &repo,
            &changed_tree_paths(&repo, before_tree.as_ref(), &after_tree)?,
        )?;
    }
    Ok(Value::Null)
}
