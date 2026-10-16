// Repository worktrees have independent expansion, drafts and repository-scoped actions.
export const REPOSITORY_CHANGES_STYLES = `
  #filesList { display: none; }
  #repositoryChangesViewport { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; }
  #repositoryChangesList { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; padding: 5px 2px 8px; }
  #repositoryChangesList[hidden] { display: none; }
  .repo-changes { width: 100%; min-width: 0; margin-bottom: 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 6px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); cursor: pointer; }
  .repo-changes.focused { border-color: var(--vscode-focusBorder); }
  .repo-changes:focus { outline: none; }
  .repo-changes-header { position: sticky; top: 0; z-index: 2; isolation: isolate; display: flex; width: 100%; align-items: center; height: 30px; min-width: 0; gap: 3px; padding: 0 6px; overflow: hidden; background-color: inherit; }
  .repo-changes-header::after { content: none; }
  .repo-changes-header.pinned::after { content: ''; position: absolute; top: 0; right: 0; left: 0; z-index: 3; height: 1px; background: var(--vscode-widget-border, var(--vscode-editorGroup-border)); pointer-events: none; }
  .repo-changes.focused > .repo-changes-header.pinned::after { background: var(--vscode-focusBorder); }
  .repo-changes-toggle { display: flex; justify-content: center; align-items: center; flex: 0 0 18px; width: 18px; height: 24px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .repo-changes-title { display: flex; align-items: center; flex: 1; min-width: 0; gap: 0; cursor: pointer; }
  .repo-changes-icon { position: relative; display: inline-flex; align-items: center; flex: 0 0 16px; width: 16px; height: 20px; }
  .repo-changes-icon .repository-icon { margin: 0; }
  .repo-changes-badge { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 20px; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: #007acc; color: #ffffff; font: inherit; font-size: 10px; cursor: pointer; }
  .repo-changes-badge[hidden] { display: none; }
  .repo-changes-badge:hover { background: #0090e8; }
  .repo-changes-badge:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .repo-changes-label, .repo-changes-head { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-changes-label { flex: 0 1 auto; }
  .repo-changes-branch { display: flex; align-items: center; gap: 0; flex: 0 1 auto; min-width: 0; max-width: 45%; height: 24px; padding: 0 4px; border: 0; border-radius: 3px; color: var(--vscode-descriptionForeground); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
  .repo-changes-branch:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .repo-changes-branch:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-changes-head { min-width: 0; }
  .repo-changes-header .toolbar-icon { flex: 0 0 22px; width: 22px; height: 24px; border: 0; border-radius: 3px; cursor: pointer; }
  .repo-changes-toggle:hover, .repo-file:hover { background: var(--vscode-list-hoverBackground); }
  .repo-changes-toggle:focus-visible, .repo-file:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-changes-header { border-radius: 5px; }
  /* 保留标题/正文层级，但用低对比细线替代主题硬边框，减弱上下区域的割裂感。 */
  .repo-changes:has(.repo-changes-body:not([hidden])) > .repo-changes-header { border-radius: 5px 5px 0 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
  /* 列表静止时保留顶部 5px；吸顶后抵消容器 padding，恢复贴顶效果。 */
  .repo-changes > .repo-changes-header.pinned { top: -5px; border-top-left-radius: 0; border-top-right-radius: 0; }
  .repo-changes-body { min-width: 0; padding: 6px 10px 10px; }
  .repo-message-box, .repo-file-groups, .repo-commit-actions { cursor: default; }
  .repo-commit-details { box-sizing: border-box; display: block; width: 100%; min-height: 36px; max-height: calc(7.5em + 18px); resize: none; overflow-y: auto; overflow-x: hidden; margin-bottom: 4px; padding: 8px 9px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
  .repo-commit-details:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-message-box[hidden], .repo-commit-actions[hidden], .repo-commit-details[hidden] { display: none !important; }
  .repo-changes.transitioning .repo-message-box, .repo-changes.transitioning .repo-commit-actions { display: none !important; }
  .repo-changes-body[hidden], .repo-group[hidden], .repo-group-files[hidden], .repo-commit-menu[hidden] { display: none !important; }
  .repo-message-box { position: relative; display: flex; flex-direction: column; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-editorGroup-border))); border-radius: 5px; overflow: hidden; }
  .repo-message-box:focus-within { border-color: var(--vscode-focusBorder); }
  .repo-message { box-sizing: border-box; width: 100%; min-height: 48px; resize: none; overflow: hidden; padding: 8px 9px 4px; border: 0; outline: 0; background: transparent; color: var(--vscode-input-foreground); font: inherit; line-height: 1.5; }
  .repo-message::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .repo-commit-actions { display: flex; position: relative; margin: 7px 0 4px; }
  .repo-commit-actions > button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 12px; line-height: normal; cursor: pointer; }
  .repo-commit-actions > button:focus-visible, .repo-commit-menu button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .repo-commit-main { flex: 1; border-radius: 4px 0 0 4px; }
  .repo-commit-more { width: 28px; flex: 0 0 28px; border-left-color: var(--vscode-widget-border) !important; border-radius: 0 4px 4px 0; }
  .repo-commit-actions button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .repo-commit-actions button:disabled { opacity: .5; cursor: default; }
  .repo-commit-menu { position: absolute; top: calc(100% + 2px); right: 0; z-index: 8; padding: 4px; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
  .repo-commit-menu button { display: block; width: 100%; padding: 5px 9px; text-align: left; font: inherit; border: 0; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
  .repo-commit-menu button:hover { background: var(--vscode-list-hoverBackground); }
  .repo-group-header .toolbar-icon { display: inline-grid; place-items: center; flex: 0 0 22px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; }
  .repo-group-header .toolbar-icon:hover, .repo-file-row .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .repo-group-header .toolbar-icon:focus-visible, .repo-file-row .toolbar-icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-group + .repo-group { margin-top: 7px; }
  .repo-group-header { display: flex; height: 28px; align-items: center; gap: 4px; min-width: 0; color: var(--vscode-descriptionForeground); }
  .repo-group-toggle { display: flex; flex: 1; gap: 5px; align-items: center; min-width: 0; height: 26px; padding: 0 2px; border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--vscode-font-size, 13px); font-weight: 600; text-align: left; cursor: pointer; }
  .repo-group-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-count { border-radius: 10px; min-width: 20px; height: 18px; padding: 0 5px; text-align: center; line-height: 18px; font-size: calc(var(--vscode-font-size, 13px) - 1px); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .repo-group-files { min-width: 0; }
  .repo-folder-toggle { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 25px; padding: 0 5px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .repo-folder-toggle:hover { background: var(--vscode-list-hoverBackground); }
  .repo-folder-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repo-folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-folder-files { padding-left: 16px; }
  .repo-folder-files[hidden] { display: none; }
  .repo-folder-files .repo-file-folder { display: none; }
  .repo-file-row { display: flex; align-items: center; height: 25px; min-width: 0; }
  .repo-file { display: flex; flex: 1; align-items: center; height: 25px; gap: 6px; min-width: 0; padding: 0 5px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .repo-file-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 16px; width: 16px; height: 16px; line-height: 16px; }
  .repo-file-seti-icon { font-family: 'seti'; font-size: 18px; font-style: normal; font-weight: normal; -webkit-font-smoothing: antialiased; }
  .repo-file-name { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-file-folder { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .repo-file-status { flex: 0 0 13px; text-align: center; margin-left: auto; }
  .repo-file-row .toolbar-icon { width: 22px; height: 22px; flex: 0 0 22px; border: 0; cursor: pointer; }
  .repo-file-actions { display: flex; }
  .repo-file-row:hover { background: var(--vscode-list-hoverBackground); border-radius: 3px; }
  .repo-file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-radius: 3px; }
  .repo-file-row.selected .repo-file-folder { color: inherit; opacity: .8; }
  .repo-file.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
`;
export const REPOSITORY_CHANGES_SCRIPT = String.raw`
  let repositoryChanges = [];
  let selectedRepositoryCommitDetails = null;
  let pendingRepositoryFileSelection = null;
  let highlightedRepositoryFileRow = null;
  const repositoryChangesNodes = new Map();
  const repositoryDisplaySnapshots = new Map();
  let repositoryCardDisplayLocks = new Set();
  const repositoryChangesCollapsed = new Set();
  const repositoryChangesInitialized = new Set();
  const repositoryGroupsCollapsed = new Set();
  const repositoryFoldersCollapsed = new Set();
  const repositoryDrafts = new Map();
  function resizeRepositoryTextArea(input, borderHeight) {
    const container = input.parentElement;
    const minHeight = container.style.minHeight;
    // Keep the scroll extent stable while measuring an auto-height editor at the list bottom.
    container.style.minHeight = container.offsetHeight + 'px';
    try {
      input.style.height = 'auto';
      input.style.height = (input.scrollHeight + borderHeight) + 'px';
    } finally {
      container.style.minHeight = minHeight;
    }
  }
  function resizeRepositoryMessage(input) {
    if (!input.isConnected || input.closest('.repo-changes-body').hidden || input.closest('.repo-message-box').hidden) return;
    resizeRepositoryTextArea(input, 0);
  }
  function resizeRepositoryCommitDetails(input) {
    if (!input.isConnected || input.hidden || input.closest('.repo-changes-body').hidden) return;
    resizeRepositoryTextArea(input, 2);
  }
  let focusedRepositoryChangesPath = '';
  let repositoryChangesRevealPath = '';
  function revealRepositoryChanges(repositoryPath) {
    repositoryChangesCollapsed.delete(repositoryPath);
    focusedRepositoryChangesPath = repositoryPath;
    repositoryChangesRevealPath = repositoryPath;
    renderRepositoryChanges();
  }
  function focusRepositoryChanges(repositoryPath) {
    if (repositoryChangesCollapsed.has(repositoryPath) || focusedRepositoryChangesPath === repositoryPath) return;
    // Hide Commit controls in the same event turn as expansion; the host later confirms
    // the lock and preserves it until a complete historical snapshot is available.
    repositoryCardDisplayLocks.add(repositoryPath);
    focusedRepositoryChangesPath = repositoryPath;
    repositoryChangesNodes.forEach(function(node, path) {
      node.card.classList.toggle('focused', path === repositoryPath);
      if (path === repositoryPath) node.card.classList.add('transitioning');
    });
    vscode.postMessage({ type: 'repositoryChangesAction', action: 'focus', repositoryPath: repositoryPath });
  }
  function repoChangesIcon(action, icon, title) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toolbar-icon'; button.dataset.repoAction = action;
    button.title = title; button.setAttribute('aria-label', title);
    button.innerHTML = '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span>';
    return button;
  }
  const repositoryFallbackSetiIconDefinitions = {
    default: ['E023', '#d4d7d6'], c: ['E00C', '#519aba'], cHeader: ['E00C', '#a074c4'], cpp: ['E01A', '#519aba'], cppHeader: ['E01A', '#a074c4'],
    objectiveC: ['E00C', '#cbcb41'], objectiveCpp: ['E01A', '#cbcb41'], csharp: ['E00B', '#519aba'], fsharp: ['E02E', '#519aba'],
    kotlin: ['E058', '#e37933'], java: ['E050', '#cc3e44'], groovy: ['E03D', '#8dc149'], gradle: ['E03C', '#519aba'], rust: ['E082', '#6d8086'],
    typescript: ['E099', '#519aba'], react: ['E07D', '#519aba'], javascript: ['E051', '#cbcb41'], python: ['E07B', '#519aba'], go: ['E03A', '#519aba'],
    html: ['E048', '#e37933'], css: ['E01D', '#519aba'], sass: ['E084', '#f55385'], less: ['E059', '#519aba'], vue: ['E09D', '#8dc149'], svelte: ['E090', '#cc3e44'],
    json: ['E055', '#cbcb41'], markdown: ['E060', '#519aba'], image: ['E04C', '#a074c4'], svg: ['E091', '#a074c4'], audio: ['E005', '#a074c4'], video: ['E09B', '#f55385'],
    pdf: ['E06D', '#cc3e44'], zip: ['E0A9', '#6d8086'], archive: ['E0A9', '#cc3e44'], database: ['E022', '#f55385'], shell: ['E089', '#8dc149'],
    powershell: ['E074', '#519aba'], windows: ['E0A2', '#519aba'], hex: ['E047', '#cc3e44'], config: ['E019', '#6d8086'], xml: ['E0A5', '#e37933'], yaml: ['E0A7', '#a074c4'], csv: ['E01E', '#8dc149'],
    docker: ['E025', '#519aba'], makefile: ['E05F', '#e37933'], jenkins: ['E052', '#cc3e44'], info: ['E04D', '#519aba'], license: ['E05A', '#cbcb41'],
    npm: ['E067', '#41535b'], yarn: ['E0A6', '#519aba'], tsconfig: ['E097', '#519aba'], git: ['E034', '#41535b'], dart: ['E021', '#519aba'], php: ['E070', '#a074c4'], ruby: ['E081', '#cc3e44'], swift: ['E092', '#e37933'], lua: ['E05E', '#519aba'],
  };
  let repositorySetiIconDefinitions = repositoryFallbackSetiIconDefinitions;
  const repositorySetiDefinitionsNode = document.getElementById('gitk-seti-icon-definitions');
  if (repositorySetiDefinitionsNode?.textContent) {
    try {
      repositorySetiIconDefinitions = Object.assign({}, repositoryFallbackSetiIconDefinitions, JSON.parse(repositorySetiDefinitionsNode.textContent));
    } catch {
      repositorySetiIconDefinitions = repositoryFallbackSetiIconDefinitions;
    }
  }
  const repositorySetiExtensionIcons = {
    c: 'c', h: 'cHeader', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cppHeader', hh: 'cppHeader', hxx: 'cppHeader', m: 'objectiveC', mm: 'objectiveCpp',
    kt: 'kotlin', kts: 'kotlin', java: 'java', groovy: 'groovy', gradle: 'gradle', rs: 'rust', ts: 'typescript', tsx: 'react', js: 'javascript', jsx: 'react', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyw: 'python', go: 'go', cs: 'csharp', fs: 'fsharp', fsx: 'fsharp', vb: 'csharp', dart: 'dart', php: 'php', rb: 'ruby', swift: 'swift', lua: 'lua',
    html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', css: 'css', scss: 'sass', sass: 'sass', less: 'less',
    json: 'json', jsonc: 'json', 'code-workspace': 'json', md: 'markdown', mdx: 'markdown', markdown: 'markdown', rst: 'markdown', adoc: 'markdown',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image', heic: 'image', svg: 'svg',
    mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', mp4: 'video', mov: 'video', webm: 'video', avi: 'video', mkv: 'video',
    pdf: 'pdf', zip: 'zip', '7z': 'zip', rar: 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip', tgz: 'zip', jar: 'archive', war: 'archive',
    db: 'database', sqlite: 'database', sqlite3: 'database', sql: 'database', mdb: 'database', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    ps1: 'powershell', psm1: 'powershell', bat: 'windows', cmd: 'windows', exe: 'hex', dll: 'hex', so: 'hex', dylib: 'hex', bin: 'hex', class: 'hex', o: 'hex', obj: 'hex', a: 'hex',
    yaml: 'yaml', yml: 'yaml', toml: 'config', xml: 'xml', ini: 'config', conf: 'config', cfg: 'config', properties: 'config', env: 'config', csv: 'csv', tsv: 'csv',
  };
  const repositorySetiFileNameIcons = {
    dockerfile: 'docker', makefile: 'makefile', 'cmakelists.txt': 'makefile', jenkinsfile: 'jenkins', gradlew: 'shell', 'gradlew.bat': 'windows',
    readme: 'info', 'readme.md': 'info', license: 'license', 'license.txt': 'license', notice: 'info', authors: 'info', changelog: 'info',
    '.gitignore': 'git', '.gitattributes': 'git', '.editorconfig': 'config', '.clangd': 'config', '.npmrc': 'npm', '.yarnrc': 'yarn',
    'package.json': 'npm', 'package-lock.json': 'npm', 'yarn.lock': 'yarn', 'tsconfig.json': 'tsconfig', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
  };
  function repositoryFileIconHTML(file) {
    if (file.isGitlink) {
      const icon = file.gitlinkHasSubmodules === false ? 'archive' : 'repo';
      return '<span class="repo-file-icon codicon codicon-' + icon + '" data-file-icon="' + icon + '" aria-hidden="true"></span>';
    }
    const path = String(file.path || '').replace(/\\/g, '/');
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot + 1) : '';
    const iconName = repositorySetiFileNameIcons[name] || repositorySetiExtensionIcons[extension] || 'default';
    const definition = repositorySetiIconDefinitions[iconName] || repositorySetiIconDefinitions.default;
    return '<span class="repo-file-icon repo-file-seti-icon" data-file-icon="' + iconName + '" style="color:' + definition[1] + '" aria-hidden="true">&#x' + definition[0] + ';</span>';
  }
  function repoChangesSections(repository) {
    const conflicts = new Map();
    (repository.staged || []).concat(repository.unstaged || []).forEach(function(file) {
      if (file.isConflict) conflicts.set(file.path, file);
    });
    return [
      { key: 'conflict', label: 'Merge Changes', files: Array.from(conflicts.values()) },
      { key: 'unstaged', label: 'Unstaged Changes', files: (repository.unstaged || []).filter(function(file) { return !file.isConflict; }) },
      { key: 'staged', label: 'Staged Changes', files: (repository.staged || []).filter(function(file) { return !file.isConflict; }) }
    ];
  }
  function createRepositoryChangesNode(repository) {
    const card = document.createElement('section'); card.className = 'repo-changes'; card.dataset.repositoryPath = repository.repositoryPath; card.tabIndex = -1;
    card.innerHTML = '<div class="repo-changes-header"><button type="button" class="repo-changes-toggle" data-repo-action="toggle"><span class="codicon codicon-chevron-down repo-chevron"></span></button><div class="repo-changes-title"><span class="repo-changes-icon"></span><span class="repo-changes-label"></span><button type="button" class="repo-changes-badge" data-repo-action="worktree" hidden></button></div><button type="button" class="repo-changes-branch" data-repo-action="branch"><span class="codicon codicon-git-branch"></span><span class="repo-changes-head"></span></button></div><div class="repo-changes-body"><div class="repo-message-box"><textarea class="repo-message" rows="1" spellcheck="false"></textarea></div><div class="repo-commit-actions"><button type="button" class="repo-commit-main" data-repo-action="commit"><span class="repo-commit-label">Commit</span></button><button type="button" class="repo-commit-more" data-repo-action="menu" title="更多提交操作" aria-label="更多提交操作"><span class="codicon codicon-chevron-down"></span></button><div class="repo-commit-menu" hidden></div></div><div class="repo-file-groups"></div></div>';
    const header = card.querySelector('.repo-changes-header');
    const details = document.createElement('textarea'); details.className = 'repo-commit-details'; details.hidden = true;
    details.readOnly = true; details.rows = 1; details.spellcheck = false;
    details.setAttribute('aria-label', '提交标题与描述');
    card.querySelector('.repo-changes-body').insertBefore(details, card.querySelector('.repo-message-box'));
    header.append(repoChangesIcon('syncRefresh', 'sync', '同步此仓库'));
    header.append(repoChangesIcon('terminal', 'terminal', '在终端中打开此仓库'));
    const menu = card.querySelector('.repo-commit-menu');
    [['commit', 'Commit'], ['amend', 'Commit (Amend)'], ['push', 'Commit & Push'], ['syncCommit', 'Commit & Sync']].forEach(function(item) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.repoAction = item[0]; button.textContent = item[1]; menu.appendChild(button);
    });
    return { card: card, input: card.querySelector('.repo-message'), groups: card.querySelector('.repo-file-groups'), groupsKey: '', rowsByDiffKey: new Map(), message: undefined };
  }
  function updateRepositoryDisplaySnapshot(state) {
    const commit = state.selectedCommit;
    if (!commit || !commit.repositoryPath || !commit.hash) return;
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === commit.repositoryPath; });
    if (!repository) return;
    if (isWorkingTreeHash(commit.hash)) {
      // A card-click may temporarily select the remembered worktree identity. The host owns
      // the display lock and only explicit worktree/file actions are allowed to replace it.
      if (repositoryCardDisplayLocks.has(commit.repositoryPath)) return;
      repositoryDisplaySnapshots.set(commit.repositoryPath, { kind: 'worktree' });
      return;
    }
    // Loading/failed reads are not empty commits. File ownership can lag controller selection.
    if (state.filesLoading || state.diffError || !Array.isArray(state.files)) return;
    const identity = state.filesIdentity;
    if (identity && (identity.repositoryPath !== commit.repositoryPath || identity.hash !== commit.hash)) return;
    repositoryDisplaySnapshots.set(commit.repositoryPath, {
      kind: 'commit', commit: { ...commit }, files: state.files.map(function(file) { return { ...file }; })
    });
  }
  function currentRepositorySnapshot(node, repository) {
    // Rendering never mutates historical snapshots; worktrees use their own live repository data.
    const snapshot = repositoryDisplaySnapshots.get(repository.repositoryPath);
    return snapshot && snapshot.kind === 'commit' ? snapshot
      : { kind: 'worktree', staged: repository.staged || [], unstaged: repository.unstaged || [] };
  }
  function renderRepositoryFileGroups(node, repository) {
    const snapshot = currentRepositorySnapshot(node, repository);
    const displayRepository = snapshot.kind === 'worktree'
      ? { ...repository, staged: snapshot.staged || [], unstaged: snapshot.unstaged || [] }
      : repository;
    let sections = snapshot.kind === 'commit'
      ? [{ key: 'commit', label: '提交变更 ' + snapshot.commit.hash.slice(0, 8), files: snapshot.files }]
      : repoChangesSections(displayRepository);
    const key = JSON.stringify([filesMode, repository.mergeOperation, repository.mergeOperationBusy, sections.map(function(section) { return [section.key, section.label, section.files]; })]);
    if (key === node.groupsKey) return;
    node.groupsKey = key; node.groups.replaceChildren(); node.rowsByDiffKey.clear();
    sections.forEach(function(section) {
      if (!section.files.length && !(section.key === 'conflict' && repository.mergeOperation)) return;
      const group = document.createElement('div'); group.className = 'repo-group'; group.dataset.section = section.key;
      const header = document.createElement('div'); header.className = 'repo-group-header';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'repo-group-toggle'; toggle.dataset.repoAction = 'group';
      toggle.innerHTML = '<span class="codicon codicon-chevron-down"></span><span>' + escapeHtml(section.label) + '</span>';
      const badge = document.createElement('span'); badge.className = 'repo-count'; badge.textContent = String(section.files.length);
      header.append(toggle, badge);
      if (section.key === 'conflict') {
        const actions = document.createElement('span'); actions.style.cssText = 'display:flex;margin-left:auto;gap:2px';
        const proceed = repoChangesIcon('continue', 'check', '继续当前合并操作');
        const abort = repoChangesIcon('abort', 'close', '中止当前合并操作');
        proceed.disabled = !repository.mergeOperation || section.files.length > 0 || repository.mergeOperationBusy;
        abort.disabled = !repository.mergeOperation || repository.mergeOperationBusy;
        actions.append(proceed, abort); header.append(actions);
      }
      if (section.key === 'unstaged') header.appendChild(repoChangesIcon('discard', 'discard', '还原所有文件'));
      if (section.key !== 'conflict' && section.key !== 'commit') header.appendChild(repoChangesIcon(section.key === 'staged' ? 'unstage' : 'stage', section.key === 'staged' ? 'remove' : 'add', section.key === 'staged' ? '取消暂存全部' : '暂存全部'));
      const rows = document.createElement('div'); rows.className = 'repo-group-files';
      const folderRows = new Map();
      section.files.forEach(function(file) {
        const slash = file.path.lastIndexOf('/');
        const folder = slash < 0 ? '' : file.path.slice(0, slash);
        let container = rows;
        if (filesMode === 'tree' && folder) {
          container = folderRows.get(folder);
          if (!container) {
            const folderKey = JSON.stringify([repository.repositoryPath, section.key, folder]);
            const expanded = !repositoryFoldersCollapsed.has(folderKey);
            const wrapper = document.createElement('div'); wrapper.className = 'repo-folder'; wrapper.dataset.folderKey = folderKey;
            const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'repo-folder-toggle'; toggle.dataset.repoAction = 'folder';
            toggle.title = folder; toggle.setAttribute('aria-expanded', String(expanded));
            toggle.innerHTML = '<span class="codicon codicon-chevron-' + (expanded ? 'down' : 'right') + '"></span><span class="codicon codicon-folder' + (expanded ? '-opened' : '') + '"></span><span class="repo-folder-name">' + escapeHtml(folder) + '</span>';
            container = document.createElement('div'); container.className = 'repo-folder-files'; container.hidden = !expanded;
            wrapper.append(toggle, container); rows.appendChild(wrapper); folderRows.set(folder, container);
          }
        }
        const row = document.createElement('div'); row.className = 'repo-file-row'; row.dataset.filePath = file.path;
        row.dataset.diffKey = section.key === 'commit' ? (file.diffKey || file.path) : section.key + ':' + file.path;
        node.rowsByDiffKey.set(row.dataset.diffKey, row);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'repo-file'; button.dataset.repoAction = 'file'; button.title = file.path;
        button.innerHTML = repositoryFileIconHTML(file) + '<span class="repo-file-name">' + escapeHtml(file.path.slice(slash + 1)) + '</span><span class="repo-file-folder">' + escapeHtml(slash < 0 ? '' : file.path.slice(0, slash)) + '</span><span class="repo-file-status file-status-' + escapeAttr(file.status) + '">' + escapeHtml(file.status) + '</span>';
        row.appendChild(button);
        const actions = document.createElement('span'); actions.className = 'repo-file-actions';
        if (section.key !== 'commit') actions.appendChild(repoChangesIcon(section.key === 'staged' ? 'unstage' : 'stage', section.key === 'staged' ? 'remove' : 'add', section.key === 'staged' ? '取消暂存' : '暂存'));
        if (section.key === 'unstaged') actions.appendChild(repoChangesIcon('discard', 'discard', '放弃此文件变更'));
        row.appendChild(actions); container.appendChild(row);
      });
      group.append(header, rows); node.groups.appendChild(group);
    });
  }
  function updateRepositoryFolderVisibility(folder) {
    const expanded = !repositoryFoldersCollapsed.has(folder.dataset.folderKey);
    const toggle = folder.querySelector('.repo-folder-toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.querySelector('.codicon').className = 'codicon codicon-chevron-' + (expanded ? 'down' : 'right');
    toggle.querySelectorAll('.codicon')[1].className = 'codicon codicon-folder' + (expanded ? '-opened' : '');
    folder.querySelector('.repo-folder-files').hidden = !expanded;
  }
  function updateRepositoryChangesVisibility(node, repository) {
    const expanded = !repositoryChangesCollapsed.has(repository.repositoryPath);
    const toggle = node.card.querySelector('.repo-changes-toggle'); toggle.setAttribute('aria-expanded', String(expanded));
    toggle.querySelector('.repo-chevron').className = 'codicon repo-chevron codicon-chevron-' + (expanded ? 'down' : 'right');
    node.card.querySelector('.repo-changes-body').hidden = !expanded;
    if (expanded) resizeRepositoryMessage(node.input);
    if (expanded) resizeRepositoryCommitDetails(node.card.querySelector('.repo-commit-details'));
    node.card.querySelectorAll('.repo-group').forEach(function(group) {
      const collapsed = repositoryGroupsCollapsed.has(repository.repositoryPath + '\u0000' + group.dataset.section);
      group.querySelector('.repo-group-files').hidden = collapsed;
      group.querySelector('.repo-group-toggle .codicon').className = 'codicon codicon-chevron-' + (collapsed ? 'right' : 'down');
    });
    updateRepositoryPinnedHeaders();
  }
  function syncRepositoryFileSelection(reveal, repositoryPath, diffKey) {
    repositoryPath = repositoryPath === undefined ? selectedCommitRepositoryPath : repositoryPath;
    diffKey = diffKey === undefined ? selectedPath : diffKey;
    const node = repositoryChangesNodes.get(repositoryPath);
    const row = node && node.rowsByDiffKey.get(diffKey);
    if (highlightedRepositoryFileRow && highlightedRepositoryFileRow !== row) {
      highlightedRepositoryFileRow.classList.remove('selected');
      highlightedRepositoryFileRow.querySelector('.repo-file').classList.remove('selected');
    }
    highlightedRepositoryFileRow = row || null;
    if (!row) return;
    row.classList.add('selected'); row.querySelector('.repo-file').classList.add('selected');
    if (!reveal) return;
    repositoryChangesCollapsed.delete(repositoryPath);
    const group = row.closest('.repo-group');
    repositoryGroupsCollapsed.delete(repositoryPath + String.fromCharCode(0) + group.dataset.section);
    const folder = row.closest('.repo-folder');
    if (folder) {
      repositoryFoldersCollapsed.delete(folder.dataset.folderKey);
      updateRepositoryFolderVisibility(folder);
    }
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === repositoryPath; });
    if (repository) updateRepositoryChangesVisibility(node, repository);
    // Scroll only the file-list viewport; MultiDiff feedback must not steal keyboard focus.
    const list = document.getElementById('repositoryChangesList');
    const bounds = list.getBoundingClientRect(); const target = row.getBoundingClientRect();
    if (target.top < bounds.top + list.clientTop) list.scrollTop += target.top - bounds.top - list.clientTop;
    else if (target.bottom > bounds.top + list.clientTop + list.clientHeight) list.scrollTop += target.bottom - bounds.top - list.clientTop - list.clientHeight;
  }
  function renderRepositoryChanges() {
    const list = document.getElementById('repositoryChangesList');
    focusedRepositoryChangesPath = repositoryChangesRevealPath
      || (selectedRepositoryPaths.length === 1 ? selectedRepositoryPaths[0] : '');
    const paths = new Set(repositoryChanges.map(function(repository) { return repository.repositoryPath; }));
    repositoryChangesNodes.forEach(function(node, repositoryPath) { if (!paths.has(repositoryPath)) { node.card.remove(); repositoryChangesNodes.delete(repositoryPath); } });
    repositoryChanges.forEach(function(repository, index) {
      // Seed only once per repository; refresh and topology reordering preserve the user's choice.
      if (!repositoryChangesInitialized.has(repository.repositoryPath)) {
        repositoryChangesInitialized.add(repository.repositoryPath);
        const main = repository.isMainRepository === true || (repository.isMainRepository === undefined && index === 0);
        if (!main && repositoryChangesRevealPath !== repository.repositoryPath) repositoryChangesCollapsed.add(repository.repositoryPath);
      }
      let node = repositoryChangesNodes.get(repository.repositoryPath);
      if (!node) { node = createRepositoryChangesNode(repository); repositoryChangesNodes.set(repository.repositoryPath, node); }
      node.card.querySelector('.repo-changes-label').textContent = repository.repositoryLabel;
      const icon = node.card.querySelector('.repo-changes-icon');
      const iconKey = String(Boolean(repository.hasSubmodules)) + ':' + String(Boolean(repository.isSubmodule));
      if (icon.dataset.kind !== iconKey) {
        icon.dataset.kind = iconKey;
        icon.innerHTML = repositoryIcon(repository.hasSubmodules, repository.isSubmodule);
      }
      icon.title = repository.hasSubmodules ? '包含子仓库' : repository.isSubmodule ? '子仓库（无下级子仓库）' : '独立仓库（无子仓库）';
      const changeCount = new Set((repository.staged || []).concat(repository.unstaged || []).map(function(file) { return file.path; })).size;
      const badge = node.card.querySelector('.repo-changes-badge');
      badge.hidden = changeCount === 0;
      badge.textContent = String(changeCount);
      badge.title = '查看 ' + changeCount + ' 个未提交变更文件';
      badge.setAttribute('aria-label', repository.repositoryLabel + '：' + changeCount + ' 个未提交变更文件');
      node.card.querySelector('.repo-changes-head').textContent = repository.headLabel || 'HEAD';
      node.card.querySelector('.repo-changes-branch').title = '切换分支：' + (repository.headLabel || 'HEAD');
      node.card.querySelector('.repo-changes-branch').setAttribute('aria-label', repository.repositoryLabel + '：切换分支');
      node.card.querySelector('.repo-changes-title').title = repository.repositoryPath;
      node.card.querySelector('.repo-changes-toggle').setAttribute('aria-label', repository.repositoryLabel + '：展开或收起');
      node.card.classList.toggle('focused', focusedRepositoryChangesPath === repository.repositoryPath);
      node.input.placeholder = '提交信息';
      node.input.setAttribute('aria-label', repository.repositoryLabel + '：提交信息');
      node.input.title = '提交到 ' + (repository.headLabel || repository.repositoryLabel);
      const snapshot = currentRepositorySnapshot(node, repository);
      const historical = snapshot.kind === 'commit';
      const commitControlsLocked = repositoryCardDisplayLocks.has(repository.repositoryPath);
      node.card.classList.toggle('transitioning', commitControlsLocked);
      const messageBox = node.card.querySelector('.repo-message-box');
      const actions = node.card.querySelector('.repo-commit-actions');
      const details = node.card.querySelector('.repo-commit-details');
      // Card focus keeps its existing selection flow, but it must not reinterpret an
      // asynchronous uncommitted selection as a request to reveal Commit controls.
      messageBox.hidden = Boolean(historical || commitControlsLocked);
      actions.hidden = Boolean(historical || commitControlsLocked);
      details.hidden = !historical;
      if (historical) {
        const metadata = snapshot.commit || {};
        if (details.dataset.commitHash !== metadata.hash) details.scrollTop = 0;
        details.dataset.commitHash = metadata.hash;
        // Strip terminal line breaks for display only; preserve the Git message and commit draft.
        const raw = typeof metadata.rawMessage === 'string' ? metadata.rawMessage : undefined;
        let value = raw === undefined ? (metadata.message || '') + (metadata.body ? String.fromCharCode(10, 10) + metadata.body : '') : raw;
        while (value.endsWith(String.fromCharCode(10)) || value.endsWith(String.fromCharCode(13))) value = value.slice(0, -1);
        if (details.value !== value) details.value = value;
        node.card.querySelector('.repo-commit-menu').hidden = true;
      }
      if (!repositoryDrafts.has(repository.repositoryPath)
          || (node.message !== repository.message && document.activeElement !== node.input)) {
        repositoryDrafts.set(repository.repositoryPath, repository.message || '');
      }
      node.message = repository.message;
      if (document.activeElement !== node.input) node.input.value = repositoryDrafts.get(repository.repositoryPath);
      const displayRepository = snapshot.kind === 'worktree' ? { ...repository, staged: snapshot.staged || [], unstaged: snapshot.unstaged || [] } : repository;
      const conflicts = repoChangesSections(displayRepository)[0].files.length > 0;
      const displayHasStagedChanges = (displayRepository.staged || []).length > 0;
      const disabled = historical || commitControlsLocked || conflicts || repository.committing || !node.input.value.trim() || !displayHasStagedChanges;
      node.card.querySelectorAll('.repo-commit-main, .repo-commit-menu button').forEach(function(button) { button.disabled = Boolean(disabled); });
      const commitButton = node.card.querySelector('.repo-commit-main');
      commitButton.title = conflicts ? '请先解决合并冲突' : 'Commit (Ctrl / ⌘ + Enter)';
      commitButton.setAttribute('aria-busy', String(Boolean(repository.committing)));
      node.card.querySelector('.repo-commit-label').textContent = repository.committing ? '提交中…' : 'Commit';
      node.card.querySelector('.repo-commit-more').disabled = Boolean(disabled);
      renderRepositoryFileGroups(node, repository); updateRepositoryChangesVisibility(node, repository);
      const at = list.children[index]; if (at !== node.card) list.insertBefore(node.card, at || null);
      resizeRepositoryMessage(node.input);
      resizeRepositoryCommitDetails(details);
    });
    syncRepositoryFileSelection(false);
    const revealed = repositoryChangesNodes.get(repositoryChangesRevealPath);
    if (revealed) {
      revealed.card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      // Focus the repository container, not its editor: navigation must not steal an input cursor.
      revealed.card.focus({ preventScroll: true });
      repositoryChangesRevealPath = '';
    }
    updateRepositoryPinnedHeaders();
  }
  function updateRepositoryPinnedHeaders() {
    const list = document.getElementById('repositoryChangesList');
    const top = list.getBoundingClientRect().top + list.clientTop;
    repositoryChangesNodes.forEach(function(node) {
      // Only replace the card top border once it has scrolled completely out of view.
      node.card.querySelector('.repo-changes-header').classList.toggle('pinned', node.card.getBoundingClientRect().top + node.card.clientTop <= top);
    });
  }
  const repositoryChangesList = document.getElementById('repositoryChangesList');
  const repositoryChangesViewport = document.getElementById('repositoryChangesViewport');
  const repositoryChangesScrollbar = document.getElementById('repositoryChangesScrollbar');
  installOverlayScrollbars(repositoryChangesViewport, repositoryChangesList, [repositoryChangesScrollbar]);
  repositoryChangesList.addEventListener('scroll', updateRepositoryPinnedHeaders, { passive: true });
  const repositoryHeaderResizeObserver = new ResizeObserver(updateRepositoryPinnedHeaders);
  repositoryHeaderResizeObserver.observe(repositoryChangesList);
  window.addEventListener('resize', function() {
    repositoryChangesNodes.forEach(function(node) { resizeRepositoryMessage(node.input); resizeRepositoryCommitDetails(node.card.querySelector('.repo-commit-details')); });
    updateRepositoryPinnedHeaders();
  });
  repositoryChangesList.addEventListener('focusin', function(event) {
    const card = event.target.closest('.repo-changes');
    // Header controls manage their own expansion/action; focus inside an expanded body owns history.
    if (card && event.target.closest('button, textarea, input, select, a') && event.target.closest('.repo-changes-body, .repo-changes-branch')) focusRepositoryChanges(card.dataset.repositoryPath);
  });
  repositoryChangesList.addEventListener('pointerdown', function(event) {
    if (event.button !== 0) return;
    const card = event.target.closest('.repo-changes');
    if (card && event.target.closest('button, textarea, input, select, a') && event.target.closest('.repo-changes-body, .repo-changes-branch')) focusRepositoryChanges(card.dataset.repositoryPath);
  });
  document.addEventListener('click', function(event) {
    if (!event.target.closest('.repo-commit-actions')) repositoryChangesList.querySelectorAll('.repo-commit-menu').forEach(function(menu) { menu.hidden = true; });
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') repositoryChangesList.querySelectorAll('.repo-commit-menu').forEach(function(menu) { menu.hidden = true; });
  });
  repositoryChangesList.addEventListener('input', function(event) {
    if (!event.target.matches('.repo-message')) return;
    const repositoryPath = event.target.closest('.repo-changes').dataset.repositoryPath;
    repositoryDrafts.set(repositoryPath, event.target.value);
    vscode.postMessage({ type: 'updateCommitMessage', repositoryPath: repositoryPath, message: event.target.value });
    renderRepositoryChanges();
  });
  function postRepositoryCommit(card, action) {
    const button = card.querySelector('.repo-commit-main'); if (button.disabled || card.querySelector('.repo-message-box').hidden) return;
    vscode.postMessage({ type: 'workingTreeCommit', action: action === 'syncCommit' ? 'sync' : action, repositoryPath: card.dataset.repositoryPath, message: card.querySelector('.repo-message').value });
    card.querySelector('.repo-commit-menu').hidden = true;
  }
  repositoryChangesList.addEventListener('keydown', function(event) {
    if (event.target.matches('.repo-changes') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.target.click(); return;
    }
    if (event.target.matches('.repo-message') && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); postRepositoryCommit(event.target.closest('.repo-changes'), 'commit'); }
  });
  repositoryChangesList.addEventListener('click', function(event) {
    const card = event.target.closest('.repo-changes'); if (!card) return;
    const button = event.target.closest('[data-repo-action]');
    // An unfocused header selects first; clicking the focused header again toggles expansion.
    if (!button && event.target.closest('button, textarea, input, select, a, .repo-message-box, .repo-commit-details, .repo-file-row, .repo-group-header, .repo-commit-menu')) return;
    const repositoryPath = card.dataset.repositoryPath;
    const repository = repositoryChanges.find(function(item) { return item.repositoryPath === repositoryPath; }); if (!repository) return;
    const headerToggle = !button && event.target.closest('.repo-changes-header')
      && focusedRepositoryChangesPath === repositoryPath && !repositoryChangesCollapsed.has(repositoryPath);
    const action = button ? button.dataset.repoAction : headerToggle ? 'toggle' : 'select'; const node = repositoryChangesNodes.get(repositoryPath);
    if (action === 'folder') {
      const folder = button.closest('.repo-folder'); const key = folder.dataset.folderKey;
      if (repositoryFoldersCollapsed.has(key)) repositoryFoldersCollapsed.delete(key); else repositoryFoldersCollapsed.add(key);
      updateRepositoryFolderVisibility(folder); updateRepositoryPinnedHeaders(); return;
    }
    if (action === 'select') {
      repositoryChangesCollapsed.delete(repositoryPath);
      focusRepositoryChanges(repositoryPath);
      updateRepositoryChangesVisibility(node, repository);
      node.card.focus({ preventScroll: true });
      return;
    }
    if (action === 'toggle') {
      if (repositoryChangesCollapsed.has(repositoryPath)) repositoryChangesCollapsed.delete(repositoryPath); else repositoryChangesCollapsed.add(repositoryPath);
      if (repositoryChangesCollapsed.has(repositoryPath) && focusedRepositoryChangesPath === repositoryPath) {
        focusedRepositoryChangesPath = '';
        repositoryChangesNodes.forEach(function(node) { node.card.classList.remove('focused'); });
        // Clear immediately, then confirm through the authoritative repository-selection pipeline.
        selectedRepositoryPaths = []; selectedBranches = []; commits = []; workingTreeRowsState = [];
        selectedCommitHash = ''; selectedCommitRepositoryPath = ''; isCommitLoading = false;
        hasMoreCommits = false; isLoadingMoreCommits = false;
        render(); hideLoadingProgress(); updateCountLabel();
        vscode.postMessage({ type: 'repositoryChangesAction', action: 'blur', repositoryPath: repositoryPath });
      }
      if (!repositoryChangesCollapsed.has(repositoryPath)) focusRepositoryChanges(repositoryPath);
      updateRepositoryChangesVisibility(node, repository); return;
    }
    if (action === 'group') {
      const key = repositoryPath + '\u0000' + button.closest('.repo-group').dataset.section;
      if (repositoryGroupsCollapsed.has(key)) repositoryGroupsCollapsed.delete(key); else repositoryGroupsCollapsed.add(key);
      updateRepositoryChangesVisibility(node, repository); return;
    }
    if (action === 'menu') { const menu = card.querySelector('.repo-commit-menu'); menu.hidden = !menu.hidden; return; }
    if (['commit', 'amend', 'push', 'syncCommit'].includes(action)) { postRepositoryCommit(card, action); return; }
    if (action === 'worktree') {
      card.classList.remove('transitioning');
      repositoryChangesCollapsed.delete(repositoryPath);
      focusedRepositoryChangesPath = repositoryPath;
      repositoryChangesNodes.forEach(function(node, path) { node.card.classList.toggle('focused', path === repositoryPath); });
      updateRepositoryChangesVisibility(node, repository);
      vscode.postMessage({ type: 'repositoryChangesAction', action: 'worktree', repositoryPath: repositoryPath });
      return;
    }
    if (['syncRefresh', 'branch', 'terminal'].includes(action)) { vscode.postMessage({ type: 'repositoryChangesAction', action: action, repositoryPath: repositoryPath }); return; }
    if (action === 'continue' || action === 'abort') { vscode.postMessage({ type: 'repositoryChangesAction', action: action, repositoryPath: repositoryPath }); return; }
    const group = button.closest('.repo-group'); const section = group.dataset.section;
    const fileRow = button.closest('.repo-file-row'); const filePath = fileRow && fileRow.dataset.filePath;
    if (action === 'file') {
      card.classList.remove('transitioning');
      const diffKey = fileRow.dataset.diffKey;
      pendingRepositoryFileSelection = { repositoryPath: repositoryPath, diffKey: diffKey };
      pendingLocalFileSelectionPath = diffKey;
      if (selectedCommitRepositoryPath === repositoryPath) selectedPath = diffKey;
      syncRepositoryFileSelection(false, repositoryPath, diffKey);
      if (section === 'commit') vscode.postMessage({ type: 'selectFile', path: diffKey });
      else vscode.postMessage({ type: 'repositoryChangesFile', repositoryPath: repositoryPath, section: section, path: filePath });
      return;
    }
    const sectionFiles = repoChangesSections(repository).find(function(item) { return item.key === section; }).files;
    const paths = filePath ? [filePath] : sectionFiles.map(function(file) { return file.path; });
    vscode.postMessage({ type: 'repositoryChangesAction', repositoryPath: repositoryPath, action: action, section: section, paths: paths, untrackedPaths: sectionFiles.filter(function(file) { return file.isUntracked; }).map(function(file) { return file.path; }) });
  });
`;
