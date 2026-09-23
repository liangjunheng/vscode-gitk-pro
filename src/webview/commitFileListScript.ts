/**
 * Commit 面板 webview 的文件列表脚本片段: 状态图标、行操作按钮、单行 HTML 与列表增量渲染。
 * 按原样迁移自 commitPanelDocument; 与骨架及其他片段拼接在同一个 IIFE 内, 共享作用域。
 */
export const COMMIT_FILE_LIST_SCRIPT = `
  const COMMIT_FILE_ROW_HEIGHT=24;
  const COMMIT_FILE_OVERSCAN=50;
  const commitVirtualLists=new Set();
  let commitVirtualFrame=0;
  function commitRowHeight(container){return Number.isFinite(container._rowHeight)&&container._rowHeight>0?container._rowHeight:COMMIT_FILE_ROW_HEIGHT}

  function statusLabel(file){return file.isUntracked?'U':(file.status||'M').slice(0,1).toUpperCase()}
  function isGitlinkFile(file){return file.isSubmodule===true}
  function actionButton(action,section,path,icon,title){
    const button=document.createElement('button');
    button.className='icon-btn';
    button.dataset.action=action;
    button.dataset.section=section;
    button.dataset.path=path;
    button.title=title;
    const iconElement=document.createElement('span');
    iconElement.className='codicon codicon-'+icon;
    button.appendChild(iconElement);
    return button;
  }
  function fileParts(file){
    const lastSlash=file.path.lastIndexOf('/');
    return {folder:lastSlash>=0?file.path.slice(0,lastSlash):'',name:lastSlash>=0?file.path.slice(lastSlash+1):file.path};
  }

  function commitWorkingTreeSelectionKey(section,path){return section+'\u0000'+path}
  function syncCommitWorkingTreeSelection(container,selection){
    const selected=selection||new Set();
    container.querySelectorAll('.file-row[data-path]').forEach(function(row){
      row.classList.toggle('multi-selected',selected.has(commitWorkingTreeSelectionKey(row.dataset.section||'',row.dataset.path||'')));
    });
  }

  function fileRowHtml(file,section,treeIndent){
    const parts=fileParts(file);
    const row=document.createElement('div');
    row.className='file-row '+(file.isUntracked?'untracked':section);
    row.dataset.path=file.path;
    row.dataset.section=section;
    if(treeIndent)row.style.paddingLeft='30px';
    const status=document.createElement('span');
    status.className='status';
    status.textContent=statusLabel(file);
    const gitlinkLabel=isGitlinkFile(file)?document.createElement('span'):null;
    if(gitlinkLabel){gitlinkLabel.className='gitlink-label';gitlinkLabel.textContent='Repo';gitlinkLabel.title='Submodule repository';}
    const pathElement=document.createElement('span');
    pathElement.className='path';
    pathElement.title=file.path;
    const nameElement=document.createElement('span');
    nameElement.className='file-name';
    nameElement.textContent=parts.name;
    pathElement.appendChild(nameElement);
    if(parts.folder){
      pathElement.appendChild(document.createTextNode(' '));
      const folderElement=document.createElement('span');
      folderElement.className='file-folder';
      folderElement.textContent=parts.folder+'/';
      pathElement.appendChild(folderElement);
    }
    const actions=document.createElement('span');
    actions.className='row-actions';
    if(section==='conflict')actions.appendChild(actionButton('stage',section,file.path,'add','暂存并标记冲突已解决'));
    else if(section==='staged')actions.appendChild(actionButton('unstage',section,file.path,'remove','取消暂存'));
    else if(section==='unstaged'){
      actions.appendChild(actionButton('discard',section,file.path,'discard','放弃更改'));
      actions.appendChild(actionButton('stage',section,file.path,'add','暂存'));
    }
    if(gitlinkLabel)row.appendChild(gitlinkLabel);
    row.appendChild(status);
    row.appendChild(pathElement);
    row.appendChild(actions);
    return row;
  }

  function folderRowHtml(folder,expanded,folderKey){
    const row=document.createElement('div');
    row.className='folder-row';
    row.dataset.folder=folder;
    row.dataset.folderKey=folderKey||folder;
    row.title=folder;
    const chevron=document.createElement('span');
    chevron.className='codicon codicon-chevron-'+(expanded?'down':'right');
    const icon=document.createElement('span');
    icon.className='codicon codicon-folder'+(expanded?'-opened':'');
    const path=document.createElement('span');
    path.className='path';
    path.textContent=folder;
    row.appendChild(chevron);row.appendChild(icon);row.appendChild(path);
    return row;
  }

  function commitFileEntries(files,section,repositoryPath){
    if(displayMode==='flat')return files.map(function(file){return {type:'file',key:'file:'+file.path,file:file,section:section,treeIndent:false};});
    const byFolder=new Map();
    files.forEach(function(file){const folder=fileParts(file).folder;const group=byFolder.get(folder)||[];group.push(file);byFolder.set(folder,group)});
    const entries=[];
    byFolder.forEach(function(folderFiles,folder){
      if(folder){
        const folderKey=repositoryPath+':'+section+':'+folder;
        const expanded=!collapsedFolders.has(folderKey);
        entries.push({type:'folder',key:'folder:'+folder,folder:folder,folderKey:folderKey,expanded:expanded});
        if(!expanded)return;
      }
      folderFiles.forEach(function(file){entries.push({type:'file',key:'file:'+file.path,file:file,section:section,treeIndent:Boolean(folder)});});
    });
    return entries;
  }

  function renderVirtualFileList(container){
    const model=container._virtualModel;
    if(!model)return;
    const files=model.files;
    if(!files.length){
      const empty=document.createElement('div');
      empty.className='empty';
      empty.textContent=model.section==='conflict'?'没有合并冲突':(model.section==='staged'?'没有已暂存的更改':(model.section==='unstaged'?'没有未暂存的更改':'没有已提交的更改'));
      container.replaceChildren(empty);
      return;
    }
    const entries=container._entries||commitFileEntries(files,model.section,model.repositoryPath);
    container._entries=entries;
    const rowHeight=commitRowHeight(container);
    const rect=container.getBoundingClientRect();
    const containerTop=rect.top+window.scrollY;
    const start=Math.max(0,Math.min(entries.length,Math.floor((window.scrollY-containerTop)/rowHeight)-COMMIT_FILE_OVERSCAN));
    const end=Math.max(start,Math.min(entries.length,Math.ceil((window.scrollY+window.innerHeight-containerTop)/rowHeight)+COMMIT_FILE_OVERSCAN));
    const top=document.createElement('div');
    top.className='commit-virtual-spacer';
    top.style.height=(start*rowHeight)+'px';
    const bottom=document.createElement('div');
    bottom.className='commit-virtual-spacer';
    bottom.style.height=(Math.max(0,entries.length-end)*rowHeight)+'px';
    const fragment=document.createDocumentFragment();
    fragment.appendChild(top);
    for(let index=start;index<end;index++){
      const entry=entries[index];
      fragment.appendChild(entry.type==='folder'?folderRowHtml(entry.folder,entry.expanded,entry.folderKey):fileRowHtml(entry.file,entry.section,entry.treeIndent));
    }
    fragment.appendChild(bottom);
    container.replaceChildren(fragment);
    const measured=container.querySelector('.file-row,.folder-row');
    if(measured){
      const nextHeight=measured.getBoundingClientRect().height;
      if(nextHeight>0&&Math.abs(nextHeight-rowHeight)>.5){container._rowHeight=nextHeight;requestAnimationFrame(function(){if(container.isConnected)renderVirtualFileList(container)})}
    }
    syncCommitWorkingTreeSelection(container,model.selectedWorkingTreeFiles);
  }

  function refreshCommitVirtualLists(){commitVirtualLists.forEach(function(container){if(container.isConnected)renderVirtualFileList(container);else commitVirtualLists.delete(container)})}
  function scheduleCommitVirtualLists(){if(commitVirtualFrame)return;commitVirtualFrame=requestAnimationFrame(function(){commitVirtualFrame=0;refreshCommitVirtualLists()})}
  window.addEventListener('scroll',scheduleCommitVirtualLists,{passive:true});
  window.addEventListener('resize',scheduleCommitVirtualLists,{passive:true});

  function bindCommitVirtualList(container){
    if(container.dataset.virtualInteractionsBound==='1')return;
    container.dataset.virtualInteractionsBound='1';
    container.addEventListener('click',function(event){
      const folder=event.target.closest('.folder-row');
      if(!folder||!container.contains(folder))return;
      const key=folder.dataset.folderKey||folder.dataset.folder;
      if(key){
        if(collapsedFolders.has(key))collapsedFolders.delete(key);else collapsedFolders.add(key);
        container._entries=undefined;
        renderVirtualFileList(container)
      }
    });
  }

  function renderFileList(container,files,section,repositoryPath,selectedWorkingTreeFiles){
    container._files=files;
    container._selectedWorkingTreeFiles=selectedWorkingTreeFiles;
    container._virtualModel={files:files,section:section,repositoryPath:repositoryPath,selectedWorkingTreeFiles:selectedWorkingTreeFiles};
    // 文件数组、section 或显示模式变化时才重建完整索引；滚动只复用缓存的 entries。
    container._entries=undefined;
    commitVirtualLists.add(container);
    bindCommitVirtualList(container);
    renderVirtualFileList(container);
  }

`