/**
 * Commit 面板 webview 的子模块选择器脚本片段: 变更/待推送的后代子模块推导与勾选框联动。
 * 按原样迁移自 commitPanelDocument; 与骨架及其他片段拼接在同一个 IIFE 内, 共享作用域。
 */
export const COMMIT_SUBMODULE_SELECTOR_SCRIPT = `
  function isDescendantRepository(candidate,parentPath){return candidate.repositoryAncestry.some(function(ancestor){return ancestor.path===parentPath})}
  function changedGitlinkDescendants(card){
    const changedPaths=new Set(card.changedSubmoduleRepositoryPaths||[]);
    return currentCards.filter(function(item){return changedPaths.has(item.repositoryPath)&&(item.conflictFiles.length>0||item.stagedFiles.length>0||item.unstagedFiles.length>0)});
  }
  function pushedDescendants(card){
    const result=[];
    function collect(parent){
      const directPaths=new Set(parent.latestCommitSubmodulePaths||[]);
      currentCards.filter(function(item){return item.repositoryParentPath===parent.repositoryPath&&item.hasUnpushedCommits}).forEach(function(child){
        // 只有当前提交包含的 gitlink 才能继续递归匹配嵌套子模块。
        const relative=child.repositoryPath.startsWith(parent.repositoryPath)?child.repositoryPath.slice(parent.repositoryPath.length).replace(/^[/\\\\]+/,''):'';
        if(directPaths.has(relative)){result.push(child);collect(child)}
      });
    }
    collect(card);return result;
  }
  function descendantLabel(submodule,card){
    const start=submodule.repositoryAncestry.findIndex(function(ancestor){return ancestor.path===card.repositoryPath});
    const label=submodule.repositoryAncestry.slice(start+1).map(function(ancestor){return ancestor.label}).concat(submodule.repositoryLabel).join('/');
    return label;
  }
  function updateInlineSubmoduleSelector(selector,card,submodules,selectionField,title){
    selector.hidden=false;
    selector.replaceChildren();
    const selected=new Set(card[selectionField]||[]);
    const publishSelection=function(){
      vscode.postMessage({type:'updateCardState',repositoryPath:card.repositoryPath,patch:{[selectionField]:Array.from(selected)}});
    };
    const box=document.createElement('div');box.className='submodule-inline-box';
    selector.appendChild(box);
    const heading=document.createElement('div');heading.className='submodule-inline-title';heading.textContent=title;box.appendChild(heading);
    const options=document.createElement('div');options.className='submodule-inline-options';box.appendChild(options);
    const allLabel=document.createElement('label');allLabel.className='submodule-inline-option submodule-inline-all';
    allLabel.innerHTML='<input type="checkbox"><span>全选</span>';options.appendChild(allLabel);
    const allInput=allLabel.querySelector('input');
    const updateAll=function(){const inputs=Array.from(options.querySelectorAll('.submodule-inline-item'));allInput.checked=inputs.length>0&&inputs.every(function(input){return input.checked});allInput.indeterminate=!allInput.checked&&inputs.some(function(input){return input.checked})};
    const inputs=submodules.map(function(submodule){
      const label=document.createElement('label');label.className='submodule-inline-option';
      const input=document.createElement('input');input.type='checkbox';input.className='submodule-inline-item';input.checked=selected.has(submodule.repositoryPath);input.dataset.path=submodule.repositoryPath;
      const repository=document.createElement('button');repository.type='button';repository.className='submodule-inline-repository';repository.textContent=descendantLabel(submodule,card);repository.title='跳转到 '+submodule.repositoryLabel+' 的提交卡片';repository.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();vscode.postMessage({type:'focusRepository',repositoryPath:submodule.repositoryPath})});
      label.appendChild(input);label.appendChild(repository);
      if(title==='同时提交子模块'){
        const conflict=document.createElement('span');conflict.className='repository-status-badge';conflict.textContent=submodule.conflictFiles.length?'Merge '+submodule.conflictFiles.length:'';conflict.hidden=submodule.conflictFiles.length===0;
        const staged=document.createElement('span');staged.className='repository-status-badge';staged.textContent=submodule.stagedFiles.length?'Staged '+submodule.stagedFiles.length:'';staged.hidden=submodule.stagedFiles.length===0;
        const unstaged=document.createElement('span');unstaged.className='repository-status-badge';unstaged.textContent=submodule.unstagedFiles.length?'Unstaged '+submodule.unstagedFiles.length:'';unstaged.hidden=submodule.unstagedFiles.length===0;
        label.appendChild(conflict);label.appendChild(unstaged);label.appendChild(staged);
      }else{
        const commits=document.createElement('span');commits.className='repository-status-badge';commits.textContent='Commits '+submodule.unpushedCommitCount;label.appendChild(commits);
        const target=document.createElement('button');target.type='button';target.className='submodule-push-target';target.textContent=submodule.pushTargetLabel||'选择分支';target.title='选择 '+submodule.repositoryLabel+' 的推送分支';target.addEventListener('click',function(event){event.preventDefault();event.stopPropagation();vscode.postMessage({type:'pickPushBranch',repositoryPath:submodule.repositoryPath})});label.appendChild(target);
      }
      options.appendChild(label);
      input.addEventListener('change',function(){if(input.checked)selected.add(submodule.repositoryPath);else selected.delete(submodule.repositoryPath);updateAll();publishSelection()});
      return input;
    });
    allInput.addEventListener('change',function(){inputs.forEach(function(input){input.checked=allInput.checked;if(input.checked)selected.add(input.dataset.path);else selected.delete(input.dataset.path)});updateAll();publishSelection()});
    updateAll();
  }
  function updateCommitSelector(el,card){
    const selector=el.querySelector('.commit-submodule-selector');
    const submodules=card.amend?[]:changedGitlinkDescendants(card);
    selector.hidden=submodules.length===0;
    if(submodules.length===0)return;
    updateInlineSubmoduleSelector(selector,card,submodules,'selectedCommitSubmoduleRepositoryPaths','同时提交子模块');
  }
  function updatePushSelector(el,card){
    const group=el.querySelector('.submodule-group');
    const submodules=card.repositoryHasSubmodules?pushedDescendants(card):[];
    group.hidden=submodules.length===0;
    if(submodules.length===0)return;
    const selector=group.querySelector('.push-submodule-selector');
    updateInlineSubmoduleSelector(selector,card,submodules,'selectedPushSubmoduleRepositoryPaths','同时推送子模块');
  }

`;
