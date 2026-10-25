/**
 * Commit 列表仓库行中的 remote 选择窗口: 独立维护 remote 列表、单选、添加和删除入口。
 * 结构与交互片段由 gitkWebviewDocument.ts 注入到仓库名称前方。
 */

export const REMOTE_SELECTOR_SUB_PANEL_STYLES = `
  #remoteSelector { position: relative; display: flex; align-items: center; flex: 0 1 16ch; min-width: 0; }
  #commitSelectors #remoteSelectorButton { display: flex; align-items: center; gap: 4px; width: 100%; min-width: 0; height: 26px; padding: 0 7px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }
  #commitSelectors #remoteSelectorButton:hover:not(:disabled), #commitSelectors #remoteSelector.open #remoteSelectorButton { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  #commitSelectors #remoteSelectorButton:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #commitSelectors #remoteSelectorButton:disabled { cursor: default; opacity: .6; }
  #commitSelectors #remoteSelectorButton .remote-selector-icon { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; color: var(--vscode-icon-foreground); }
  #commitSelectors #remoteSelectorButton .remote-selector-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #commitSelectors #remoteSelectorButton .remote-selector-chevron { display: inline-flex; flex: 0 0 auto; margin-left: auto; color: var(--vscode-descriptionForeground); }
  #commitSelectors #remoteSelectorButton .remote-selector-chevron svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  #commitSelectors #remoteSelectorButton.empty .remote-selector-chevron { display: none; }
  #remoteSelectorMenu { position: absolute; top: calc(100% + 3px); left: 0; z-index: 20; display: flex; flex-direction: column; width: max-content; min-width: 100%; max-width: min(360px, calc(100vw - 20px)); max-height: min(420px, calc(100vh - 20px)); overflow: hidden; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; box-shadow: 0 2px 4px rgba(0, 0, 0, .24), 0 8px 18px rgba(0, 0, 0, .36); }
  #remoteSelectorMenu[hidden] { display: none; }
  #remoteSelectorProgress { position: relative; height: 2px; overflow: hidden; background: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  #remoteSelectorProgress[hidden] { display: none; }
  #remoteSelectorProgress::before { content: ''; display: block; width: 35%; height: 100%; background: var(--vscode-progressBar-background); animation: remote-selector-progress 1.1s ease-in-out infinite; }
  @keyframes remote-selector-progress { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  #remoteSelectorOptions { min-width: 0; max-height: 330px; overflow-y: auto; padding: 4px; }
  .remote-option { display: flex; align-items: stretch; min-width: 0; border-radius: 3px; }
  .remote-option:hover, .remote-option[aria-selected="true"] { background: var(--vscode-list-hoverBackground); }
  .remote-option-select { display: flex; flex: 1 1 auto; align-items: center; gap: 7px; min-width: 0; padding: 6px 7px; color: inherit; background: transparent; border: 0; font: inherit; text-align: left; cursor: pointer; }
  .remote-option-select:focus-visible, .remote-delete-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .remote-option-name { flex: 0 0 auto; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .remote-option-url { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
  .remote-option-selected { display: inline-flex; flex: 0 0 auto; width: 16px; justify-content: center; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .remote-option-selected[hidden] { display: none; }
  .remote-delete-button { display: grid; place-items: center; flex: 0 0 28px; width: 28px; margin: 3px; padding: 0; color: var(--vscode-descriptionForeground); background: transparent; border: 0; border-radius: 3px; cursor: pointer; }
  .remote-delete-button:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
  .remote-delete-button .codicon { font-size: 14px; }
  #remoteSelectorStatus { padding: 5px 8px; color: var(--vscode-errorForeground); font-size: calc(var(--vscode-font-size, 13px) - 1px); white-space: normal; }
  #remoteSelectorStatus[hidden] { display: none; }
  #commitSelectors #remoteAddButton { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 30px; padding: 6px 8px; color: var(--vscode-textLink-foreground, var(--vscode-foreground)); background: transparent; border: 0; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); font: inherit; text-align: left; cursor: pointer; }
  #commitSelectors #remoteAddButton:hover { background: var(--vscode-toolbar-hoverBackground); }
  #commitSelectors #remoteAddButton:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
`;

export const REMOTE_SELECTOR_MARKUP = `
      <div id="remoteSelector">
        <button id="remoteSelectorButton" type="button" aria-expanded="false" disabled>
          <span class="remote-selector-icon codicon codicon-cloud" aria-hidden="true"></span>
          <span class="remote-selector-label">未选择远程仓库</span>
          <span class="remote-selector-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg></span>
        </button>
        <div id="remoteSelectorMenu" role="listbox" aria-label="选择远程仓库" hidden>
          <div id="remoteSelectorProgress" hidden></div>
          <div id="remoteSelectorOptions"></div>
          <div id="remoteSelectorStatus" hidden></div>
          <button id="remoteAddButton" type="button"><span class="codicon codicon-add" aria-hidden="true"></span><span>添加远程仓库</span></button>
        </div>
      </div>
`;

export const REMOTE_SELECTOR_SUB_PANEL_SCRIPT = `
  {
    var remoteSelectorRoot = document.getElementById('remoteSelector');
    var remoteSelectorButton = document.getElementById('remoteSelectorButton');
    var remoteSelectorMenu = document.getElementById('remoteSelectorMenu');
    var remoteSelectorOptions = document.getElementById('remoteSelectorOptions');
    var remoteSelectorStatus = document.getElementById('remoteSelectorStatus');
    var remoteAddButton = document.getElementById('remoteAddButton');
    var remoteSelectorRepositoryPath = '';
    var remoteSelectorRemotes = [];
    var remoteSelectorCache = new Map();
    var remoteSelectorSelected = '';
    var remoteSelectorLoading = false;
    var remoteSelectorLoaded = false;
    var remoteSelectorError = '';

    function remoteSelectorEscapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function closeRemoteSelector() {
      if (!remoteSelectorRoot) return;
      remoteSelectorRoot.classList.remove('open');
      remoteSelectorMenu.hidden = true;
      remoteSelectorButton.setAttribute('aria-expanded', 'false');
    }

    function requestRemoteList() {
      if (!remoteSelectorRepositoryPath || remoteSelectorLoading) return;
      remoteSelectorLoading = true;
      remoteSelectorError = '';
      renderRemoteSelector();
      vscode.postMessage({ type: 'requestRemoteList' });
    }

    function renderRemoteSelector() {
      if (!remoteSelectorRoot || !remoteSelectorButton || !remoteSelectorOptions) return;
      var progress = document.getElementById('remoteSelectorProgress');
      var hasRepository = Boolean(remoteSelectorRepositoryPath);
      var hasError = Boolean(remoteSelectorError);
      var hasRemotes = remoteSelectorRemotes.length > 0;
      var canManageRemotes = hasRepository && remoteSelectorLoaded && !hasError && !remoteSelectorLoading;
      if (remoteSelectorSelected && !remoteSelectorRemotes.some(function(remote) { return remote.name === remoteSelectorSelected; })) {
        remoteSelectorSelected = '';
      }
      remoteSelectorButton.disabled = !hasRepository || Boolean(remoteSelectorError) || remoteSelectorLoading;
      remoteSelectorButton.classList.toggle('empty', canManageRemotes && !hasRemotes);
      var label = !hasRepository ? '未绑定远程仓库' : remoteSelectorError ? '远程仓库获取失败' : remoteSelectorLoading ? '加载远程仓库...' : !remoteSelectorLoaded ? '未选择远程仓库' : !hasRemotes ? '添加远程仓库' : remoteSelectorSelected || '未选择远程仓库';
      var icon = remoteSelectorButton.querySelector('.remote-selector-icon');
      icon.classList.toggle('codicon-cloud', !canManageRemotes || hasRemotes);
      icon.classList.toggle('codicon-add', canManageRemotes && !hasRemotes);
      remoteSelectorButton.querySelector('.remote-selector-label').textContent = label;
      if (progress) progress.hidden = !remoteSelectorLoading;
      remoteAddButton.disabled = remoteSelectorLoading || !canManageRemotes;
      remoteSelectorOptions.innerHTML = remoteSelectorRemotes.map(function(remote) {
        var selected = remote.name === remoteSelectorSelected;
        var displayUrl = remote.fetchUrl || remote.pushUrl || '';
        return '<div class="remote-option" role="option" aria-selected="' + String(selected) + '" data-remote-name="' + remoteSelectorEscapeHtml(remote.name) + '">' +
          '<button type="button" class="remote-option-select"><span class="remote-option-name">' + remoteSelectorEscapeHtml(remote.name) + '</span>' +
          '<span class="remote-option-url" title="' + remoteSelectorEscapeHtml(displayUrl) + '">' + remoteSelectorEscapeHtml(displayUrl) + '</span>' +
          '<span class="remote-option-selected"' + (selected ? '' : ' hidden') + ' aria-hidden="true">✓</span></button>' +
          '<button type="button" class="remote-delete-button" title="删除 remote" aria-label="删除 remote ' + remoteSelectorEscapeHtml(remote.name) + '"><span class="codicon codicon-trash" aria-hidden="true"></span></button>' +
          '</div>';
      }).join('');
      if (remoteSelectorLoaded && !remoteSelectorLoading && !hasRemotes) closeRemoteSelector();
    }

    function showRemoteSelectorStatus(message) {
      remoteSelectorStatus.textContent = message || '';
      remoteSelectorStatus.hidden = !message;
    }

    remoteSelectorButton.addEventListener('click', function() {
      if (remoteSelectorButton.disabled || remoteSelectorLoading) return;
      showRemoteSelectorStatus('');
      if (remoteSelectorLoaded && remoteSelectorRemotes.length === 0) {
        vscode.postMessage({ type: 'addRemote' });
        return;
      }
      var opening = remoteSelectorMenu.hidden;
      if (opening) requestRemoteList();
      remoteSelectorRoot.classList.toggle('open', opening);
      remoteSelectorMenu.hidden = !opening;
      remoteSelectorButton.setAttribute('aria-expanded', String(opening));
    });

    remoteSelectorOptions.addEventListener('click', function(event) {
      var target = event.target;
      var deleteButton = target && target.closest ? target.closest('.remote-delete-button') : null;
      var option = target && target.closest ? target.closest('.remote-option') : null;
      if (!option) return;
      var name = option.dataset.remoteName || '';
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        if (name) vscode.postMessage({ type: 'deleteRemote', name: name });
        return;
      }
      if (target.closest && target.closest('.remote-option-select') && name) {
        event.preventDefault();
        event.stopPropagation();
        remoteSelectorSelected = name;
        remoteSelectorCache.set(remoteSelectorRepositoryPath, { remotes: remoteSelectorRemotes.slice(), upstreamRemote: name });
        renderRemoteSelector();
        vscode.postMessage({ type: 'selectRemote', name: name });
      }
    });

    remoteAddButton.addEventListener('click', function() {
      vscode.postMessage({ type: 'addRemote' });
    });

    document.addEventListener('click', function(event) {
      if (!event.target.closest('#remoteSelector')) closeRemoteSelector();
    });
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') closeRemoteSelector();
    });

    window.addEventListener('message', function(event) {
      var message = event.data || {};
      if (message.type === 'selectedRepoDisplayChanged') {
        remoteSelectorRepositoryPath = message.repository && typeof message.repository.path === 'string' ? message.repository.path : '';
        var cachedRemoteState = remoteSelectorCache.get(remoteSelectorRepositoryPath);
        remoteSelectorRemotes = cachedRemoteState ? cachedRemoteState.remotes.slice() : [];
        remoteSelectorSelected = cachedRemoteState ? cachedRemoteState.upstreamRemote : '';
        remoteSelectorLoaded = Boolean(cachedRemoteState);
        // 切换到尚未缓存的仓库时，先显示加载态；不能把尚未查询到的状态误报为"未选择远程仓库"。
        remoteSelectorLoading = Boolean(remoteSelectorRepositoryPath && !cachedRemoteState);
        remoteSelectorError = '';
        renderRemoteSelector();
      } else if (message.type === 'remoteListChanged') {
        if ((message.repositoryPath || '') !== remoteSelectorRepositoryPath) return;
        remoteSelectorRemotes = Array.isArray(message.remotes) ? message.remotes.filter(function(remote) {
          return remote && typeof remote.name === 'string';
        }) : [];
        var upstreamRemote = typeof message.upstreamRemote === 'string' ? message.upstreamRemote : '';
        var selectedRemote = typeof message.selectedRemote === 'string' ? message.selectedRemote : '';
        // 空 upstream 只表示本次分支快照尚未准备好，不能覆盖已有的有效选择。
        remoteSelectorSelected = upstreamRemote || selectedRemote || remoteSelectorSelected;
        remoteSelectorLoading = false;
        remoteSelectorLoaded = true;
        remoteSelectorCache.set(remoteSelectorRepositoryPath, { remotes: remoteSelectorRemotes.slice(), upstreamRemote: remoteSelectorSelected });
        remoteSelectorError = typeof message.error === 'string' ? message.error : '';
        showRemoteSelectorStatus(message.error || '');
        renderRemoteSelector();
      }
    });

    renderRemoteSelector();
  }
`;