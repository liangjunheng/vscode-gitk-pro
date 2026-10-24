// A small, version-pinned patch to libgit2's existing stash implementation.
// Keep its standard commits, checkout/index updates, reflog and error semantics.
const fs = require('node:fs');
const path = require('node:path');

const STASH_PATCH_REVISION = 7;
const stashPatchFiles = [
  'libgit2/src/libgit2/stash.c', 'libgit2/src/libgit2/blob.c', 'libgit2/src/libgit2/blob.h',
  'libgit2/src/libgit2/attr.c', 'libgit2/src/libgit2/attr_file.h',
  'libgit2/src/libgit2/checkout.c', 'libgit2/src/libgit2/filter.c', 'libgit2/src/libgit2/filter.h',
];
function replaceOnce(contents, before, after, label) {
  if (!contents.includes(before) || contents.indexOf(before) !== contents.lastIndexOf(before)) {
    throw new Error(`libgit2 1.9.7 stash patch context changed: ${label}`);
  }
  return contents.replace(before, after);
}

function applyUnifiedPatch(directory, patchText) {
  const lines = patchText.replaceAll('\r\n', '\n').split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    if (!lines[cursor]) { cursor++; continue; }
    if (!lines[cursor].startsWith('--- a/')) {
      throw new Error('libgit2 1.9.7 stash patch context changed: malformed performance patch');
    }
    const oldPath = lines[cursor++].slice('--- a/'.length);
    const newLine = lines[cursor++];
    if (newLine !== '+++ b/' + oldPath) {
      throw new Error('libgit2 1.9.7 stash patch context changed: performance patch path');
    }
    const file = path.join(directory, oldPath);
    const source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n');
    const output = [];
    let sourceIndex = 0;
    while (cursor < lines.length && !lines[cursor].startsWith('--- a/')) {
      if (!lines[cursor]) { cursor++; continue; }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[cursor++]);
      if (!match) throw new Error('libgit2 1.9.7 stash patch context changed: performance hunk');
      const oldStart = Number(match[1]) - 1;
      while (sourceIndex < oldStart) output.push(source[sourceIndex++]);
      let oldCount = 0;
      let newCount = 0;
      while (cursor < lines.length && !lines[cursor].startsWith('@@ ') && !lines[cursor].startsWith('--- a/')) {
        const line = lines[cursor++];
        if (!line || line === '\\ No newline at end of file') continue;
        const marker = line[0];
        const contents = line.slice(1);
        if (marker === ' ' || marker === '-') {
          if (source[sourceIndex] !== contents) {
            throw new Error('libgit2 1.9.7 stash patch context changed: ' + oldPath);
          }
          sourceIndex++;
          oldCount++;
        }
        if (marker === ' ' || marker === '+') {
          output.push(contents);
          newCount++;
        }
        if (![' ', '-', '+'].includes(marker)) {
          throw new Error('libgit2 1.9.7 stash patch context changed: performance marker');
        }
      }
      const expectedOld = Number(match[2] || 1);
      const expectedNew = Number(match[4] || 1);
      if (oldCount !== expectedOld || newCount !== expectedNew) {
        throw new Error('libgit2 1.9.7 stash patch context changed: performance counts');
      }
    }
    output.push(...source.slice(sourceIndex));
    fs.writeFileSync(file, output.join('\n'));
  }
}

function applyStashPatch(directory) {
  const patch = (relative, replacements) => {
    const file = path.join(directory, relative);
    let text = fs.readFileSync(file, 'utf8');
    for (const [before, after, label] of replacements) text = replaceOnce(text, before, after, label);
    fs.writeFileSync(file, text);
  };
  patch('libgit2/src/libgit2/blob.h', [
    ['#include "common.h"', '#include "common.h"\n#include "filter.h"', 'blob filter session declaration'],
    ['\n#endif', `
/* Internal: share attribute reads only for one immutable stash capture batch. */
extern int git_blob__create_from_paths_with_session(
	git_oid *out_oid,
	struct stat *out_st,
	git_repository *repo,
	const char *full_path,
	const char *hint_path,
	mode_t hint_mode,
	bool apply_filters,
	git_filter_session *filter_session);

#endif`, 'session-aware blob declaration'],
  ]);
  patch('libgit2/src/libgit2/blob.c', [
    [`int git_blob__create_from_paths(
	git_oid *id,
	struct stat *out_st,
	git_repository *repo,
	const char *content_path,
	const char *hint_path,
	mode_t hint_mode,
	bool try_load_filters)`, `int git_blob__create_from_paths_with_session(
	git_oid *id,
	struct stat *out_st,
	git_repository *repo,
	const char *content_path,
	const char *hint_path,
	mode_t hint_mode,
	bool try_load_filters,
	git_filter_session *filter_session)`, 'session-aware blob definition'],
    [`		if (try_load_filters)
			/* Load the filters for writing this file to the ODB */
			error = git_filter_list_load(
				&fl, repo, NULL, hint_path,
				GIT_FILTER_TO_ODB, GIT_FILTER_DEFAULT);`, `		if (try_load_filters) {
			if (filter_session)
				error = git_filter_list__load(
					&fl, repo, NULL, hint_path,
					GIT_FILTER_TO_ODB, filter_session);
			else
				error = git_filter_list_load(
					&fl, repo, NULL, hint_path,
					GIT_FILTER_TO_ODB, GIT_FILTER_DEFAULT);
		}`, 'reuse stash attribute session'],
    ['\nint git_blob_create_from_workdir(', `
/* All non-stash callers retain the original behavior and API. */
int git_blob__create_from_paths(
	git_oid *id,
	struct stat *out_st,
	git_repository *repo,
	const char *content_path,
	const char *hint_path,
	mode_t hint_mode,
	bool try_load_filters)
{
	return git_blob__create_from_paths_with_session(
		id, out_st, repo, content_path, hint_path, hint_mode,
		try_load_filters, NULL);
}

int git_blob_create_from_workdir(`, 'preserve existing blob entry point'],
  ]);
  patch('libgit2/src/libgit2/stash.c', [
    [`static int stash_to_index(
	git_repository *repo,
	git_index *index,
	const char *path)`, `static int stash_to_index(
	git_repository *repo,
	git_index *index,
	const char *path,
	git_filter_session *filter_session)`, 'stash blob session parameter'],
    [`git_blob__create_from_paths(
	    &entry.id, &st, repo, NULL, path, 0, true)`, `git_blob__create_from_paths_with_session(
	    &entry.id, &st, repo, NULL, path, 0, true, filter_session)`, 'stash blob session call'],
    ['stash_to_index(repo, index, paths->strings[i])', 'stash_to_index(repo, index, paths->strings[i], NULL)', 'preserve pathspec capture behavior'],
    [`	int error = 0;
	size_t d, max_d = git_diff_num_deltas(diff);

	for (d = 0; !error && d < max_d; ++d) {`, `	int error = 0;
	size_t d, max_d = git_diff_num_deltas(diff);
	git_attr_session attr_session = {0};
	git_filter_session filter_session = GIT_FILTER_SESSION_INIT;

	if ((error = git_attr_session__init(&attr_session, repo)) < 0)
		goto cleanup;
	filter_session.attr_session = &attr_session;

	for (d = 0; !error && d < max_d; ++d) {`, 'batch-scoped attribute snapshot'],
    [`				"cannot update index. Unimplemented status (%d)",
				delta->status);
			return -1;`, `				"cannot update index. Unimplemented status (%d)",
				delta->status);
			error = -1;
			goto cleanup;`, 'free snapshot on unsupported delta'],
    [`		if (add_path != NULL)
			error = stash_to_index(repo, index, add_path);
	}

	return error;`, `		if (add_path != NULL) {
			const git_index_entry *existing = git_index_get_bypath(index, add_path, 0);
			/* A valid index delta already names the captured blob and mode.
			 * Workdir deltas have no valid id until their content is read. */
			if (existing && (delta->new_file.flags & GIT_DIFF_FLAG_VALID_ID) &&
			    existing->mode == delta->new_file.mode &&
			    git_oid_equal(&existing->id, &delta->new_file.id))
				continue;
			error = stash_to_index(repo, index, add_path, &filter_session);
		}
	}

cleanup:
	git_attr_session__free(&attr_session);
	return error;`, 'reuse staged-only blobs, keep exact mode/id validation'],
    ['git_diff_tree_to_workdir(&diff, repo, i_tree, &opts)', 'git_diff_index_to_workdir(&diff, repo, NULL, &opts)', 'discover untracked without rehashing tracked tree contents'],
  ]);
  // Keep libgit2's stash construction and cleanup; scope only redundant work.
  patch('libgit2/src/libgit2/stash.c', [
    [
      String.raw`#include "tree.h"
#include "reflog.h"
#include "blob.h"
#include "git2/diff.h"
#include "git2/stash.h"
#include "git2/status.h"
`,
      String.raw`#include "tree.h"
#include "reflog.h"
#include "blob.h"
#include "git2/attr.h"
#include "git2/config.h"
#include "git2/diff.h"
#include "git2/stash.h"
#include "git2/status.h"
`,
      "stash scoped capture/checkout 12"
    ],
    [
      String.raw`#include "merge.h"
#include "diff.h"
#include "diff_generate.h"
#include "strarray.h"

static int create_error(int error, const char *msg)
{
	git_error_set(GIT_ERROR_STASH, "cannot stash changes - %s", msg);
	return error;
}

`,
      String.raw`#include "merge.h"
#include "diff.h"
#include "diff_generate.h"
#include "attr_file.h"
#include "strarray.h"

static int create_error(int error, const char *msg)
{
	git_error_set(GIT_ERROR_STASH, "cannot stash changes - %s", msg);
	return error;
}

enum {
	GIT_STASH_FILTER_EXTERNAL = 1u << 0,
	GIT_STASH_FILTER_BUILTIN = 1u << 1,
};

static int stash_filter_driver_configured(
	bool *out, git_config *config, const char *name)
{
	static const char *directions[] = { "clean", "smudge", "process" };
	git_config_entry *entry = NULL;
	git_str key = GIT_STR_INIT;
	size_t i;
	int error = 0;

	*out = false;
	for (i = 0; i < ARRAY_SIZE(directions); i++) {
		if ((error = git_str_printf(&key, "filter.%s.%s", name, directions[i])) < 0)
			goto cleanup;
		error = git_config_get_entry(&entry, config, git_str_cstr(&key));
		if (error == GIT_ENOTFOUND) {
			git_error_clear();
			error = 0;
			git_str_clear(&key);
			continue;
		}
		if (error < 0)
			goto cleanup;
		git_config_entry_free(entry);
		entry = NULL;
		*out = true;
		break;
	}

cleanup:
	git_config_entry_free(entry);
	git_str_dispose(&key);
	return error;
}

static int stash_filter_flags_for_path(
	unsigned char *out,
	git_repository *repo,
	git_attr_session *session,
	git_config *config,
	int auto_crlf,
	const char *path)
{
	static const char *names[] = { "filter", "crlf", "eol", "text", "ident" };
	const char *values[ARRAY_SIZE(names)] = {0};
	git_attr_options opts = GIT_ATTR_OPTIONS_INIT;
	git_attr_value_t action;
	bool external = false;
	int error;

	*out = 0;
	opts.flags = GIT_ATTR_CHECK_FILE_THEN_INDEX;
	if ((error = git_attr_get_many_with_session(
		values, repo, session, &opts, path, ARRAY_SIZE(names), names)) < 0)
		return error;

	if (GIT_ATTR_HAS_VALUE(values[0]) &&
		(error = stash_filter_driver_configured(&external, config, values[0])) < 0)
		return error;
	if (external)
		*out |= GIT_STASH_FILTER_EXTERNAL;

	if (GIT_ATTR_IS_TRUE(values[4]) || GIT_ATTR_HAS_VALUE(values[4]))
		*out |= GIT_STASH_FILTER_BUILTIN;

	action = git_attr_value(values[3]);
	if (action == GIT_ATTR_VALUE_UNSPECIFIED)
		action = git_attr_value(values[1]);
	if (action == GIT_ATTR_VALUE_TRUE || action == GIT_ATTR_VALUE_STRING ||
		GIT_ATTR_HAS_VALUE(values[2]) ||
		(action == GIT_ATTR_VALUE_UNSPECIFIED && auto_crlf != GIT_AUTO_CRLF_FALSE))
		*out |= GIT_STASH_FILTER_BUILTIN;

	return 0;
}

int git_stash_filter_flags_from_workdir(
	unsigned char *out,
	const char *repository_path,
	size_t path_count,
	const char **paths)
{
	git_repository *repo = NULL;
	git_config *config = NULL;
	git_attr_session session = {0};
	int auto_crlf = GIT_AUTO_CRLF_FALSE;
	size_t i;
	int error;

	if ((error = git_repository_open(&repo, repository_path)) < 0 ||
		(error = git_repository_config__weakptr(&config, repo)) < 0 ||
		(error = git_repository__configmap_lookup(
			&auto_crlf, repo, GIT_CONFIGMAP_AUTO_CRLF)) < 0 ||
		(error = git_attr_session__init(&session, repo)) < 0)
		goto cleanup;

	for (i = 0; i < path_count; i++) {
		if ((error = stash_filter_flags_for_path(
			&out[i], repo, &session, config, auto_crlf, paths[i])) < 0)
			goto cleanup;
	}

cleanup:
	git_attr_session__free(&session);
	git_repository_free(repo);
	return error;
}

`,
      "stash scoped capture/checkout 25"
    ],
    [
      String.raw`	git_index *repo_index = NULL;
	git_index_entry entry = {{0}};
	struct stat st;
	int error;

	if (!git_repository_is_bare(repo) &&
	    (error = git_repository_index__weakptr(&repo_index, repo)) < 0)
		return error;

	if ((error = git_blob__create_from_paths_with_session(
	    &entry.id, &st, repo, NULL, path, 0, true, filter_session)) < 0)
		return error;

	git_index_entry__init_from_stat(&entry, &st,
`,
      String.raw`	git_index *repo_index = NULL;
	git_index_entry entry = {{0}};
	struct stat st;
	int error, auto_crlf;
	git_config *config = NULL;
	unsigned char flags = GIT_STASH_FILTER_BUILTIN;

	if (!git_repository_is_bare(repo) &&
	    (error = git_repository_index__weakptr(&repo_index, repo)) < 0)
		return error;

    if (filter_session) {
        if ((error = git_repository_config__weakptr(&config, repo)) < 0 ||
            (error = git_repository__configmap_lookup(&auto_crlf, repo, GIT_CONFIGMAP_AUTO_CRLF)) < 0 ||
            (error = stash_filter_flags_for_path(&flags, repo, filter_session->attr_session, config, auto_crlf, path)) < 0)
            return error;
    }
	if ((error = git_blob__create_from_paths_with_session(
	    &entry.id, &st, repo, NULL, path, 0, (flags & GIT_STASH_FILTER_BUILTIN) != 0, filter_session)) < 0)
		return error;

	git_index_entry__init_from_stat(&entry, &st,
`,
      "stash scoped capture/checkout 177"
    ],
    [
      String.raw`	return error;
}

static int reset_index_and_workdir(git_repository *repo, git_commit *commit, uint32_t flags)
{
	git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;

	opts.checkout_strategy = GIT_CHECKOUT_FORCE;
	if (flags & GIT_STASH_INCLUDE_UNTRACKED)
		opts.checkout_strategy |= GIT_CHECKOUT_REMOVE_UNTRACKED;
	if (flags & GIT_STASH_INCLUDE_IGNORED)
		opts.checkout_strategy |= GIT_CHECKOUT_REMOVE_IGNORED;

	return git_checkout_tree(repo, (git_object *)commit, &opts);
}

int git_stash_save(
`,
      String.raw`	return error;
}

static int reset_index_and_workdir(
    git_repository *repo, git_commit *commit, uint32_t flags,
    const git_oid *worktree_id, git_commit *untracked_commit)
{
    git_checkout_options opts = GIT_CHECKOUT_OPTIONS_INIT;
    git_diff_options diff_opts = GIT_DIFF_OPTIONS_INIT;
    git_commit *worktree_commit = NULL, *base_commit = NULL;
    git_tree *target = NULL, *worktree = NULL, *untracked = NULL, *base_tree = NULL;
    git_diff *diff = NULL, *untracked_diff = NULL, *staged_diff = NULL;
    git_config *config = NULL;
    git_attr_session session = {0};
    char **paths = NULL;
    size_t i, side, count = 0, capacity;
    int error = 0, auto_crlf;
    bool needs_filters = false, attributes_changed = false;

    opts.checkout_strategy = GIT_CHECKOUT_FORCE;
    if (flags & GIT_STASH_INCLUDE_UNTRACKED)
        opts.checkout_strategy |= GIT_CHECKOUT_REMOVE_UNTRACKED;
    if (flags & GIT_STASH_INCLUDE_IGNORED)
        opts.checkout_strategy |= GIT_CHECKOUT_REMOVE_IGNORED;
    if (!worktree_id)
        return git_checkout_tree(repo, (git_object *)commit, &opts);

    diff_opts.flags = GIT_DIFF_INCLUDE_TYPECHANGE | GIT_DIFF_INCLUDE_TYPECHANGE_TREES | GIT_DIFF_IGNORE_SUBMODULES;
    if ((error = git_commit_tree(&target, commit)) < 0 ||
        (error = git_commit_lookup(&worktree_commit, repo, worktree_id)) < 0 ||
        (error = git_commit_tree(&worktree, worktree_commit)) < 0 ||
        (error = git_diff_tree_to_tree(&diff, repo, target, worktree, &diff_opts)) < 0)
        goto cleanup;
    if (untracked_commit &&
        ((error = git_commit_tree(&untracked, untracked_commit)) < 0 ||
         (error = git_diff_tree_to_tree(&untracked_diff, repo, NULL, untracked, &diff_opts)) < 0))
        goto cleanup;
    if ((flags & GIT_STASH_KEEP_INDEX) &&
        ((error = git_commit_parent(&base_commit, commit, 0)) < 0 ||
         (error = git_commit_tree(&base_tree, base_commit)) < 0 ||
         (error = git_diff_tree_to_tree(&staged_diff, repo, base_tree, target, &diff_opts)) < 0))
        goto cleanup;
    capacity = 2 * (git_diff_num_deltas(diff) +
        (untracked_diff ? git_diff_num_deltas(untracked_diff) : 0) +
        (staged_diff ? git_diff_num_deltas(staged_diff) : 0));
    if (!capacity)
        goto cleanup;
    paths = git__calloc(capacity, sizeof(char *));
    if (!paths) { error = -1; goto cleanup; }
    if ((error = git_repository_config__weakptr(&config, repo)) < 0 ||
        (error = git_repository__configmap_lookup(&auto_crlf, repo, GIT_CONFIGMAP_AUTO_CRLF)) < 0 ||
        (error = git_attr_session__init(&session, repo)) < 0)
        goto cleanup;
    for (side = 0; side < 3; side++) {
        git_diff *current = side == 0 ? diff : (side == 1 ? untracked_diff : staged_diff);
        if (!current) continue;
        for (i = 0; i < git_diff_num_deltas(current); i++) {
            const git_diff_delta *delta = git_diff_get_delta(current, i);
            const char *p = delta->new_file.path ? delta->new_file.path : delta->old_file.path;
            const char *basename = strrchr(p, '/');
            unsigned char filter_flags;
            basename = basename ? basename + 1 : p;
            if (!git__strcasecmp(basename, ".gitattributes")) {
                attributes_changed = true;
                continue;
            }
            if ((error = stash_filter_flags_for_path(&filter_flags, repo, &session, config, auto_crlf, p)) < 0)
                goto cleanup;
            /* KEEP_INDEX still canonicalizes filtered staged-only paths. */
            if (side == 2 && !filter_flags && delta->old_file.mode == delta->new_file.mode)
                continue;
            if (filter_flags)
                needs_filters = true;
            if (delta->old_file.path) paths[count++] = (char *)delta->old_file.path;
            if (delta->new_file.path && (!delta->old_file.path || strcmp(delta->old_file.path, delta->new_file.path)))
                paths[count++] = (char *)delta->new_file.path;
        }
    }
    /* Attributes can affect unchanged siblings; retain upstream checkout then. */
    if (!attributes_changed) {
        if (!count) goto cleanup;
        opts.paths.strings = paths;
        opts.paths.count = count;
        opts.checkout_strategy |= GIT_CHECKOUT_DISABLE_PATHSPEC_MATCH;
        opts.disable_filters = !needs_filters;
    }
    error = git_checkout_tree(repo, (git_object *)commit, &opts);

cleanup:
    git_attr_session__free(&session);
    git__free(paths);
    git_diff_free(staged_diff);
    git_diff_free(untracked_diff);
    git_diff_free(diff);
    git_tree_free(base_tree);
    git_tree_free(untracked);
    git_tree_free(worktree);
    git_tree_free(target);
    git_commit_free(base_commit);
    git_commit_free(worktree_commit);
    return error;
}

int git_stash_save(
`,
      "stash scoped capture/checkout 665"
    ],
    [
      String.raw`
	if (!(opts->flags & GIT_STASH_KEEP_ALL) &&
	    (error = reset_index_and_workdir(repo,
		  (opts->flags & GIT_STASH_KEEP_INDEX) ? i_commit : b_commit,opts->flags)) < 0)
		goto cleanup;

cleanup:
`,
      String.raw`
	if (!(opts->flags & GIT_STASH_KEEP_ALL) &&
	    (error = reset_index_and_workdir(repo,
		  (opts->flags & GIT_STASH_KEEP_INDEX) ? i_commit : b_commit, opts->flags, has_paths ? NULL : out, u_commit)) < 0)
		goto cleanup;

cleanup:
`,
      "stash scoped capture/checkout 767"
    ]
  ]);
  applyUnifiedPatch(directory, fs.readFileSync(path.join(__dirname, 'libgit2-stash-performance.patch'), 'utf8'));
}

module.exports = { STASH_PATCH_REVISION, applyStashPatch, stashPatchFiles };
