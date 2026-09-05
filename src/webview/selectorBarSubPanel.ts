/**
 * 选择器栏子面板: 承载 webview 顶部仓库/分支下拉、搜索框与工具栏的样式、结构与交互脚本。
 * 三段片段按原样迁移自 GitkViewProvider 的内联 webview; 脚本片段与宿主片段、
 * commitListSubPanel / changedFilesSubPanel 片段拼接在同一个 IIFE 内, 共享同一作用域。
 */

/** 选择器栏子面板的样式片段。 */
export const SELECTOR_BAR_SUB_PANEL_STYLES = `
  #header { display: flex; align-items: center; gap: 0; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; min-width: 0; }
  #header button { border: none; cursor: pointer; border-radius: 2px; }
  .selector { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .selector-group { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 8px; }
  .repo-group { padding-left: 0; border-right: 1px solid var(--vscode-panel-border); }
  #branchSelector { border-right: 1px solid var(--vscode-panel-border); }
  .search-group { padding-left: 0; border: 0; }
  .selector-prefix { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #header .uncommitted-repo-badge { flex: 0 0 16px; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: var(--vscode-button-background, #007acc); color: #fff; font: inherit; font-size: 9px; font-weight: 600; line-height: 16px; text-align: center; }
  .uncommitted-repo-badge:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
  .uncommitted-repo-badge[hidden] { display: none; }
  .dropdown { position: relative; flex: 0 1 auto; min-width: 0; }
  #repositoryDropdown, #branchDropdown { width: 20ch; }
  .dropdown-current { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
  .dropdown-current:has(.dropdown-spinner) { gap: 2px; }
  .dropdown-label:has(.dropdown-spinner) { display: inline-flex; align-items: center; flex: 1 1 auto; gap: 4px; }
  .dropdown-label .dropdown-spinner { margin-left: auto; margin-right: 0; }
  .dropdown-label .dropdown-spinner[hidden] { display: none; }
  .dropdown-current:hover:not(:disabled), .dropdown.open .dropdown-current { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .dropdown-current:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-current:disabled { cursor: default; opacity: .6; }
  .dropdown-current[data-loading="true"] .dropdown-spinner { display: inline-block; }
  .dropdown-spinner { display: inline-block; width: 10px; height: 10px; flex: 0 0 auto; margin-right: 4px; border: 1.5px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: dropdown-spin .8s linear infinite; vertical-align: -1px; }
  @keyframes dropdown-spin { to { transform: rotate(360deg); } }
  .dropdown-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repository-icon { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 16px; height: 16px; margin-right: 4px; vertical-align: -3px; color: var(--vscode-icon-foreground, currentColor); }
  .repository-icon.codicon { font-size: 16px; line-height: 16px; }
  .repository-icon.has-submodules { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-icon-foreground, currentColor)); }
  .dropdown-chevron { margin-left: auto; display: inline-flex; align-items: center; color: var(--vscode-descriptionForeground); }
  .dropdown-chevron svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .dropdown.open .dropdown-chevron { transform: rotate(180deg); }
  .dropdown-menu { position: absolute; top: calc(100% + 3px); left: 0; z-index: 20; display: none; flex-direction: column; width: max(100%, 190px); padding: 5px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
  .dropdown.open .dropdown-menu { display: flex; }
  .dropdown-filter { width: 100%; height: 25px; flex: 0 0 auto; margin-bottom: 4px; padding: 0 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; font-size: 11px; }
  .dropdown-filter:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-options { min-height: 0; flex: 1 1 auto; overflow-y: auto; }
  .dropdown-progress { position: absolute; top: 0; right: 0; left: 0; z-index: 2; height: 2px; overflow: hidden; background: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  .dropdown-progress::before { content: ''; display: block; width: 35%; height: 100%; background: var(--vscode-progressBar-background); animation: dropdown-progress 1.1s ease-in-out infinite; }
  @keyframes dropdown-progress { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  .dropdown-option, .dropdown-group { width: 100%; min-height: 24px; padding: 4px 7px; overflow: hidden; border: 0; border-radius: 3px; font: inherit; font-size: 11px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-option { color: inherit; background: transparent; cursor: pointer; }
  .dropdown-option:hover, .dropdown-option:focus-visible { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); outline: none; }
  .dropdown-option.selected::before { content: '✓'; display: inline-block; width: 14px; color: var(--vscode-menu-selectionForeground, var(--vscode-textLink-foreground)); }
  #repositoryDropdown .dropdown-option, #branchDropdown .dropdown-option { display: flex; align-items: center; gap: 6px; }
  #repositoryDropdown .dropdown-option.selected::before, #branchDropdown .dropdown-option.selected::before { display: none; }
  #repositoryDropdown .dropdown-option input { display: none; }
  #branchDropdown .dropdown-option input { flex: 0 0 auto; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); }
  .dropdown-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 2px 1px; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
  .dropdown-actions-right { display: flex; align-items: center; gap: 6px; }
  .dropdown-actions button { min-width: 52px; height: 26px; padding: 0 10px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground)); border: 1px solid transparent; border-radius: 6px; cursor: pointer; font: inherit; font-size: 11px; transition: background-color 120ms ease, border-color 120ms ease; }
  .dropdown-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .dropdown-actions button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .dropdown-actions .toggle-all { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; padding: 0 7px; background: transparent; }
  .dropdown-actions .toggle-all:hover, .dropdown-actions .toggle-all:active { background: transparent; }
  .dropdown-actions .toggle-all input { width: 13px; height: 13px; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); pointer-events: none; }
  .dropdown-actions .confirm-selection, .dropdown-actions .cancel-selection { min-width: 35px; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 10px; }
  .dropdown-actions .confirm-selection { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .dropdown-actions .confirm-selection:hover { background: var(--vscode-button-hoverBackground); }
  .dropdown-group { padding-bottom: 1px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; cursor: default; }
  .dropdown-empty { padding: 8px 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  #toolbarActions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .toolbar-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; }
  .toolbar-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .toolbar-icon .codicon { font-size: 16px; line-height: 16px; }
  .toolbar-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .toolbar-icon.refresh-unchanged { animation: refresh-unchanged 550ms ease-out; }
  @keyframes refresh-unchanged { 0%, 100% { color: var(--vscode-icon-foreground); } 45% { color: var(--vscode-descriptionForeground); } }
  #header .count { opacity: 0.7; font-size: 11px; white-space: nowrap; }
  #searchBox { display: flex; align-items: center; position: relative; }
  #searchInput { width: 150px; padding: 3px 22px 3px 24px; font-size: 12px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, inherit); border-radius: 4px; transition: border-color 0.15s, box-shadow 0.15s; }
  #searchInput:focus { outline: none; border-color: var(--vscode-focusBorder, #007acc); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc); }
  #searchInput::placeholder { color: var(--vscode-inputPlaceholderForeground, #888); }
  #searchIcon { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; opacity: 0.5; pointer-events: none; color: var(--vscode-input-foreground, inherit); }
  #searchClear { position: absolute; right: 4px; top: 0; bottom: 0; margin: auto 0; width: 16px; height: 16px; border: none; background: transparent; color: var(--vscode-descriptionForeground, #888); cursor: pointer; display: none; font-size: 14px; line-height: 16px; padding: 0; border-radius: 3px; align-items: center; justify-content: center; }
  #searchClear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-input-foreground, inherit); }
  #searchClear.visible { display: flex; }
`;

/** 选择器栏子面板的结构片段。 */
export const SELECTOR_BAR_SUB_PANEL_MARKUP = `
  <div id="header">
    <div class="selector-group repo-group"><span class="selector-prefix">repo:</span><div class="dropdown" id="repositoryDropdown">
      <button class="dropdown-current" type="button" title="切换仓库或子仓库" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>未选择仓库</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选仓库" aria-label="筛选仓库"><div class="dropdown-options"></div></div>
    </div><button class="uncommitted-repo-badge" id="uncommittedRepoBadge" title="Git - 0 个仓库有未提交文件" aria-label="打开存在未提交文件的仓库" hidden>0</button></div>
    <div class="selector-group" id="branchSelector"><span class="selector-prefix">branchs:</span><div class="dropdown" id="branchDropdown">
      <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>加载分支...</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
      <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选分支" aria-label="筛选分支"><div class="dropdown-options"></div><div class="dropdown-actions"><button type="button" class="toggle-all" aria-pressed="false"><input type="checkbox" tabindex="-1" aria-hidden="true"><span>全选</span></button><div class="dropdown-actions-right"><button type="button" class="confirm-selection">确定</button><button type="button" class="cancel-selection">取消</button></div></div></div>
    </div></div>
    <div class="selector-group search-group"><div class="selector" id="searchBox"><svg id="searchIcon" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 .96-.96l3.04 3.03-1.06 1.06-2.94-3.13z"/></svg><input type="text" id="searchInput" placeholder="搜索提交..." title="输入关键词搜索, 支持作者/邮箱/消息/Hash/日期, 多个关键词用空格隔开, 回车开始搜索"><button id="searchClear" title="清除搜索">&times;</button></div><span class="count" id="countLabel"></span><button class="toolbar-icon" id="refreshBtn" title="刷新提交" aria-label="刷新提交"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6A5 5 0 1 0 13 10M13 2v4H9"/></svg></button></div>
    <div id="toolbarActions">
      <button class="toolbar-icon" id="fetchBtn" title="Fetch" aria-label="Fetch"><span class="codicon codicon-repo-fetch" aria-hidden="true"></span></button>
      <button class="toolbar-icon" id="pullBtn" title="Pull" aria-label="Pull"><span class="codicon codicon-repo-pull" aria-hidden="true"></span></button>
      <button class="toolbar-icon" id="pushBtn" title="Push" aria-label="Push"><span class="codicon codicon-repo-push" aria-hidden="true"></span></button>
    </div>
  </div>
`;

/** 选择器栏子面板的交互脚本片段。 */
export const SELECTOR_BAR_SUB_PANEL_SCRIPT = `
  let branches = [];
  let totalBranches = [];
  let selectedBranches = [];
  let uncommittedEnabled = false;
  let stagedCount = 0;
  let changesCount = 0;
  let repositoryEntries = [];
  let selectedRepositoryPaths = [];
  function updateDropdownLoading(dropdown, loading, ariaLabel) {
    const progress = dropdown.options.querySelector('.dropdown-progress');
    dropdown.current.dataset.loading = loading ? 'true' : 'false';
    let spinner = dropdown.current.querySelector('.dropdown-spinner');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'dropdown-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      dropdown.current.querySelector('.dropdown-label').appendChild(spinner);
    }
    spinner.hidden = !loading;
    if (loading) {
      if (!progress) {
        const nextProgress = document.createElement('div');
        nextProgress.className = 'dropdown-progress';
        nextProgress.setAttribute('aria-label', ariaLabel);
        dropdown.options.insertBefore(nextProgress, dropdown.options.firstChild);
      }
    } else if (progress) {
      progress.remove();
    }
  }
  function updateRepositoryLoading(loading) {
    updateDropdownLoading(repositoryDropdown, loading, '正在加载仓库');
  }
  function updateBranchLoading(loading) {
    updateDropdownLoading(branchDropdown, loading, '正在加载分支');
  }
  document.getElementById('refreshBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('uncommittedRepoBadge').addEventListener('click', function() {
    vscode.postMessage({ type: 'openCommitPanel' });
  });
  document.addEventListener('animationend', function(event) {
    var target = event.target;
    if (target && target.id === 'refreshBtn') target.classList.remove('refresh-unchanged');
  });
  document.addEventListener('animationcancel', function(event) {
    var target = event.target;
    if (target && target.id === 'refreshBtn') target.classList.remove('refresh-unchanged');
  });
  ['fetch', 'pull', 'push'].forEach(function(action) {
    document.getElementById(action + 'Btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'gitSync', action: action });
    });
  });
  var searchDebounceTimer = null;
  function triggerSearch() {
    var input = document.getElementById('searchInput');
    vscode.postMessage({ type: 'search', keywords: input.value });
  }
  function debounceSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function() {
      searchDebounceTimer = null;
      triggerSearch();
    }, 500);
  }
  function triggerSearchImmediately() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    triggerSearch();
  }
  document.getElementById('searchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerSearchImmediately();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.value = '';
      document.getElementById('searchClear').classList.remove('visible');
      triggerSearchImmediately();
    }
  });
  document.getElementById('searchInput').addEventListener('input', function() {
    var clearBtn = document.getElementById('searchClear');
    if (this.value.length > 0) { clearBtn.classList.add('visible'); } else { clearBtn.classList.remove('visible'); }
    debounceSearch();
  });
  document.getElementById('searchClear').addEventListener('click', function() {
    var input = document.getElementById('searchInput');
    input.value = '';
    input.focus();
    this.classList.remove('visible');
    triggerSearchImmediately();
  });
  function createDropdown(id, onSelect) {
    const root = document.getElementById(id);
    const current = root.querySelector('.dropdown-current');
    const label = root.querySelector('.dropdown-label');
    const filter = root.querySelector('.dropdown-filter');
    const options = root.querySelector('.dropdown-options');
    const menu = root.querySelector('.dropdown-menu');
    const dropdown = { root: root, current: current, label: label, menu: menu, filter: filter, options: options, onSelect: onSelect };
    current.addEventListener('click', function() {
      if (current.disabled) return;
      const opening = !root.classList.contains('open');
      closeDropdowns();
      if (opening) {
        if (root === branchDropdown) {
          // 每次打开都以已确认选择重置弹窗草稿。
          const applied = branchDropdown.appliedSelection || new Set();
          branchDropdown.selected.clear();
          applied.forEach(function(value) { branchDropdown.selected.add(value); });
        }
        root.classList.add('open');
        updateDropdownHeight(dropdown);
        current.setAttribute('aria-expanded', 'true');
        filter.value = '';
        filter.dispatchEvent(new Event('input'));
        filter.focus();
      }
    });
    filter.addEventListener('input', function() {
      const query = filter.value.trim().toLocaleLowerCase();
      let visibleOptions = 0;
      options.querySelectorAll('.dropdown-option').forEach(function(option) {
        const visible = !query || option.textContent.toLocaleLowerCase().includes(query);
        option.hidden = !visible;
        if (visible) visibleOptions++;
      });
      let empty = options.querySelector('.dropdown-empty');
      if (!visibleOptions) {
        if (!empty) { empty = document.createElement('div'); empty.className = 'dropdown-empty'; empty.textContent = '未找到结果'; options.appendChild(empty); }
      } else if (empty) {
        empty.remove();
      }
    });
    return dropdown;
  }

  function updateDropdownHeight(dropdown) {
    const panelHeight = Math.max(document.documentElement.clientHeight, document.body.clientHeight);
    dropdown.menu.style.maxHeight = Math.floor(panelHeight * 3 / 4) + 'px';
  }

  function updateOpenDropdownHeights() {
    [repositoryDropdown, branchDropdown].forEach(function(dropdown) {
      if (dropdown && dropdown.root.classList.contains('open')) updateDropdownHeight(dropdown);
    });
  }

  function closeDropdown(dropdown) {
    const wasOpen = dropdown.root.classList.contains('open');
    if (wasOpen && !dropdown.skipRestore && dropdown.restoreSelection) dropdown.restoreSelection();
    dropdown.skipRestore = false;
    dropdown.root.classList.remove('open');
    dropdown.current.setAttribute('aria-expanded', 'false');
  }

  function closeDropdowns() {
    if (repositoryDropdown) closeDropdown(repositoryDropdown);
    if (branchDropdown) closeDropdown(branchDropdown);
  }

  const repositoryDropdown = createDropdown('repositoryDropdown', function() {});
  const branchDropdown = createDropdown('branchDropdown', function() {});

  document.addEventListener('click', function(event) {
    if (!event.target.closest('.dropdown')) closeDropdowns();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      closeDropdowns();
    }
  });
  function selectedLabel(entries, selectedValues, emptyLabel, allLabel) {
    const selected = new Set(selectedValues || []);
    const seen = new Set();
    const selectedEntries = [];
    entries.forEach(function(entry) {
      if (selected.has(entry.value) && !seen.has(entry.value)) { seen.add(entry.value); selectedEntries.push(entry); }
    });
    const uniqueCount = new Set(entries.map(function(entry) { return entry.value; })).size;
    if (uniqueCount > 0 && seen.size === uniqueCount) return allLabel;
    const label = selectedEntries.map(function(entry) { return entry.label; }).join(', ') || emptyLabel;
    return label.length > 20 ? label.slice(0, 20) + '...' : label;
  }

  function selectedTitle(entries, selectedValues, emptyLabel) {
    const selected = new Set(selectedValues || []);
    const seen = new Set();
    const selectedEntries = [];
    entries.forEach(function(entry) {
      if (selected.has(entry.value) && !seen.has(entry.value)) { seen.add(entry.value); selectedEntries.push(entry); }
    });
    return selectedEntries.map(function(entry) { return entry.label; }).join(', ') || emptyLabel;
  }

  // 包含子仓库的仓库和独立仓库均用状态栏同款 codicon-repo；仅叶子子仓库用 codicon-archive。
  function repositoryIcon(hasSubmodules, isSubmodule) {
    const icon = !hasSubmodules && isSubmodule ? 'archive' : 'repo';
    const parentClass = hasSubmodules ? ' has-submodules' : '';
    return '<span class="repository-icon codicon codicon-' + icon + parentClass + '" aria-hidden="true"></span>';
  }
  function updateSelectedRepoDisplay(repository) {
    const loading = repositoryDropdown.current.dataset.loading === 'true';
    repositoryDropdown.current.disabled = !repository;
    repositoryDropdown.label.innerHTML = (repository
      ? repositoryIcon(repository.hasSubmodules, repository.isSubmodule) + escapeHtml(repository.label)
      : '未选择仓库') + '<span class="dropdown-spinner"' + (loading ? '' : ' hidden') + ' aria-hidden="true"></span>';
    repositoryDropdown.current.title = repository ? repository.path : '未选择仓库';
  }
  function updateSelectedBranchDisplay(display) {
    // 是否置灰只由完整分支列表是否为空决定，不能由当前选中分支决定。
    const loading = branchDropdown.current.dataset.loading === 'true';
    branchDropdown.current.disabled = totalBranches.length === 0;
    branchDropdown.label.innerHTML = escapeHtml(display ? display.label : '未选择分支')
      + '<span class="dropdown-spinner"' + (loading ? '' : ' hidden') + ' aria-hidden="true"></span>';
    branchDropdown.current.title = display ? display.title : '未选择分支';
  }
  function renderRepositoryOptions(entries, selectedValues) {
    const selectedValue = (selectedValues || []).find(function(value) {
      return entries.some(function(entry) { return entry.value === value; });
    }) || '';
    repositoryDropdown.options.innerHTML = '';
    entries.forEach(function(entry) {
      const option = document.createElement('label');
      const checked = entry.value === selectedValue;
      option.className = 'dropdown-option' + (checked ? ' selected' : '');
      option.title = entry.title || entry.label;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'repository';
      radio.value = entry.value;
      radio.checked = checked;
      radio.addEventListener('change', function() {
        if (!radio.checked) return;
        repositoryDropdown.options.querySelectorAll('.dropdown-option').forEach(function(item) {
          item.classList.toggle('selected', item === option);
        });
        closeDropdown(repositoryDropdown);
        // 先让浏览器提交仓库阶段这一帧，再通知扩展端；否则同步代码会在首次绘制前切到分支阶段。
        requestAnimationFrame(function() {
          updateBranchLoading(true);
          vscode.postMessage({ type: 'selectRepositories', paths: [entry.value] });
        });
      });
      option.appendChild(radio);
      option.insertAdjacentHTML('beforeend', repositoryIcon(entry.hasSubmodules, entry.isSubmodule));
      option.appendChild(document.createTextNode(entry.label));
      repositoryDropdown.options.appendChild(option);
    });
  }

  function renderBranchOptions(entries, selectedValues) {
    const options = entries.filter(function(entry) { return !entry.group; });
    // 当前分支会同时出现在本地分支分组；全选状态和动作均按唯一引用计算。
    const uniqueOptionValues = Array.from(new Set(options.map(function(entry) { return entry.value; })));
    // 持久化 selected Set, 避免 stateUpdate 重建时旧 change handler 引用过期 Set
    if (!branchDropdown.selected) branchDropdown.selected = new Set();
    const selected = branchDropdown.selected;
    // 分支列表未变时只更新 checkbox 状态, 不销毁 DOM (避免 stateUpdate 导致点击丢失)
    var existingInputs = branchDropdown.options.querySelectorAll('input[type="checkbox"]');
    var canUpdateInPlace = existingInputs.length === options.length &&
      Array.from(existingInputs).every(function(input, i) { return input.value === options[i].value; });
    const serverSelection = (selectedValues || []).slice().sort().join('\0');
    // 弹窗打开期间，无论选项 DOM 是否因状态刷新重建，都保留打开前快照及未确认的选择。
    const keepPendingSelection = Boolean(branchDropdown.openSelection) || (branchDropdown.pendingSelection && branchDropdown.pendingSelection !== serverSelection);
    if (!keepPendingSelection) {
      selected.clear();
      (selectedValues || []).forEach(function(v) { selected.add(v); });
      branchDropdown.appliedSelection = new Set(selected);
      branchDropdown.pendingSelection = undefined;
    }
    function updateSelectionUi() {
      branchDropdown.options.querySelectorAll('input').forEach(function(checkbox) {
        checkbox.checked = selected.has(checkbox.value);
        checkbox.parentElement.classList.toggle('selected', checkbox.checked);
      });
      const toggleAll = branchDropdown.menu.querySelector('.toggle-all');
      const toggleAllCheckbox = toggleAll && toggleAll.querySelector('input[type="checkbox"]');
      const allSelected = uniqueOptionValues.length > 0 && uniqueOptionValues.every(function(value) { return selected.has(value); });
      if (toggleAll) toggleAll.setAttribute('aria-pressed', String(allSelected));
      if (toggleAllCheckbox) {
        toggleAllCheckbox.checked = allSelected;
        toggleAllCheckbox.indeterminate = false;
      }
    }
    function applySelection(values) {
      selected.clear();
      values.forEach(function(value) { selected.add(value); });
      updateSelectionUi();
    }
    branchDropdown.restoreSelection = function() {
      // 非确认关闭时，草稿无条件回到最后一次已应用选择。
      const appliedSelection = Array.from(branchDropdown.appliedSelection || []);
      branchDropdown.pendingSelection = undefined;
      applySelection(appliedSelection);
    };
    function bindBranchActions() {
      const toggleAll = branchDropdown.menu.querySelector('.toggle-all');
      const cancel = branchDropdown.menu.querySelector('.cancel-selection');
      const confirm = branchDropdown.menu.querySelector('.confirm-selection');
      toggleAll.onclick = function() {
        const allSelected = uniqueOptionValues.length > 0 && uniqueOptionValues.every(function(value) { return selected.has(value); });
        applySelection(allSelected ? [] : uniqueOptionValues);
      };
      cancel.onclick = function() { closeDropdown(branchDropdown); };
      confirm.onclick = function() {
        const confirmedValues = Array.from(selected);
        branchDropdown.pendingSelection = confirmedValues.sort().join('\0');
        // Store 状态回传前不更新本地确认快照，避免未被扩展端接受的草稿污染回滚基准。
        branchDropdown.skipRestore = true;
        closeDropdown(branchDropdown);
        vscode.postMessage({ type: 'selectBranches', names: confirmedValues });
      };
    }
    if (canUpdateInPlace) {
      updateSelectionUi();
      bindBranchActions();
      return;
    }
    branchDropdown.options.innerHTML = '';
    entries.forEach(function(entry) {
      if (entry.group) {
        const group = document.createElement('div');
        group.className = 'dropdown-group';
        group.textContent = entry.group;
        branchDropdown.options.appendChild(group);
        return;
      }
      const option = document.createElement('label');
      option.className = 'dropdown-option' + (selected.has(entry.value) ? ' selected' : '');
      option.title = entry.title || entry.label;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = entry.value;
      checkbox.checked = selected.has(entry.value);
      checkbox.addEventListener('change', function() {
        if (checkbox.checked) selected.add(entry.value); else selected.delete(entry.value);
        updateSelectionUi();
      });
      option.appendChild(checkbox);
      option.appendChild(document.createTextNode(entry.label));
      branchDropdown.options.appendChild(option);
    });
    updateSelectionUi();
    bindBranchActions();
  }

  function updateTotalRepositoryList(repositories, nextSelectedRepositoryPaths) {
    selectedRepositoryPaths = nextSelectedRepositoryPaths;
    repositoryEntries = repositories.map(function(repo) {
      return {
        value: repo.path, label: repo.label, title: repo.path, path: repo.path,
        hasSubmodules: Boolean(repo.hasSubmodules),
        isSubmodule: Array.isArray(repo.ancestry) && repo.ancestry.length > 0,
      };
    });
    renderRepositoryOptions(repositoryEntries, selectedRepositoryPaths);
  }

  function updateTotalBranchesList(nextBranches) {
    totalBranches = nextBranches.slice();
    renderTotalBranchOptions();
  }

  function renderTotalBranchOptions() {
    branchDropdown.root.hidden = false;
    const currentBranches = totalBranches.filter(function(branch) { return branch.kind === 'current'; });
    const localBranches = totalBranches.filter(function(branch) { return branch.kind === 'local'; });
    const remoteBranches = totalBranches.filter(function(branch) { return branch.kind === 'remote'; });
    const branchEntries = [];
    if (currentBranches.length) {
      branchEntries.push({ group: '当前分支' });
      currentBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    if (localBranches.length) {
      branchEntries.push({ group: '本地分支' });
      localBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    if (remoteBranches.length) {
      branchEntries.push({ group: '远程分支' });
      remoteBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name }); });
    }
    renderBranchOptions(branchEntries, selectedBranches);
  }

  function renderSelectorState(msg) {
    selectedRepositoryPaths = msg.selectedRepositoryPaths || [];
    selectedBranches = msg.selectedBranches || [];
    renderRepositoryOptions(repositoryEntries, selectedRepositoryPaths);
    renderTotalBranchOptions();
  }

`;
