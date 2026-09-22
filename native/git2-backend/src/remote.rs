use crate::support::{NativeResult, format_git_error, open_repository, string_arg};
use git2::{
    BranchType, Cred, CredentialType, FetchOptions, FetchPrune, MergeAnalysis, ProxyOptions,
    PushOptions, RemoteCallbacks, Repository, build::CheckoutBuilder,
};
use serde_json::{Value, json};
use std::path::PathBuf;

fn callbacks<'a>(repo: &'a Repository) -> NativeResult<RemoteCallbacks<'a>> {
    let config = repo.config().map_err(format_git_error)?;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, username, allowed| {
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT)
            && let Ok(cred) = Cred::credential_helper(&config, url, username)
        {
            return Ok(cred);
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            let user = username.unwrap_or("git");
            if let Ok(cred) = Cred::ssh_key_from_agent(user) {
                return Ok(cred);
            }
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from);
            if let Some(home) = home {
                for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                    let private_key = home.join(".ssh").join(name);
                    if private_key.is_file() {
                        let public_key =
                            PathBuf::from(format!("{}.pub", private_key.to_string_lossy()));
                        if let Ok(cred) = Cred::ssh_key(
                            user,
                            public_key.is_file().then_some(public_key.as_path()),
                            &private_key,
                            None,
                        ) {
                            return Ok(cred);
                        }
                    }
                }
            }
        }
        if allowed.contains(CredentialType::USERNAME) {
            return Cred::username(username.unwrap_or("git"));
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str(
            "无法从 credential.helper、SSH agent 或系统凭据获取认证信息",
        ))
    });
    callbacks.push_update_reference(|reference, status| {
        if let Some(status) = status {
            Err(git2::Error::from_str(&format!(
                "推送 {reference} 失败: {status}"
            )))
        } else {
            Ok(())
        }
    });
    Ok(callbacks)
}

pub(crate) fn fetch_options<'a>(
    repo: &'a Repository,
    prune: bool,
) -> NativeResult<FetchOptions<'a>> {
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(repo)?);
    let mut proxy = ProxyOptions::new();
    proxy.auto();
    options.proxy_options(proxy);
    if prune {
        options.prune(FetchPrune::On);
    }
    Ok(options)
}

fn fetch_one(repo: &Repository, remote_name: &str, prune: bool) -> NativeResult<()> {
    let mut remote = repo.find_remote(remote_name).map_err(format_git_error)?;
    let mut options = fetch_options(repo, prune)?;
    remote
        .fetch(&[] as &[&str], Some(&mut options), Some("libgit2 fetch"))
        .map_err(format_git_error)
}

fn current_branch(repo: &Repository) -> NativeResult<String> {
    let head = repo.head().map_err(format_git_error)?;
    if !head.is_branch() {
        return Err("当前 HEAD 处于分离状态".to_owned());
    }
    head.shorthand()
        .ok()
        .map(str::to_owned)
        .ok_or_else(|| "无法读取当前分支".to_owned())
}

fn configured_remote(repo: &Repository, branch: &str) -> String {
    repo.config()
        .ok()
        .and_then(|config| config.get_string(&format!("branch.{branch}.remote")).ok())
        .filter(|value| value != ".")
        .unwrap_or_else(|| "origin".to_owned())
}

fn configured_upstream_branch(repo: &Repository, branch: &str) -> String {
    repo.config()
        .ok()
        .and_then(|config| config.get_string(&format!("branch.{branch}.merge")).ok())
        .and_then(|value| value.strip_prefix("refs/heads/").map(str::to_owned))
        .unwrap_or_else(|| branch.to_owned())
}

pub fn fetch(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let prune = payload
        .get("prune")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if let Some(remote) = payload.get("remote").and_then(Value::as_str) {
        fetch_one(&repo, remote, prune)?;
    } else {
        let remotes = repo.remotes().map_err(format_git_error)?;
        for name in remotes.iter() {
            if let Ok(Some(remote)) = name {
                fetch_one(&repo, remote, prune)?;
            }
        }
    }
    Ok(Value::Null)
}

pub fn push(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let local_branch = payload
        .get("localBranch")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or(current_branch(&repo)?);
    let remote_name = payload
        .get("remote")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| configured_remote(&repo, &local_branch));
    let remote_branch = payload
        .get("remoteBranch")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| configured_upstream_branch(&repo, &local_branch));
    let mut remote = repo.find_remote(&remote_name).map_err(format_git_error)?;
    let local_ref = format!("refs/heads/{local_branch}");
    let remote_ref = format!("refs/heads/{remote_branch}");
    let local_oid = repo.refname_to_id(&local_ref).map_err(format_git_error)?;
    let remote_tracking = format!("refs/remotes/{remote_name}/{remote_branch}");
    let remote_oid = repo
        .refname_to_id(&remote_tracking)
        .unwrap_or(git2::Oid::ZERO_SHA1);
    let remote_url = remote
        .pushurl()
        .ok()
        .flatten()
        .or_else(|| remote.url().ok())
        .unwrap_or_default()
        .to_owned();
    let hook_input = format!("{local_ref} {local_oid} {remote_ref} {remote_oid}\n");
    crate::hooks::run_hook(
        &repo,
        "pre-push",
        &[remote_name.clone(), remote_url],
        hook_input.as_bytes(),
    )?;
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks(&repo)?);
    let mut proxy = ProxyOptions::new();
    proxy.auto();
    options.proxy_options(proxy).packbuilder_parallelism(0);
    let refspec = format!("refs/heads/{local_branch}:refs/heads/{remote_branch}");
    remote
        .push(&[refspec.as_str()], Some(&mut options))
        .map_err(format_git_error)?;
    Ok(json!({ "remote": remote_name, "localBranch": local_branch, "remoteBranch": remote_branch }))
}

fn fast_forward(repo: &Repository, branch: &str, target: git2::Oid) -> NativeResult<()> {
    let before_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let target_tree = repo
        .find_commit(target)
        .map_err(format_git_error)?
        .tree()
        .map_err(format_git_error)?;
    let diff = repo
        .diff_tree_to_tree(before_tree.as_ref(), Some(&target_tree), None)
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
    // Check out safely before moving HEAD. A forced checkout here silently
    // discards local edits to files changed on the remote branch.
    let target_commit = repo.find_commit(target).map_err(format_git_error)?;
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().recreate_missing(true);
    repo.checkout_tree(target_commit.as_object(), Some(&mut checkout))
        .map_err(format_git_error)?;
    let reference_name = format!("refs/heads/{branch}");
    let mut reference = repo
        .find_reference(&reference_name)
        .map_err(format_git_error)?;
    reference
        .set_target(target, "libgit2 pull fast-forward")
        .map_err(format_git_error)?;
    repo.set_head(&reference_name).map_err(format_git_error)?;
    crate::filters::apply_smudge_filters(repo, &paths.into_iter().collect::<Vec<_>>())?;
    crate::hooks::run_hook(repo, "post-merge", &["0".to_owned()], &[])
}

pub fn pull(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let branch = payload
        .get("localBranch")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or(current_branch(&repo)?);
    let remote = payload
        .get("remote")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| configured_remote(&repo, &branch));
    let remote_branch = payload
        .get("remoteBranch")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| configured_upstream_branch(&repo, &branch));
    fetch_one(&repo, &remote, true)?;
    let remote_ref = format!("refs/remotes/{remote}/{remote_branch}");
    let target = repo
        .find_reference(&remote_ref)
        .map_err(format_git_error)?
        .peel_to_commit()
        .map_err(format_git_error)?;
    let annotated = repo
        .find_annotated_commit(target.id())
        .map_err(format_git_error)?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(format_git_error)?;
    if analysis.contains(MergeAnalysis::ANALYSIS_UP_TO_DATE) {
        return Ok(json!({ "changed": false, "remote": remote, "branch": remote_branch }));
    }
    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD)
        || analysis.contains(MergeAnalysis::ANALYSIS_UNBORN)
    {
        fast_forward(&repo, &branch, target.id())?;
        return Ok(
            json!({ "changed": true, "fastForward": true, "remote": remote, "branch": remote_branch }),
        );
    }
    let rebase = payload
        .get("rebase")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            repo.config()
                .ok()
                .and_then(|config| config.get_bool("pull.rebase").ok())
                .unwrap_or(false)
        });
    if rebase {
        return crate::operations::rebase(
            &json!({ "rootPath": string_arg(payload, "rootPath")?, "revision": target.id().to_string() }),
        );
    }
    crate::operations::merge(
        &json!({ "rootPath": string_arg(payload, "rootPath")?, "revision": target.id().to_string() }),
    )
}

pub fn checkout_branch(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let branch = string_arg(payload, "branch")?;
    let repo = open_repository(root_path)?;
    repo.find_branch(branch, BranchType::Local)
        .map_err(format_git_error)?;
    crate::operations::checkout(
        &json!({ "rootPath": root_path, "revision": branch, "detach": false }),
    )
}
