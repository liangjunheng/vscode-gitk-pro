/**
 * 选择器栏子面板: 承载 webview 顶部仓库/分支下拉、搜索框与工具栏的样式、结构与交互脚本。
 * 三段片段按原样迁移自 GitkViewProvider 的内联 webview; 脚本片段与宿主片段、
 * commitListSubPanel / changedFilesSubPanel 片段拼接在同一个 IIFE 内, 共享同一作用域。
 */

/** 选择器栏子面板的样式片段。 */
export const SELECTOR_BAR_SUB_PANEL_STYLES = `
  /* 仓库/分支选择器与提交列表标题合成一块, 合并为单行, 统一使用标题栏底色。 */
  #commitSelectors { display: flex; flex-direction: column; flex: 0 0 auto; position: sticky; top: 30px; left: 0; z-index: 4; min-width: 0; background: var(--commit-title-background); }
  .selector-row { display: flex; align-items: center; gap: 2px; min-width: 0; padding: 3px 10px; background: var(--commit-title-background); }
  #commitSelectors { border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  #commitSelectors button { border: none; cursor: pointer; border-radius: 2px; }
  .selector { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .selector-group { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0; }
  #branchSelector { flex: 0 1 auto; min-width: 0; }
  .repo-group { flex: 0 1 auto; min-width: 0; }
  /* @ 与两侧控件各留 6px（行间距 2px + 4px 外边距）。 */
  .selector-separator { flex: 0 0 auto; margin: 0 4px; color: var(--vscode-foreground); font-size: 11px; font-weight: 700; }
  /* Commit 面板入口位于变更列表标题栏的显示方式之前；无未提交仓库时隐藏。 */
  /* 徽标尺寸: 高 18、圆角 10、图标 11, 字号 11px, 左右内边距 4px。 */
  #filesActions .uncommitted-repo-group { display: flex; align-items: center; align-self: center; gap: 3.75px; flex: 0 0 auto; height: 18px; margin-left: 0; padding: 0 4px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 10px; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); font: inherit; font-size: 11px; font-weight: 600; line-height: 1; cursor: pointer; white-space: nowrap; }
  #filesActions .uncommitted-repo-group:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
  #filesActions .uncommitted-repo-group:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .uncommitted-repo-group .codicon { display: flex; align-items: center; font-size: 11px; line-height: 1; }
  .dropdown { position: relative; flex: 0 1 auto; min-width: 0; }
  #branchDropdown { width: 20ch; --branch-menu-font-family: var(--vscode-font-family, sans-serif); --branch-menu-font-size: var(--vscode-font-size, 13px); --branch-menu-line-height: normal; }
  #repositoryDisplay { display: flex; align-items: center; gap: 0; flex: 0 1 20ch; min-width: 0; height: 26px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); font: inherit; cursor: default; }
  #repositoryDisplay .dropdown-label { gap: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #repositoryDisplay .repository-icon { margin-right: 0; }
  .dropdown-current { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 4px; box-shadow: none; font: inherit; text-align: left; cursor: pointer; }
  .dropdown-current:has(.dropdown-spinner) { gap: 2px; }
  .dropdown-label:has(.dropdown-spinner:not([hidden])) { display: inline-flex; align-items: center; flex: 1 1 auto; gap: 2px; }
  #branchDropdown .branch-icon, #branchDropdown .dropdown-group > .codicon { display: inline-flex; align-self: center; align-items: center; justify-content: center; flex: 0 0 var(--vscode-font-size, 13px); width: var(--vscode-font-size, 13px); height: var(--vscode-font-size, 13px); margin: 0; font-size: var(--vscode-font-size, 13px); line-height: var(--vscode-font-size, 13px); color: var(--vscode-icon-foreground); }
  .branch-icon.codicon-target { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-icon-foreground)); }
  .branch-icon.codicon-cloud { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-icon-foreground)); }
  .branch-icon.codicon-device-desktop { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-icon-foreground)); }
  .dropdown-current:hover:not(:disabled), .dropdown.open .dropdown-current { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .dropdown-current:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dropdown-current:disabled { cursor: default; opacity: .6; }
  .dropdown-current[data-loading="true"] .dropdown-spinner { display: inline-block; }
  .dropdown-spinner { display: inline-block; width: 10px; height: 10px; flex: 0 0 auto; margin-right: 4px; border: 1.5px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: dropdown-spin .8s linear infinite; vertical-align: -1px; }
  @keyframes dropdown-spin { to { transform: rotate(360deg); } }
  .dropdown-label { display: flex; align-items: center; gap: 2px; flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; }
  .dropdown-value { min-width: 0; overflow: hidden; font: inherit; line-height: inherit; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-label .dropdown-spinner { display: inline-block; flex: 0 0 10px; width: 10px; height: 10px; margin-left: 4px; margin-right: 0; }
  .dropdown-label .dropdown-spinner[hidden] { display: none; }
  .repository-icon { display: inline-flex; align-self: center; flex: 0 0 auto; align-items: center; justify-content: center; width: 16px; height: 16px; margin: 0 4px 0 0; vertical-align: middle; color: var(--vscode-icon-foreground, currentColor); }
  .repository-icon.codicon { font-size: 16px; line-height: 16px; }
  .repository-icon.has-submodules { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-icon-foreground, currentColor)); }
  .dropdown-chevron { margin-left: auto; display: inline-flex; align-items: center; color: var(--vscode-descriptionForeground); }
  .dropdown-chevron svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .dropdown.open .dropdown-chevron { transform: rotate(180deg); }
  .dropdown-menu { position: absolute; top: calc(100% + 3px); left: 0; z-index: 20; display: none; flex-direction: column; width: max-content; min-width: 100%; max-width: calc(100vw - 20px); padding: 0; box-sizing: border-box; overflow: hidden; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; box-shadow: 0 2px 4px rgba(0, 0, 0, .24), 0 8px 18px rgba(0, 0, 0, .36); }
  .dropdown.open .dropdown-menu { display: flex; }
  .dropdown-filter { width: calc(100% - 10px); height: 25px; flex: 0 0 auto; margin: 5px 5px 4px; padding: 0 6px; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
  .dropdown-filter:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #branchDropdown .branch-options-viewport { position: relative; min-height: 0; flex: 0 0 auto; overflow: hidden; }
  #branchDropdown .branch-options-viewport > .dropdown-options { height: 100%; min-height: 0; padding: 0 5px; overflow-y: auto; }
  #branchDropdown .branch-options-viewport > .overlay-scroll-track.vertical { opacity: 1; pointer-events: auto; }
  .dropdown-progress { position: absolute; top: 0; right: 0; left: 0; z-index: 2; height: 2px; overflow: hidden; background: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  .dropdown-progress::before { content: ''; display: block; width: 35%; height: 100%; background: var(--vscode-progressBar-background); animation: dropdown-progress 1.1s ease-in-out infinite; }
  @keyframes dropdown-progress { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  .dropdown-option, .dropdown-group { width: 100%; min-height: 24px; padding: 4px 7px; box-sizing: border-box; overflow: hidden; border: 0; border-radius: 3px; font: inherit; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-option { color: inherit; background: transparent; cursor: pointer; }
  .dropdown-option:hover, .dropdown-option:focus-visible { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); outline: none; }
  .dropdown-option.selected::before { content: '✓'; display: inline-block; width: 14px; color: var(--vscode-menu-selectionForeground, var(--vscode-textLink-foreground)); }
  #branchDropdown .dropdown-option { display: flex; align-items: center; gap: 6px; font-family: var(--branch-menu-font-family); font-size: var(--branch-menu-font-size); font-style: normal; font-weight: 400; line-height: var(--branch-menu-line-height); }
  #branchDropdown .dropdown-option.selected::before { display: none; }
  #branchDropdown .dropdown-option input { flex: 0 0 auto; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); }
  .dropdown-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 42px; margin: 0; padding: 8px 7px; box-sizing: border-box; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
  .dropdown-actions-right { display: flex; align-items: center; gap: 6px; }
  #branchDropdown .dropdown-actions button { min-width: 52px; height: 26px; padding: 0 10px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground)); border: 1px solid transparent; border-radius: 6px; cursor: pointer; font-family: var(--branch-menu-font-family); font-size: var(--branch-menu-font-size); font-style: normal; font-weight: 400; line-height: var(--branch-menu-line-height); transition: background-color 120ms ease, border-color 120ms ease; }
  .dropdown-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .dropdown-actions button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .dropdown-actions .toggle-all { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; padding: 0 7px; background: transparent; }
  .dropdown-actions .toggle-all:hover, .dropdown-actions .toggle-all:active { background: transparent; }
  .dropdown-actions .toggle-all input { width: 13px; height: 13px; margin: 0; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); pointer-events: none; }
  #branchDropdown .dropdown-actions .confirm-selection { min-width: 46px; height: 24px; padding: 0 8px; border-color: var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  #branchDropdown .dropdown-actions .confirm-selection:hover { background: var(--vscode-button-hoverBackground); }
  #branchDropdown .dropdown-actions .cancel-selection { min-width: 0; height: 24px; padding: 0 4px; border-radius: 3px; color: var(--vscode-foreground); background: transparent; }
  #branchDropdown .dropdown-actions .cancel-selection:hover { background: var(--vscode-toolbar-hoverBackground); }
  .dropdown-group { padding-bottom: 1px; color: var(--vscode-descriptionForeground); cursor: default; }
  #branchDropdown .dropdown-group { display: flex; align-items: center; gap: 6px; position: sticky; top: 0; z-index: 1; min-height: 28px; margin-top: 5px; padding: 5px 7px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 0; background: var(--vscode-menu-background, var(--vscode-editor-background)); font-family: var(--branch-menu-font-family); font-size: var(--branch-menu-font-size); font-style: normal; font-weight: 400; line-height: var(--branch-menu-line-height); }
  #branchDropdown .dropdown-group:first-child { margin-top: 0; }
  #branchDropdown .dropdown-group[hidden], #branchDropdown .dropdown-option[hidden] { display: none; }
  .branch-group-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  #branchDropdown .dropdown-option { min-height: 28px; padding: 4px 8px; }
  .branch-option-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .branch-current-marker { flex: 0 0 auto; padding: 1px 5px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 3px; color: var(--vscode-descriptionForeground); }
  .dropdown-empty { padding: 8px 7px; color: var(--vscode-descriptionForeground); }
`;

/** 选择器栏子面板的结构片段。 */
export const SELECTOR_BAR_SUB_PANEL_MARKUP = `
  <div id="commitSelectors">
    <div class="selector-row">
      <div class="selector-group" id="branchSelector"><div class="dropdown" id="branchDropdown">
        <button class="dropdown-current" type="button" title="切换分支" aria-expanded="false" disabled><span class="dropdown-label"><span class="dropdown-spinner" hidden aria-hidden="true"></span>加载分支...</span><span class="dropdown-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span></button>
        <div class="dropdown-menu" role="menu"><input class="dropdown-filter" type="text" placeholder="筛选分支" aria-label="筛选分支"><div class="branch-options-viewport overlay-scroll-viewport"><div class="dropdown-options" id="branchOptions"></div><div class="overlay-scroll-track vertical" id="branchOptionsScrollbar" role="scrollbar" aria-label="滚动分支列表" aria-controls="branchOptions" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" tabindex="0" hidden><div class="overlay-scroll-thumb"></div></div></div><div class="dropdown-actions"><button type="button" class="toggle-all" aria-pressed="false"><input type="checkbox" tabindex="-1" aria-hidden="true"><span>全选</span></button><div class="dropdown-actions-right"><button type="button" class="confirm-selection">确定</button><button type="button" class="cancel-selection">取消</button></div></div></div>
      </div></div>
      <span class="selector-separator" aria-hidden="true">@</span>
      <div id="repositoryDisplay" title="未选择仓库"><span class="dropdown-label">未选择仓库</span></div>
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
  let selectedRepositoryPaths = [];
  let hasBranchStateSnapshot = false;
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
    repositoryDisplay.dataset.loading = loading ? 'true' : 'false';
    const label = repositoryDisplay.querySelector('.dropdown-label');
    let spinner = label.querySelector('.dropdown-spinner');
    if (!spinner) { spinner = document.createElement('span'); spinner.className = 'dropdown-spinner'; spinner.setAttribute('aria-hidden', 'true'); label.appendChild(spinner); }
    spinner.hidden = !loading;
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
        if (id === 'branchDropdown') {
          branchDropdown.openSelection = true;
          branchDropdown.selectionDirty = false;
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
        const visible = !query || (option.dataset.searchText || option.textContent).toLocaleLowerCase().includes(query);
        option.hidden = !visible;
        if (visible) visibleOptions++;
      });
      options.querySelectorAll('.dropdown-group').forEach(function(group) {
        let count = 0;
        for (let sibling = group.nextElementSibling; sibling && !sibling.classList.contains('dropdown-group'); sibling = sibling.nextElementSibling) {
          if (sibling.classList.contains('dropdown-option') && !sibling.hidden) count++;
        }
        group.hidden = count === 0;
      });
      let empty = options.querySelector('.dropdown-empty');
      if (!visibleOptions) {
        if (!empty) { empty = document.createElement('div'); empty.className = 'dropdown-empty'; empty.textContent = '未找到结果'; options.appendChild(empty); }
      } else if (empty) {
        empty.remove();
      }
      if (id === 'branchDropdown') updateDropdownHeight(branchDropdown);
    });
    return dropdown;
  }

  function updateDropdownHeight(dropdown) {
    const commitSection = document.getElementById('commitSection');
    const commitHeight = commitSection
      ? commitSection.getBoundingClientRect().height
      : Math.max(document.documentElement.clientHeight, document.body.clientHeight);
    const maximumMenuHeight = Math.floor(commitHeight * 2 / 3);
    dropdown.menu.style.maxHeight = maximumMenuHeight + 'px';
    if (dropdown.root.id !== 'branchDropdown') return;

    const viewport = dropdown.root.querySelector('.branch-options-viewport');
    const actions = dropdown.menu.querySelector('.dropdown-actions');
    if (!viewport || !actions) return;

    // The flex container has no intrinsic vertical budget. Give the option viewport an
    // explicit height so an overflowing list always has a real scroll range.
    viewport.style.height = 'auto';
    const filterStyle = getComputedStyle(dropdown.filter);
    const filterOuterHeight = dropdown.filter.offsetHeight + parseFloat(filterStyle.marginTop) + parseFloat(filterStyle.marginBottom);
    const availableOptionsHeight = Math.max(84, maximumMenuHeight - filterOuterHeight - actions.offsetHeight - 2);
    const optionHeight = Math.min(dropdown.options.scrollHeight, availableOptionsHeight);
    viewport.style.height = optionHeight + 'px';

    // Size to the widest actual menu label and action row, never below the trigger
    // and never beyond the viewport. This avoids width: max-content being defeated
    // by the flex labels' width: 100% rules.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;font:' + getComputedStyle(dropdown.options).font;
    document.body.appendChild(probe);
    let widestText = 0;
    dropdown.options.querySelectorAll('.branch-option-label, .branch-group-label').forEach(function(label) {
      probe.textContent = label.textContent || '';
      widestText = Math.max(widestText, probe.getBoundingClientRect().width);
    });
    probe.textContent = dropdown.filter.placeholder || '';
    widestText = Math.max(widestText, probe.getBoundingClientRect().width);
    probe.remove();
    const optionWidth = widestText + 72;
    // The action bar is stretched to the current menu width, so measure a cloned row
    // off-screen rather than feeding that stretched width back into the next render.
    const actionProbe = actions.cloneNode(true);
    actionProbe.style.cssText = 'position:absolute;visibility:hidden;display:inline-flex;width:max-content;pointer-events:none;';
    document.body.appendChild(actionProbe);
    const actionWidth = actionProbe.getBoundingClientRect().width;
    actionProbe.remove();
    const triggerWidth = dropdown.current.getBoundingClientRect().width;
    const viewportLimit = Math.max(triggerWidth, document.documentElement.clientWidth - 20);
    dropdown.menu.style.width = Math.min(viewportLimit, Math.max(triggerWidth, optionWidth, actionWidth)) + 'px';
  }

  function updateOpenDropdownHeights() {
    [branchDropdown].forEach(function(dropdown) {
      if (dropdown && dropdown.root.classList.contains('open')) updateDropdownHeight(dropdown);
    });
  }

  function closeDropdown(dropdown) {
    const wasOpen = dropdown.root.classList.contains('open');
    if (wasOpen && !dropdown.skipRestore && dropdown.restoreSelection) dropdown.restoreSelection();
    dropdown.skipRestore = false;
    dropdown.openSelection = false;
    dropdown.selectionDirty = false;
    dropdown.root.classList.remove('open');
    dropdown.current.setAttribute('aria-expanded', 'false');
  }

  function closeDropdowns() {
    if (branchDropdown) closeDropdown(branchDropdown);
  }

  const repositoryDisplay = document.getElementById('repositoryDisplay');
  const branchDropdown = createDropdown('branchDropdown', function() {});
  const branchOptionsViewport = document.querySelector('#branchDropdown .branch-options-viewport');
  const branchOptionsScrollbar = document.getElementById('branchOptionsScrollbar');
  if (branchOptionsViewport && branchOptionsScrollbar) installOverlayScrollbars(branchOptionsViewport, branchDropdown.options, [branchOptionsScrollbar]);
  const commitSectionResizeTarget = document.getElementById('commitSection');
  if (commitSectionResizeTarget && typeof ResizeObserver !== 'undefined') {
    const dropdownHeightObserver = new ResizeObserver(updateOpenDropdownHeights);
    dropdownHeightObserver.observe(commitSectionResizeTarget);
  }

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
    const loading = repositoryDisplay.dataset.loading === 'true';
    repositoryDisplay.querySelector('.dropdown-label').innerHTML = (repository
      ? repositoryIcon(repository.hasSubmodules, repository.isSubmodule) + '<span class="dropdown-value">' + escapeHtml(repository.label) + '</span>'
      : '<span class="dropdown-value">未选择仓库</span>') + '<span class="dropdown-spinner"' + (loading ? '' : ' hidden') + ' aria-hidden="true"></span>';
    repositoryDisplay.title = repository ? repository.path : '未选择仓库';
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

  function renderBranchOptions(entries, selectedValues) {
    const options = entries.filter(function(entry) { return !entry.group; });
    // 当前分支归入本地分组；全选状态和动作仍按唯一引用计算。
    const uniqueOptionValues = Array.from(new Set(options.map(function(entry) { return entry.value; })));
    // 持久化 selected Set, 避免 stateUpdate 重建时旧 change handler 引用过期 Set
    if (!branchDropdown.selected) branchDropdown.selected = new Set();
    const selected = branchDropdown.selected;
    // 分支列表未变时只更新 checkbox 状态, 不销毁 DOM (避免 stateUpdate 导致点击丢失)
    var existingInputs = branchDropdown.options.querySelectorAll('input[type="checkbox"]');
    const entriesKey = JSON.stringify(entries);
    var canUpdateInPlace = branchDropdown.entriesKey === entriesKey && existingInputs.length === options.length &&
      Array.from(existingInputs).every(function(input, i) { return input.value === options[i].value; });
    // 单纯打开弹窗不是草稿编辑：总分支列表可能先于最新选择快照到达。
    // 只有用户实际修改过勾选时才保留草稿，避免按钮和复选框停在不同快照。
    const keepPendingSelection = Boolean(branchDropdown.openSelection && branchDropdown.selectionDirty);
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
      applySelection(appliedSelection);
    };
    function bindBranchActions() {
      const toggleAll = branchDropdown.menu.querySelector('.toggle-all');
      const cancel = branchDropdown.menu.querySelector('.cancel-selection');
      const confirm = branchDropdown.menu.querySelector('.confirm-selection');
      toggleAll.onclick = function() {
        const allSelected = uniqueOptionValues.length > 0 && uniqueOptionValues.every(function(value) { return selected.has(value); });
        branchDropdown.selectionDirty = true;
        applySelection(allSelected ? [] : uniqueOptionValues);
      };
      cancel.onclick = function() { closeDropdown(branchDropdown); };
      confirm.onclick = function() {
        const confirmedValues = Array.from(selected);
        // Store 状态回传前不更新本地确认快照; 关闭后由 authoritative state snapshot 决定最终结果。
        branchDropdown.skipRestore = true;
        closeDropdown(branchDropdown);
        vscode.postMessage({ type: 'selectBranches', names: confirmedValues });
      };
    }
    if (canUpdateInPlace) {
      updateSelectionUi();
      bindBranchActions();
      branchDropdown.filter.dispatchEvent(new Event('input'));
      return;
    }
    branchDropdown.entriesKey = entriesKey;
    branchDropdown.options.innerHTML = '';
    entries.forEach(function(entry) {
      if (entry.group) {
        const group = document.createElement('div');
        group.className = 'dropdown-group';
        group.innerHTML = '<span class="codicon codicon-' + (entry.remoteName ? 'cloud' : 'git-branch') + '" aria-hidden="true"></span><span class="branch-group-label">' + escapeHtml(entry.group) + '</span>';
        branchDropdown.options.appendChild(group);
        return;
      }
      const option = document.createElement('label');
      option.className = 'dropdown-option' + (selected.has(entry.value) ? ' selected' : '');
      option.title = entry.title || entry.label;
      option.dataset.searchText = [entry.label, entry.title || '', entry.remoteName || ''].join(' ');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = entry.value;
      checkbox.checked = selected.has(entry.value);
      option.addEventListener('click', function(event) {
        if (event.target !== checkbox) event.preventDefault();
        branchDropdown.selectionDirty = true;
        if (selected.has(entry.value)) selected.delete(entry.value); else selected.add(entry.value);
        updateSelectionUi();
      });
      option.appendChild(checkbox);
      if (entry.kind) {
        option.insertAdjacentHTML('beforeend', branchIcon(entry.kind));
      }
      const name = document.createElement('span'); name.className = 'branch-option-label'; name.textContent = entry.label;
      option.appendChild(name);
      if (entry.kind === 'current') {
        const marker = document.createElement('span'); marker.className = 'branch-current-marker'; marker.textContent = '当前'; option.appendChild(marker);
      }
      branchDropdown.options.appendChild(option);
    });
    updateSelectionUi();
    bindBranchActions();
    branchDropdown.filter.dispatchEvent(new Event('input'));
  }

  function updateTotalRepositoryList(repositories, nextSelectedRepositoryPaths) {
    selectedRepositoryPaths = nextSelectedRepositoryPaths;
  }

  function updateTotalBranchesList(nextBranches) {
    // Before the first full state snapshot this seeds the selector during Webview startup.
    // Afterwards stateUpdate owns branches and selectedBranches as one atomic model; a late
    // list-only message must not overwrite another repository's options.
    if (hasBranchStateSnapshot) return;
    totalBranches = nextBranches.slice();
    renderTotalBranchOptions();
  }

  function renderTotalBranchOptions() {
    branchDropdown.root.hidden = false;
    const local = new Map();
    const remotes = new Map();
    totalBranches.forEach(function(branch) {
      if (branch.kind !== 'remote') {
        if (!local.has(branch.name) || branch.kind === 'current') local.set(branch.name, branch);
        return;
      }
      if (branch.name.endsWith('/HEAD')) return;
      const remoteRef = (branch.name.startsWith('refs/remotes/') ? branch.name.slice('refs/remotes/'.length) : branch.name);
      const remoteName = remoteRef.split('/')[0];
      if (!remotes.has(remoteName)) remotes.set(remoteName, new Map());
      remotes.get(remoteName).set(branch.name, branch);
    });
    const branchEntries = [];
    const tipTimestamp = function(branch) { return Number.isFinite(branch.tipTimestamp) ? branch.tipTimestamp : 0; };
    const byLatestTip = function(left, right) { return tipTimestamp(right) - tipTimestamp(left) || left.label.localeCompare(right.label); };
    if (local.size) {
      branchEntries.push({ group: '本地分支', count: local.size });
      Array.from(local.values()).sort(function(left, right) {
        return Number(right.kind === 'current') - Number(left.kind === 'current') || byLatestTip(left, right);
      }).forEach(function(branch) { branchEntries.push({ value: branch.name, label: branch.label, title: branch.name, kind: branch.kind }); });
    }
    const latestTip = function(remoteName) { return Array.from(remotes.get(remoteName).values()).reduce(function(latest, branch) { return Math.max(latest, tipTimestamp(branch)); }, 0); };
    Array.from(remotes.keys()).sort(function(left, right) { return latestTip(right) - latestTip(left) || left.localeCompare(right); }).forEach(function(remoteName) {
      const remoteBranches = Array.from(remotes.get(remoteName).values()).sort(byLatestTip);
      branchEntries.push({ group: '远程分支 · ' + remoteName, remoteName: remoteName, count: remoteBranches.length });
      remoteBranches.forEach(function(branch) {
        const label = (branch.name.startsWith('refs/remotes/') ? branch.name.slice('refs/remotes/'.length) : branch.name).slice(remoteName.length + 1);
        branchEntries.push({ value: branch.name, label: label, title: branch.name, kind: 'remote', remoteName: remoteName });
      });
    });
    renderBranchOptions(branchEntries, selectedBranches);
  }

  function renderSelectorState(msg) {
    hasBranchStateSnapshot = true;
    selectedRepositoryPaths = msg.selectedRepositoryPaths || [];
    selectedBranches = msg.selectedBranches || [];
    // stateUpdate contains the current repository's branch list and selection together.
    // Prefer it over a separately delivered list message so a late message cannot render
    // old repository options against the new repository's checked selection.
    totalBranches = Array.isArray(msg.branches) ? msg.branches.slice() : branches.slice();
    renderTotalBranchOptions();
  }

`;
