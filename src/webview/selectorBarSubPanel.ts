/**
 * 选择器栏子面板: 承载 webview 顶部仓库/分支下拉、搜索框与工具栏的样式、结构与交互脚本。
 * 三段片段按原样迁移自 GitkViewProvider 的内联 webview; 脚本片段与宿主片段、
 * commitListSubPanel / changedFilesSubPanel 片段拼接在同一个 IIFE 内, 共享同一作用域。
 */

/** 选择器栏子面板的样式片段。 */
export const SELECTOR_BAR_SUB_PANEL_STYLES = `
  /* 仓库/分支选择器与提交列表标题合成一块, 合并为单行, 统一使用标题栏底色。 */
  #commitSelectors { display: flex; flex-direction: column; flex: 0 0 auto; min-width: 0; background: var(--commit-title-background); }
  .selector-row { display: flex; align-items: center; gap: 2px; min-width: 0; padding: 3px 10px; background: var(--commit-title-background); }
  #commitSelectors { border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  #commitSelectors button { border: none; cursor: pointer; border-radius: 2px; }
  .selector { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .selector-group { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0; }
  #branchSelector { flex: 0 1 auto; min-width: 0; }
  .repo-group { flex: 0 1 auto; min-width: 0; }
  /* 分支@仓库之间保留 2px 间距, 分隔符使用不透明的加粗前景色。 */
  .selector-separator { flex: 0 0 auto; color: var(--vscode-foreground); font-size: 11px; font-weight: 700; }
  /* 打开 Commit 面板 与 未提交仓库计数 合成一个可点击组: 整块都可点, 不再只有数字徽标。常驻 repo 行末尾, 无未提交时显示 0。 */
  /* 徽标尺寸: 高 18、圆角 10、图标 11, 字号 11px, 左右内边距 4px。 */
  #commitSelectors .uncommitted-repo-group { display: flex; align-items: center; align-self: center; gap: 3.75px; flex: 0 0 auto; height: 18px; margin-left: 0; padding: 0 4px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 10px; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); font: inherit; font-size: 11px; font-weight: 600; line-height: 1; cursor: pointer; white-space: nowrap; }
  #commitSelectors .uncommitted-repo-group:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
  #commitSelectors .uncommitted-repo-group:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .uncommitted-repo-group .codicon { display: flex; align-items: center; font-size: 11px; line-height: 1; }
  .dropdown { position: relative; flex: 0 1 auto; min-width: 0; }
  #repositoryDropdown, #branchDropdown { width: 20ch; }
  .dropdown-current { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 4px; box-shadow: none; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
  .dropdown-current:has(.dropdown-spinner) { gap: 2px; }
  .dropdown-label:has(.dropdown-spinner) { display: inline-flex; align-items: center; flex: 1 1 auto; gap: 4px; }
  .branch-icon { display: inline-flex; align-self: center; align-items: center; justify-content: center; flex: 0 0 14px; width: 14px; height: 14px; margin: 0; font-size: 13px; line-height: 1; color: var(--vscode-icon-foreground); }
  .branch-icon.codicon-target { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-icon-foreground)); font-size: 12px; }
  .branch-icon.codicon-cloud { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-icon-foreground)); }
  .branch-icon.codicon-device-desktop { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-icon-foreground)); font-size: 12px; }
  .dropdown-current:hover:not(:disabled), .dropdown.open .dropdown-current { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .dropdown-current:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-current:disabled { cursor: default; opacity: .6; }
  .dropdown-current[data-loading="true"] .dropdown-spinner { display: inline-block; }
  .dropdown-spinner { display: inline-block; width: 10px; height: 10px; flex: 0 0 auto; margin-right: 4px; border: 1.5px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: dropdown-spin .8s linear infinite; vertical-align: -1px; }
  @keyframes dropdown-spin { to { transform: rotate(360deg); } }
  .dropdown-label { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; }
  .dropdown-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-label .dropdown-spinner { display: inline-block; flex: 0 0 10px; width: 10px; height: 10px; margin-left: 4px; margin-right: 0; }
  .dropdown-label .dropdown-spinner[hidden] { display: none; }
  .repository-icon { display: inline-flex; align-self: center; flex: 0 0 auto; align-items: center; justify-content: center; width: 16px; height: 16px; margin: 0 4px 0 0; vertical-align: middle; color: var(--vscode-icon-foreground, currentColor); }
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
  /* 仓库选项的 radio 被隐藏, 必须显式补回选中态(✓ + 菜单选中底色), 否则切换仓库后看不出当前是哪个仓库。 */
  #repositoryDropdown .dropdown-option.selected::before { display: inline-block; }
  #repositoryDropdown .dropdown-option.selected { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
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
`;

/** 选择器栏子面板的结构片段。 */
export const SELECTOR_BAR_SUB_PANEL_MARKUP = `
  <div id="commitSelectors">
    <div class="selector-row">
      <div class="selector-group" id="branchSelector"><div class="dropdown" id="branchDropdown">
        <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>加载分支...</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
        <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选分支" aria-label="筛选分支"><div class="dropdown-options"></div><div class="dropdown-actions"><button type="button" class="toggle-all" aria-pressed="false"><input type="checkbox" tabindex="-1" aria-hidden="true"><span>全选</span></button><div class="dropdown-actions-right"><button type="button" class="confirm-selection">确定</button><button type="button" class="cancel-selection">取消</button></div></div></div>
      </div></div>
      <span class="selector-separator" aria-hidden="true">@</span>
      <div class="selector-group repo-group"><div class="dropdown" id="repositoryDropdown">
        <button class="dropdown-current" type="button" title="切换仓库或子仓库" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>未选择仓库</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
        <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选仓库" aria-label="筛选仓库"><div class="dropdown-options"></div></div>
      </div></div>
      <button class="uncommitted-repo-group" id="uncommittedRepoBadge" title="打开 Commit 面板" aria-label="打开存在未提交文件的仓库"><span class="codicon codicon-source-control" aria-hidden="true"></span><span class="uncommitted-repo-count">0</span></button>
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
  document.getElementById('uncommittedRepoBadge').addEventListener('click', function() {
    vscode.postMessage({ type: 'openCommitPanel' });
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
  function branchIcon(kind) {
    const icon = kind === 'current' ? 'target' : kind === 'remote' ? 'cloud' : 'device-desktop';
    return '<span class="branch-icon codicon codicon-' + icon + '" aria-hidden="true"></span>';
  }
  function updateSelectedRepoDisplay(repository) {
    const loading = repositoryDropdown.current.dataset.loading === 'true';
    repositoryDropdown.current.disabled = !repository;
    repositoryDropdown.label.innerHTML = (repository
      ? repositoryIcon(repository.hasSubmodules, repository.isSubmodule) + '<span class="dropdown-value">' + escapeHtml(repository.label) + '</span>'
      : '<span class="dropdown-value">未选择仓库</span>') + '<span class="dropdown-spinner"' + (loading ? '' : ' hidden') + ' aria-hidden="true"></span>';
    repositoryDropdown.current.title = repository ? repository.path : '未选择仓库';
  }
  function updateSelectedBranchDisplay(display) {
    // 是否置灰只由完整分支列表是否为空决定，不能由当前选中分支决定。
    const loading = branchDropdown.current.dataset.loading === 'true';
    branchDropdown.current.disabled = totalBranches.length === 0;
    const displayIcon = display && display.kind ? branchIcon(display.kind) : '';
    branchDropdown.label.innerHTML = displayIcon + '<span class="dropdown-value">' + escapeHtml(display ? display.label : '未选择分支') + '</span>'
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
      option.addEventListener('click', function(event) {
        event.preventDefault();
        radio.checked = true;
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
      option.addEventListener('click', function(event) {
        event.preventDefault();
        if (selected.has(entry.value)) selected.delete(entry.value); else selected.add(entry.value);
        updateSelectionUi();
      });
      option.appendChild(checkbox);
      if (entry.kind) {
        option.insertAdjacentHTML('beforeend', branchIcon(entry.kind));
      }
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
      currentBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name, kind: 'current' }); });
    }
    if (localBranches.length) {
      branchEntries.push({ group: '本地分支' });
      localBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name, kind: 'local' }); });
    }
    if (remoteBranches.length) {
      branchEntries.push({ group: '远程分支' });
      remoteBranches.forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name, kind: 'remote' }); });
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
