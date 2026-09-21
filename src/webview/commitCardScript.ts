/**
 * Commit 面板 webview 的仓库卡片脚本片段: 卡片构建、事件委托与按快照更新。
 * 按原样迁移自 commitPanelDocument; 与骨架及其他片段拼接在同一个 IIFE 内, 共享作用域。
 */
export const COMMIT_CARD_SCRIPT = `
  function resizeMessageInput(input){input.style.height='auto';input.style.height=input.scrollHeight+'px'}
  function cardSectionFiles(card,section){
    if(section==='conflict')return card.conflictFiles||[];
    if(section==='staged')return card.stagedFiles||[];
    return card.unstagedFiles||[];
  }
  function cardSectionList(cardElement,section){
    if(section==='conflict')return cardElement._refs.conflictList;
    if(section==='staged')return cardElement._refs.stagedList;
    return cardElement._refs.unstagedList;
  }

  function buildCard(repo){
    const el=document.createElement('div');
    el.className='card';
    el.dataset.repo=repo;
    el.innerHTML=
      '<div class="card-header"><span class="codicon codicon-chevron-down card-chevron"></span><span class="repository-icon card-repository-icon" aria-hidden="true"></span><span class="repo-label"></span><span class="repository-ancestry" hidden></span><span class="repository-status-badge conflict-header-count"></span><span class="repository-status-badge untracked-count"></span><span class="repository-status-badge unstaged-header-count"></span><span class="repository-status-badge staged-header-count"></span><span class="card-empty-tag"></span></div>'+
      '<div class="card-body">'+
        '<div class="message-box">'+
          '<textarea class="message-input" rows="3" placeholder="输入提交信息…" spellcheck="false"></textarea>'+
          '<button class="history-btn message-history-btn" type="button" title="历史提交信息"><span class="codicon codicon-history"></span></button>'+
        '</div>'+
        '<div class="section conflict" hidden><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down conflict-chevron"></span><span>Merge Changes</span><span class="section-count-badge conflict-count" hidden></span></span><span class="section-actions conflict-actions"><button class="icon-btn conflict-all" data-action="stage" data-section="conflict" title="暂存所有文件并标记冲突已解决"><span class="codicon codicon-add"></span></button></span></div><div class="conflict-list"></div></div>'+
        '<div class="section staged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down staged-chevron"></span><span>Staged Changes</span><span class="section-count-badge staged-count" hidden></span></span><span class="section-actions staged-actions"><button class="icon-btn staged-all" data-action="unstage" data-section="staged" title="取消暂存所有文件"><span class="codicon codicon-remove"></span></button></span></div><div class="staged-list"></div></div>'+
        '<div class="section unstaged"><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down unstaged-chevron"></span><span>Unstaged Changes</span><span class="section-count-badge unstaged-count" hidden></span></span><span class="section-actions unstaged-actions"><button class="icon-btn discard-all" data-action="discard" data-section="unstaged" title="还原所有文件"><span class="codicon codicon-discard"></span></button><button class="icon-btn stage-all" data-action="stage" data-section="unstaged" title="暂存所有文件"><span class="codicon codicon-add"></span></button></span></div><div class="unstaged-list"></div></div>'+
        '<div class="section committed" hidden><div class="section-title collapsible"><span class="left"><span class="codicon codicon-chevron-down committed-chevron"></span><span>Committed Changes</span><span class="section-count-badge committed-count" hidden></span></span></div><div class="committed-list"></div></div>'+
        '<div class="actions">'+
          '<span class="hint"></span>'+
          '<div class="action-groups">'+
            '<span class="action-group commit-group">'+
              '<label class="commit-option"><input class="amend-checkbox" type="checkbox"><span>amend</span></label>'+
              '<span class="commit-submodule-selector submodule-selector"></span>'+
              '<button class="commit-btn">commit</button>'+
            '</span>'+
            '<span class="action-group submodule-group">'+
              '<button class="push-btn"><span>push</span><span class="push-target-label"></span></button>'+
              '<label class="pull-option"><input class="pull-before-push-checkbox" type="checkbox" checked><span>pull</span></label>'+
              '<span class="submodule-selector push-submodule-selector"></span>'+
            '</span>'+
          '</div>'+
        '</div>'+
      '</div>';
    // 空仓库卡片默认折叠；三个变更区域默认展开。
    const state={conflictOpen:true,stagedOpen:true,unstagedOpen:true,committedOpen:true,selectedWorkingTreeFiles:new Set(),workingTreeSelectionAnchor:''};
    const messageInput=el.querySelector('.message-input');
    const commitBtn=el.querySelector('.commit-btn');
    const pushBtn=el.querySelector('.push-btn');
    const pullBeforePushCheckbox=el.querySelector('.pull-before-push-checkbox');
    const amendCheckbox=el.querySelector('.amend-checkbox');
    const historyBtn=el.querySelector('.history-btn');
    historyBtn.type='button';
    historyBtn.classList.add('message-history-btn');
    const hint=el.querySelector('.hint');
    const conflictTitle=el.querySelector('.section.conflict .section-title');
    const conflictList=el.querySelector('.conflict-list');
    const conflictChevron=el.querySelector('.conflict-chevron');
    const unstagedTitle=el.querySelector('.section.unstaged .section-title');
    const unstagedList=el.querySelector('.unstaged-list');
    const unstagedChevron=el.querySelector('.unstaged-chevron');
    const stagedTitle=el.querySelector('.section.staged .section-title');
    const stagedList=el.querySelector('.staged-list');
    const stagedChevron=el.querySelector('.staged-chevron');
    const committedTitle=el.querySelector('.section.committed .section-title');
    const committedList=el.querySelector('.committed-list');
    const committedChevron=el.querySelector('.committed-chevron');
    const cardHeader=el.querySelector('.card-header');
    const cardChevron=el.querySelector('.card-chevron');
    const cardBody=el.querySelector('.card-body');

    el.addEventListener('click',function(){selectCard(repo)});
    bindRowActions(el,repo);
    // 仅无任何未提交文件的仓库可折叠; 有变更的仓库强制展开、不可折叠。
    cardHeader.addEventListener('click',function(){
      if(!el._collapsible)return;
      state.cardCollapsed=!state.cardCollapsed;
      cardBody.hidden=state.cardCollapsed;
      el.classList.toggle('collapsed',state.cardCollapsed);
      cardChevron.className='codicon codicon-chevron-'+(state.cardCollapsed?'right':'down')+' card-chevron';
    });

    amendCheckbox.addEventListener('change',function(){vscode.postMessage({type:'toggleAmend',repositoryPath:repo,message:messageInput.value})});
    pushBtn.addEventListener('click',function(){
      vscode.postMessage({type:'gitSync',action:'push',repositoryPaths:[...(el._card.selectedPushSubmoduleRepositoryPaths||[]),repo],pullBeforePush:pullBeforePushCheckbox.checked});
    });
    historyBtn.addEventListener('click',function(){vscode.postMessage({type:'history',repositoryPath:repo})});
    el.querySelectorAll('.section-actions .icon-btn[data-action]').forEach(function(button){
      button.addEventListener('click',function(event){
        event.stopPropagation();
        const section=button.dataset.section;
        const files=cardSectionFiles(el._card,section);
        const selectedPaths=selectedCommitWorkingTreePaths(el,section,'');
        const paths=selectedPaths||files.map(function(file){return file.path});
        const pathSet=new Set(paths);
        vscode.postMessage({
          type:'workingTreeAction',
          repositoryPath:repo,
          action:button.dataset.action,
          section:section,
          paths:paths,
          untrackedPaths:files.filter(function(file){return pathSet.has(file.path)&&file.isUntracked}).map(function(file){return file.path}),
        });
      });
    });
    commitBtn.addEventListener('click',function(){
      // 提交时以输入框的实时内容为准, 避免后端快照还未跟上时提交旧文本。
      const message=messageInput.value.trim();
      if(!message){hint.textContent='提交信息不能为空';messageInput.focus();return}
      vscode.postMessage({type:'commit',repositoryPath:repo,repositoryPaths:[...(el._card.selectedCommitSubmoduleRepositoryPaths||[]),repo],message:messageInput.value,amend:el._amend===true});
    });
    messageInput.addEventListener('input',function(){if(!commitBtn.disabled)hint.textContent='';resizeMessageInput(messageInput);vscode.postMessage({type:'updateCardState',repositoryPath:repo,patch:{message:messageInput.value}})});
    pullBeforePushCheckbox.addEventListener('change',function(){vscode.postMessage({type:'updateCardState',repositoryPath:repo,patch:{pullBeforePush:pullBeforePushCheckbox.checked}})});
    resizeMessageInput(messageInput);
    messageInput.addEventListener('keydown',function(event){
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();commitBtn.click()}
    });
    function bindSection(title,list,chevron,key){
      title.addEventListener('click',function(event){
        event.stopPropagation();
        state[key]=!state[key];
        list.hidden=!state[key];
        chevron.className='codicon codicon-chevron-'+(state[key]?'down':'right')+' '+key.replace('Open','')+'-chevron';
      });
    }
    bindSection(conflictTitle,conflictList,conflictChevron,'conflictOpen');
    bindSection(stagedTitle,stagedList,stagedChevron,'stagedOpen');
    bindSection(unstagedTitle,unstagedList,unstagedChevron,'unstagedOpen');
    bindSection(committedTitle,committedList,committedChevron,'committedOpen');

    state.cardCollapsed=false;
    el._state=state;
    el._refs={messageInput,commitBtn,pushBtn,amendCheckbox,hint,conflictList,unstagedList,stagedList,committedList,conflictChevron,unstagedChevron,stagedChevron,committedChevron,cardChevron,cardBody,cardHeader};
    return el;
  }

  function pruneCommitWorkingTreeSelection(cardElement){
    const card=cardElement._card;
    const state=cardElement._state;
    const available=new Set();
    (card.conflictFiles||[]).forEach(function(file){available.add(commitWorkingTreeSelectionKey('conflict',file.path))});
    (card.stagedFiles||[]).forEach(function(file){available.add(commitWorkingTreeSelectionKey('staged',file.path))});
    (card.unstagedFiles||[]).forEach(function(file){available.add(commitWorkingTreeSelectionKey('unstaged',file.path))});
    state.selectedWorkingTreeFiles.forEach(function(key){
      if(!available.has(key))state.selectedWorkingTreeFiles.delete(key);
    });
    if(state.workingTreeSelectionAnchor&&!available.has(state.workingTreeSelectionAnchor))state.workingTreeSelectionAnchor='';
  }

  function selectedCommitWorkingTreePaths(cardElement,section,fallbackPath){
    const prefix=section+'\u0000';
    const paths=[];
    cardElement._state.selectedWorkingTreeFiles.forEach(function(key){
      if(key.indexOf(prefix)===0)paths.push(key.slice(prefix.length));
    });
    if(fallbackPath&&paths.indexOf(fallbackPath)<0)return [fallbackPath];
    if(paths.length)return paths;
    return fallbackPath?[fallbackPath]:undefined;
  }

  function selectCommitWorkingTreeRow(cardElement,row,event){
    const section=row.dataset.section;
    const path=row.dataset.path;
    if(!section||!path||(section!=='conflict'&&section!=='staged'&&section!=='unstaged'))return;
    const state=cardElement._state;
    const key=commitWorkingTreeSelectionKey(section,path);
    const additive=event.ctrlKey||event.metaKey;
    const anchor=state.workingTreeSelectionAnchor;
    const anchorPrefix=section+'\u0000';
    const list=cardSectionList(cardElement,section);
    const rows=Array.from(list.querySelectorAll('.file-row[data-section="'+section+'"]'));
    const anchorIndex=anchor&&anchor.indexOf(anchorPrefix)===0
      ? rows.findIndex(function(candidate){return commitWorkingTreeSelectionKey(section,candidate.dataset.path||'')===anchor})
      : -1;
    const currentIndex=rows.indexOf(row);
    if(event.shiftKey&&anchorIndex>=0&&currentIndex>=0){
      if(!additive)state.selectedWorkingTreeFiles.clear();
      const start=Math.min(anchorIndex,currentIndex),end=Math.max(anchorIndex,currentIndex);
      for(let index=start;index<=end;index++){
        const candidatePath=rows[index].dataset.path;
        if(candidatePath)state.selectedWorkingTreeFiles.add(commitWorkingTreeSelectionKey(section,candidatePath));
      }
    }else if(additive){
      if(state.selectedWorkingTreeFiles.has(key))state.selectedWorkingTreeFiles.delete(key);
      else state.selectedWorkingTreeFiles.add(key);
    }else{
      state.selectedWorkingTreeFiles.clear();
      state.selectedWorkingTreeFiles.add(key);
    }
    state.workingTreeSelectionAnchor=key;
    syncCommitWorkingTreeSelection(list,state.selectedWorkingTreeFiles);
  }

  // 行节点跨渲染复用, 逐次渲染直接绑定会叠加监听器: 一次点击发出 N 条消息 -> N 个确认弹窗。
  // 改为卡片根节点单次事件委托, 点击时再按当前 _card 解析数据。
  function bindRowActions(cardElement,repo){
    cardElement.addEventListener('click',function(event){
      const card=cardElement._card;
      if(!card)return;
      const button=event.target.closest('.icon-btn');
      if(button&&button.dataset.action){
        const section=button.dataset.section;
        const filePath=button.dataset.path;
        const files=cardSectionFiles(card,section);
        const selectedPaths=selectedCommitWorkingTreePaths(cardElement,section,filePath);
        const paths=selectedPaths||[filePath];
        const pathSet=new Set(paths);
        vscode.postMessage({
          type:'workingTreeAction',
          repositoryPath:repo,
          action:button.dataset.action,
          section:section,
          paths:paths,
          untrackedPaths:files.filter(function(file){return pathSet.has(file.path)&&file.isUntracked}).map(function(file){return file.path}),
        });
        return;
      }
      const row=event.target.closest('.file-row');
      if(row){
        selectCommitWorkingTreeRow(cardElement,row,event);
        vscode.postMessage({type:'selectFile',repositoryPath:repo,section:row.dataset.section,path:row.dataset.path});
      }
    });
  }

  function updateCard(el,card){
    el._card=card;
    el._amend=card.amend;
    const repositoryIcon=el.querySelector('.card-repository-icon');
    // 包含子仓库的仓库和独立仓库=repo；仅叶子子仓库=archive。
    const icon=!card.repositoryHasSubmodules&&card.repositoryAncestry.length>0?'archive':'repo';
    repositoryIcon.className='repository-icon card-repository-icon codicon codicon-'+icon
      +(card.repositoryHasSubmodules?' has-submodules':'');
    el.querySelector('.repo-label').textContent=card.repositoryLabel;
    const ancestry=el.querySelector('.repository-ancestry');
    ancestry.replaceChildren();
    card.repositoryAncestry.forEach(function(repository,index){
      if(index===0){
        const marker=document.createElement('span');
        marker.className='repository-ancestry-marker';
        marker.textContent='⌘';
        ancestry.appendChild(marker);
      }
      if(index>0){
        const separator=document.createElement('span');
        separator.className='repository-ancestry-separator';
        separator.textContent='/';
        ancestry.appendChild(separator);
      }
      const link=document.createElement('button');
      link.type='button';
      link.className='repository-ancestry-link';
      link.textContent=repository.label;
      link.title='跳转到 '+repository.label+' 的提交卡片';
      link.addEventListener('click',function(event){
        event.stopPropagation();
        vscode.postMessage({type:'focusRepository',repositoryPath:repository.path});
      });
      ancestry.appendChild(link);
    });
    if(card.repositoryAncestry.length){
      const trailingSeparator=document.createElement('span');
      trailingSeparator.className='repository-ancestry-separator';
      trailingSeparator.textContent='/';
      ancestry.appendChild(trailingSeparator);
    }
    ancestry.hidden=card.repositoryAncestry.length===0;
    const refs=el._refs;
    el.classList.toggle('selected-card',el.dataset.repo===selectedRepositoryPath);
    const isEmpty=card.conflictFiles.length===0&&card.stagedFiles.length===0&&card.unstagedFiles.length===0;
    refs.amendCheckbox.checked=card.amend;
    refs.amendCheckbox.disabled=false;
    // 输入框处于焦点时不用后端快照覆盖本地输入, 否则快速在中间插入文字时会把光标重置到末尾。
    const messageInputFocused=document.activeElement===refs.messageInput;
    if(!messageInputFocused&&refs.messageInput.value!==card.message){refs.messageInput.value=card.message;resizeMessageInput(refs.messageInput)}
    el.querySelector('.pull-before-push-checkbox').checked=card.pullBeforePush;
    refs.commitBtn.textContent=card.amend?'amend':'commit';
    const selectedCommitPaths=new Set([...(card.selectedCommitSubmoduleRepositoryPaths||[]),card.repositoryPath]);
    const hasSelectedConflicts=currentCards.some(function(candidate){return selectedCommitPaths.has(candidate.repositoryPath)&&(candidate.conflictFiles||[]).length>0});
    const disableCommit=card.committing||hasSelectedConflicts;
    refs.commitBtn.disabled=disableCommit;
    refs.pushBtn.disabled=false;
    const pushTargetLabel=el.querySelector('.push-target-label');
    pushTargetLabel.textContent=card.pushTargetLabel??'';
    pushTargetLabel.hidden=!card.pushTargetLabel;
    refs.hint.textContent=card.committing?'正在提交…':(hasSelectedConflicts?'请先解决所选仓库中的所有合并冲突':'');
    el._collapsible=isEmpty;
    el.querySelector('.card-empty-tag').textContent=isEmpty?'无更改':'';
    el.classList.toggle('collapsible-card',isEmpty);
    // 首次为空或由有变更转为空时默认折叠；持续为空时保留用户手动展开状态。
    if(!isEmpty){
      el._state.cardCollapsed=false;
    }else if(el._state.wasEmpty!==true){
      el._state.cardCollapsed=true;
    }
    el._state.wasEmpty=isEmpty;
    refs.cardBody.hidden=el._state.cardCollapsed;
    el.classList.toggle('collapsed',el._state.cardCollapsed);
    refs.cardChevron.hidden=!isEmpty;
    refs.cardChevron.className='codicon codicon-chevron-'+(el._state.cardCollapsed?'right':'down')+' card-chevron';
    const conflictCount=card.conflictFiles.length;
    const untrackedCount=card.unstagedFiles.filter(file=>file.isUntracked).length;
    const unstagedHeaderCount=card.unstagedFiles.length-untrackedCount;
    const updateRepositoryStatusBadge=function(selector,label,count){
      const badge=el.querySelector(selector);
      badge.textContent=count?label+' '+count:'';
      badge.hidden=count===0;
    };
    updateRepositoryStatusBadge('.conflict-header-count','Merge',conflictCount);
    updateRepositoryStatusBadge('.untracked-count','Untracked',untrackedCount);
    updateRepositoryStatusBadge('.unstaged-header-count','Unstaged',unstagedHeaderCount);
    updateRepositoryStatusBadge('.staged-header-count','Staged',card.stagedFiles.length);
    pruneCommitWorkingTreeSelection(el);
    const stagedList=el.querySelector('.staged-list');
    const committedSection=el.querySelector('.section.committed');
    const committedList=el.querySelector('.committed-list');
    const committedCount=el.querySelector('.committed-count');
    committedSection.hidden=!card.amend;
    if(card.amend){
      committedCount.textContent=card.committedFiles.length?String(card.committedFiles.length):'';
      committedCount.hidden=card.committedFiles.length===0;
      if(card.committedFilesLoading){
        committedList.innerHTML='<div class="empty">正在加载当前提交的文件…</div>';
      }else{
        renderFileList(committedList,card.committedFiles,'committed',el.dataset.repo);
      }
      committedList.hidden=!el._state.committedOpen;
      refs.committedChevron.className='codicon codicon-chevron-'+(el._state.committedOpen?'down':'right')+' committed-chevron';
    }
    const conflictSection=el.querySelector('.section.conflict');
    const conflictList=el.querySelector('.conflict-list');
    const conflictCountBadge=el.querySelector('.conflict-count');
    conflictSection.hidden=card.conflictFiles.length===0;
    conflictCountBadge.textContent=card.conflictFiles.length?String(card.conflictFiles.length):'';
    conflictCountBadge.hidden=card.conflictFiles.length===0;
    el.querySelector('.conflict-all').disabled=card.conflictFiles.length===0;
    renderFileList(conflictList,card.conflictFiles,'conflict',el.dataset.repo,el._state.selectedWorkingTreeFiles);
    conflictList.hidden=!el._state.conflictOpen;
    refs.conflictChevron.className='codicon codicon-chevron-'+(el._state.conflictOpen?'down':'right')+' conflict-chevron';
    const unstagedList=el.querySelector('.unstaged-list');
    const stagedCount=el.querySelector('.staged-count');
    stagedCount.textContent=card.stagedFiles.length?String(card.stagedFiles.length):'';
    stagedCount.hidden=card.stagedFiles.length===0;
    el.querySelector('.staged-all').disabled=card.stagedFiles.length===0;
    const unstagedCount=el.querySelector('.unstaged-count');
    unstagedCount.textContent=card.unstagedFiles.length?String(card.unstagedFiles.length):'';
    unstagedCount.hidden=card.unstagedFiles.length===0;
    el.querySelector('.discard-all').disabled=card.unstagedFiles.length===0;
    el.querySelector('.stage-all').disabled=card.unstagedFiles.length===0;
    renderFileList(stagedList,card.stagedFiles,'staged',el.dataset.repo,el._state.selectedWorkingTreeFiles);
    renderFileList(unstagedList,card.unstagedFiles,'unstaged',el.dataset.repo,el._state.selectedWorkingTreeFiles);
    stagedList.hidden=!el._state.stagedOpen;
    unstagedList.hidden=!el._state.unstagedOpen;
    refs.stagedChevron.className='codicon codicon-chevron-'+(el._state.stagedOpen?'down':'right')+' staged-chevron';
    refs.unstagedChevron.className='codicon codicon-chevron-'+(el._state.unstagedOpen?'down':'right')+' unstaged-chevron';
    updateCommitSelector(el,card);
    updatePushSelector(el,card);
  }
`;
