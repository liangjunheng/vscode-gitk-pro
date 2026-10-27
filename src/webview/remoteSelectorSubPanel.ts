/**
 * Commit 列表仓库行中的 remote 操作窗口: 显示 remote/upstream，并配置 Fetch/Pull 使用的 remote。
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
  #remoteSelectorMenu { position: absolute; top: calc(100% + 3px); left: 0; z-index: 20; display: flex; flex-direction: column; width: max-content; min-width: 100%; max-width: min(440px, calc(100vw - 20px)); max-height: min(460px, calc(100vh - 20px)); overflow: hidden; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; box-shadow: 0 2px 4px rgba(0, 0, 0, .24), 0 8px 18px rgba(0, 0, 0, .36); }
  #remoteSelectorMenu[hidden] { display: none; }
  #remoteSelectorProgress { position: relative; height: 2px; overflow: hidden; background: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  #remoteSelectorProgress[hidden] { display: none; }
  #remoteSelectorProgress::before { content: ''; display: block; width: 35%; height: 100%; background: var(--vscode-progressBar-background); animation: remote-selector-progress 1.1s ease-in-out infinite; }
  @keyframes remote-selector-progress { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  #remoteSelectorOptions { min-width: 0; max-height: 370px; overflow-y: auto; padding: 4px; }
  .remote-option { display: flex; align-items: stretch; min-width: 0; border-radius: 3px; background: transparent; }
  .remote-option-content { flex: 1 1 auto; min-width: 0; padding: 6px 7px; }
  .remote-option-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .remote-option-title { display: flex; align-items: center; gap: 5px; flex: 1 1 auto; min-width: 0; }
  .remote-option-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .remote-default-badge { display: inline-flex; align-items: center; flex: 0 0 auto; height: 18px; padding: 0 5px; color: var(--vscode-textLink-foreground, #3794ff); background: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 10%, transparent); border: 1px solid var(--vscode-textLink-foreground, #3794ff); border-radius: 6px; font-size: 10px; line-height: 16px; font-weight: 500; }
  .remote-option-url { min-width: 0; margin-top: 3px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size, 13px) - 1px); text-overflow: ellipsis; white-space: nowrap; }
  .remote-operation-checks { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; }
  .remote-operation-check { display: inline-flex; align-items: center; gap: 3px; color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size, 13px) - 1px); cursor: pointer; user-select: none; }
  .remote-operation-check input { width: 13px; height: 13px; margin: 0; accent-color: var(--vscode-focusBorder); cursor: pointer; }
  .remote-operation-check input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .remote-delete-button { display: grid; place-items: center; flex: 0 0 28px; width: 28px; margin: 3px; padding: 0; color: var(--vscode-descriptionForeground); background: transparent; border: 0; border-radius: 3px; cursor: pointer; }
  .remote-delete-button:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
  .remote-delete-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
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
        <div id="remoteSelectorMenu" role="dialog" aria-label="远程仓库操作" hidden>
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
    var remoteSelectorUpstream = '';
    var remoteSelectorOperations = { fetch: [], pull: [] };
    var remoteSelectorPendingOperations = new Map();
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
    function remoteSelectorEscapeAttr(value) { return remoteSelectorEscapeHtml(value).replace(/'/g, '&#39;'); }
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
    function operationChecked(operation, name) {
      return Array.isArray(remoteSelectorOperations[operation]) && remoteSelectorOperations[operation].indexOf(name) >= 0;
    }
    function normalizeRemoteOperations(value, fallbackRemote) {
      var input = value || {};
      var fallback = fallbackRemote ? [fallbackRemote] : [];
      return {
        fetch: Array.isArray(input.fetch) ? input.fetch.filter(Boolean) : fallback.slice(),
        pull: Array.isArray(input.pull) ? input.pull.filter(Boolean) : fallback.slice()
      };
    }
    function operationLabel(operation) { return operation === 'fetch' ? 'Fetch' : 'Pull'; }
    function pendingOperationKey(operation, name) { return operation + '\\n' + name; }
    function mergePendingRemoteOperations(operations) {
      remoteSelectorPendingOperations.forEach(function(enabled, key) {
        var separator = key.indexOf('\\n');
        var operation = key.slice(0, separator);
        var name = key.slice(separator + 1);
        if (!Array.isArray(operations[operation])) operations[operation] = [];
        var persisted = operations[operation].indexOf(name) >= 0;
        if (persisted === enabled) { remoteSelectorPendingOperations.delete(key); return; }
        if (enabled) operations[operation].push(name);
        else operations[operation] = operations[operation].filter(function(value) { return value !== name; });
      });
      return operations;
    }
    function renderRemoteSelector() {
      if (!remoteSelectorRoot || !remoteSelectorButton || !remoteSelectorOptions) return;
      var progress = document.getElementById('remoteSelectorProgress');
      var hasRepository = Boolean(remoteSelectorRepositoryPath);
      var hasError = Boolean(remoteSelectorError);
      var hasRemotes = remoteSelectorRemotes.length > 0;
      var canManageRemotes = hasRepository && remoteSelectorLoaded && !hasError && !remoteSelectorLoading;
      remoteSelectorButton.disabled = !hasRepository || hasError || remoteSelectorLoading;
      remoteSelectorButton.classList.toggle('empty', canManageRemotes && !hasRemotes);
      var label = !hasRepository ? '未绑定远程仓库' : hasError ? '远程仓库获取失败' : !remoteSelectorLoaded ? '未选择远程仓库' : !hasRemotes ? '添加远程仓库' : remoteSelectorUpstream || '未选择远程仓库';
      var icon = remoteSelectorButton.querySelector('.remote-selector-icon');
      icon.classList.toggle('codicon-cloud', !canManageRemotes || hasRemotes);
      icon.classList.toggle('codicon-add', canManageRemotes && !hasRemotes);
      remoteSelectorButton.querySelector('.remote-selector-label').textContent = label;
      if (progress) progress.hidden = !remoteSelectorLoading;
      remoteAddButton.disabled = remoteSelectorLoading || !canManageRemotes;
      remoteSelectorOptions.innerHTML = remoteSelectorRemotes.map(function(remote) {
        var displayUrl = remote.fetchUrl || remote.pushUrl || '';
        var name = remoteSelectorEscapeAttr(remote.name);
        var bound = remote.name === remoteSelectorUpstream;
        var checks = ['fetch', 'pull'].map(function(operation) {
          var checked = operationChecked(operation, remote.name);
          return '<label class="remote-operation-check"><input type="checkbox" class="remote-operation-checkbox" data-operation="' + operation + '" data-remote-name="' + name + '"' + (checked ? ' checked' : '') + '><span>' + operationLabel(operation) + '</span></label>';
        }).join('');
        return '<div class="remote-option" data-remote-name="' + name + '">' +
          '<div class="remote-option-content"><div class="remote-option-name-row"><span class="remote-option-title"><span class="remote-option-name">' + remoteSelectorEscapeHtml(remote.name) + '</span>' + (bound ? '<span class="remote-default-badge">默认</span>' : '') + '</span><span class="remote-operation-checks">' + checks + '</span></div>' +
          '<div class="remote-option-url" title="' + remoteSelectorEscapeAttr(displayUrl) + '">' + remoteSelectorEscapeHtml(displayUrl) + '</div></div>' +
          '<button type="button" class="remote-delete-button" title="删除 remote" aria-label="删除 remote ' + name + '"><span class="codicon codicon-trash" aria-hidden="true"></span></button></div>';
      }).join('');
      if (remoteSelectorLoaded && !remoteSelectorLoading && !hasRemotes) closeRemoteSelector();
    }
    function showRemoteSelectorStatus(message) { remoteSelectorStatus.textContent = message || ''; remoteSelectorStatus.hidden = !message; }
    remoteSelectorButton.addEventListener('click', function() {
      if (remoteSelectorButton.disabled || remoteSelectorLoading) return;
      showRemoteSelectorStatus('');
      if (remoteSelectorLoaded && remoteSelectorRemotes.length === 0) { vscode.postMessage({ type: 'addRemote' }); return; }
      var opening = remoteSelectorMenu.hidden;
      if (opening) requestRemoteList();
      remoteSelectorRoot.classList.toggle('open', opening);
      remoteSelectorMenu.hidden = !opening;
      remoteSelectorButton.setAttribute('aria-expanded', String(opening));
    });
    remoteSelectorOptions.addEventListener('change', function(event) {
      var checkbox = event.target && event.target.closest ? event.target.closest('.remote-operation-checkbox') : null;
      if (!checkbox) return;
      var operation = checkbox.dataset.operation || '';
      var name = checkbox.dataset.remoteName || '';
      if (!name || !['fetch', 'pull'].includes(operation)) return;
      if (!Array.isArray(remoteSelectorOperations[operation])) remoteSelectorOperations[operation] = [];
      if (checkbox.checked && !operationChecked(operation, name)) remoteSelectorOperations[operation].push(name);
      if (!checkbox.checked) remoteSelectorOperations[operation] = remoteSelectorOperations[operation].filter(function(value) { return value !== name; });
      remoteSelectorPendingOperations.set(pendingOperationKey(operation, name), checkbox.checked);
      renderRemoteSelector();
      vscode.postMessage({ type: 'setRemoteOperation', operation: operation, name: name, enabled: checkbox.checked });
    });
    remoteSelectorOptions.addEventListener('click', function(event) {
      var target = event.target;
      var deleteButton = target && target.closest ? target.closest('.remote-delete-button') : null;
      var option = target && target.closest ? target.closest('.remote-option') : null;
      if (!option || !deleteButton) return;
      event.preventDefault(); event.stopPropagation();
      var name = option.dataset.remoteName || '';
      if (name) vscode.postMessage({ type: 'deleteRemote', name: name });
    });
    remoteAddButton.addEventListener('click', function() { vscode.postMessage({ type: 'addRemote' }); });
    document.addEventListener('click', function(event) { if (!event.target.closest('#remoteSelector')) closeRemoteSelector(); });
    document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeRemoteSelector(); });
    window.addEventListener('message', function(event) {
      var message = event.data || {};
      if (message.type === 'selectedRepoDisplayChanged') {
        remoteSelectorRepositoryPath = message.repository && typeof message.repository.path === 'string' ? message.repository.path : '';
        remoteSelectorPendingOperations.clear();
        var hostRemoteState = message.remoteState && Array.isArray(message.remoteState.remotes) ? {
          remotes: message.remoteState.remotes.filter(function(remote) { return remote && typeof remote.name === 'string'; }),
          upstreamRemote: typeof message.remoteState.upstreamRemote === 'string' ? message.remoteState.upstreamRemote : '',
          operations: message.remoteState.operations || {}
        } : null;
        if (hostRemoteState && remoteSelectorRepositoryPath) remoteSelectorCache.set(remoteSelectorRepositoryPath, hostRemoteState);
        var cached = hostRemoteState || remoteSelectorCache.get(remoteSelectorRepositoryPath);
        remoteSelectorRemotes = cached ? cached.remotes.slice() : [];
        remoteSelectorUpstream = cached ? cached.upstreamRemote : '';
        remoteSelectorOperations = normalizeRemoteOperations(cached && cached.operations, remoteSelectorUpstream);
        remoteSelectorLoaded = Boolean(cached);
        remoteSelectorLoading = Boolean(remoteSelectorRepositoryPath && !cached);
        remoteSelectorError = '';
        renderRemoteSelector();
      } else if (message.type === 'remoteListChanged') {
        if ((message.repositoryPath || '') !== remoteSelectorRepositoryPath) return;
        remoteSelectorRemotes = Array.isArray(message.remotes) ? message.remotes.filter(function(remote) { return remote && typeof remote.name === 'string'; }) : [];
        var upstreamRemote = typeof message.upstreamRemote === 'string' ? message.upstreamRemote : '';
        remoteSelectorUpstream = upstreamRemote;
        remoteSelectorOperations = mergePendingRemoteOperations(normalizeRemoteOperations(message.operations, remoteSelectorUpstream));
        remoteSelectorLoading = false; remoteSelectorLoaded = true;
        remoteSelectorCache.set(remoteSelectorRepositoryPath, { remotes: remoteSelectorRemotes.slice(), upstreamRemote: remoteSelectorUpstream, operations: remoteSelectorOperations });
        remoteSelectorError = typeof message.error === 'string' ? message.error : '';
        showRemoteSelectorStatus(message.error || ''); renderRemoteSelector();
      } else if (message.type === 'remoteOperationFailed') {
        if ((message.repositoryPath || '') !== remoteSelectorRepositoryPath) return;
        remoteSelectorPendingOperations.delete(pendingOperationKey(message.operation || '', message.name || ''));
        showRemoteSelectorStatus(message.error || '更新远程操作配置失败');
      }
    });
    renderRemoteSelector();
  }
`;
