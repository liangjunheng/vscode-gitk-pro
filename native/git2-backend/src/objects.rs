use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use git2::{ObjectType, Oid};
use serde_json::{Map, Value};

pub fn read_objects(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let specs = string_array(payload, "objects")?;
    let repo = open_repository(root_path)?;
    let odb = repo.odb().map_err(format_git_error)?;
    let mut result = Map::new();
    for spec in specs {
        let oid = match Oid::from_str(&spec) {
            Ok(oid) => Some(oid),
            Err(_) => repo.revparse_single(&spec).ok().map(|object| object.id()),
        };
        let Some(oid) = oid else {
            continue;
        };
        let object = match odb.read(oid) {
            Ok(object) => object,
            Err(_) => continue,
        };
        result.insert(
            spec,
            Value::String(String::from_utf8_lossy(object.data()).into_owned()),
        );
    }
    Ok(Value::Object(result))
}

pub fn resolve_revision(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let specs = string_array(payload, "specs")?;
    let repo = open_repository(root_path)?;
    let values = specs
        .into_iter()
        .filter_map(|spec| {
            repo.revparse_single(&spec).ok().and_then(|object| {
                object
                    .peel(ObjectType::Commit)
                    .ok()
                    .map(|commit| Value::String(commit.id().to_string()))
            })
        })
        .collect();
    Ok(Value::Array(values))
}
