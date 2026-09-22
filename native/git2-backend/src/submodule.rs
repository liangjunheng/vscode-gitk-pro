use crate::remote::fetch_options;
use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use git2::{SubmoduleUpdateOptions, build::CheckoutBuilder};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

fn update_recursive(
    repo: &git2::Repository,
    selected: Option<&HashSet<String>>,
) -> NativeResult<()> {
    let mut modules = repo.submodules().map_err(format_git_error)?;
    for module in &mut modules {
        let path = module.path().to_string_lossy().replace('\\', "/");
        if selected.is_some_and(|paths| {
            !paths.contains(&path)
                && !paths
                    .iter()
                    .any(|value| value.starts_with(&format!("{path}/")))
        }) {
            continue;
        }
        let mut checkout = CheckoutBuilder::new();
        checkout.force().recreate_missing(true);
        let mut options = SubmoduleUpdateOptions::new();
        options.checkout(checkout).fetch(fetch_options(repo, true)?);
        module
            .update(true, Some(&mut options))
            .map_err(format_git_error)?;
        if let Ok(child) = module.open() {
            crate::filters::apply_smudge_all_filtered(&child)?;
            update_recursive(&child, None)?;
        }
    }
    Ok(())
}

pub fn update(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let paths = string_array(payload, "paths")?;
    let selected = if paths.is_empty() {
        None
    } else {
        Some(
            paths
                .into_iter()
                .map(|value| value.replace('\\', "/"))
                .collect::<HashSet<_>>(),
        )
    };
    update_recursive(&repo, selected.as_ref())?;
    Ok(Value::Null)
}

pub fn restore(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let target = string_arg(payload, "revision")?;
    crate::mutations::restore_all(&serde_json::json!({ "rootPath": root_path }))?;
    crate::operations::checkout(
        &serde_json::json!({ "rootPath": root_path, "revision": target, "detach": true }),
    )?;
    update_recursive(&repo, None)?;
    Ok(Value::Null)
}

pub fn index_gitlink(payload: &Value) -> NativeResult<Value> {
    let repo = open_repository(string_arg(payload, "rootPath")?)?;
    let path = Path::new(string_arg(payload, "path")?);
    let index = repo.index().map_err(format_git_error)?;
    Ok(index
        .get_path(path, 0)
        .map(|entry| Value::String(entry.id.to_string()))
        .unwrap_or(Value::Null))
}
