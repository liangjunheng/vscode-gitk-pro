/**
 * Commit 面板 webview 的文件列表脚本片段: 状态图标、行操作按钮、单行 HTML 与列表增量渲染。
 * 按原样迁移自 commitPanelDocument; 与骨架及其他片段拼接在同一个 IIFE 内, 共享作用域。
 */
export const COMMIT_FILE_LIST_SCRIPT = `
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
    return {
      folder:lastSlash>=0?file.path.slice(0,lastSlash):'',
      name:lastSlash>=0?file.path.slice(lastSlash+1):file.path,
    };
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
    if(section==='staged'){
      actions.appendChild(actionButton('unstage',section,file.path,'remove','取消暂存'));
    }else if(section==='unstaged'){
      actions.appendChild(actionButton('discard',section,file.path,'discard','放弃更改'));
      actions.appendChild(actionButton('stage',section,file.path,'add','暂存'));
    }
    if(gitlinkLabel)row.appendChild(gitlinkLabel);
    row.appendChild(status);
    row.appendChild(pathElement);
    row.appendChild(actions);
    return row;
  }

  function renderFileList(container,files,section,repositoryPath){
    const previous=new Map();
    Array.from(container.children).forEach(function(node){if(node.dataset.key)previous.set(node.dataset.key,node)});
    const next=[];
    const useNode=function(key,create,signature){
      let node=previous.get(key);
      if(node&&node._signature===signature){previous.delete(key);return node}
      if(node)node.remove();
      node=create();node.dataset.key=key;node._signature=signature;return node;
    };
    const appendFile=function(file,treeIndent){
      const key='file:'+file.path;
      const signature=JSON.stringify([file.status,file.isUntracked,file.isSubmodule,treeIndent]);
      next.push(useNode(key,function(){return fileRowHtml(file,section,treeIndent)},signature));
    };
    if(!files.length){
      next.push(useNode('empty',function(){const empty=document.createElement('div');empty.className='empty';return empty},section));
      next[0].textContent=section==='staged'?'没有已暂存的更改':(section==='unstaged'?'没有未暂存的更改':'没有已提交的更改');
    }else if(displayMode==='flat'){
      files.forEach(function(file){appendFile(file,false)});
    }else{
      const byFolder=new Map();
      files.forEach(function(file){const folder=fileParts(file).folder;const group=byFolder.get(folder)||[];group.push(file);byFolder.set(folder,group)});
      byFolder.forEach(function(folderFiles,folder){
        if(folder){
          const folderKey=repositoryPath+':'+section+':'+folder;
          const key='folder:'+folder;
          const expanded=!collapsedFolders.has(folderKey);
          const folderRow=useNode(key,function(){
            const row=document.createElement('div');row.addEventListener('click',function(){
              if(collapsedFolders.has(folderKey))collapsedFolders.delete(folderKey);else collapsedFolders.add(folderKey);
              renderFileList(container,container._files,section,repositoryPath);
            });return row;
          },String(expanded));
          folderRow.className='folder-row';folderRow.innerHTML='<span class="codicon codicon-chevron-'+(expanded?'down':'right')+'"></span><span class="codicon codicon-folder'+(expanded?'-opened':'')+'"></span><span class="path"></span>';folderRow.querySelector('.path').textContent=folder;folderRow.title=folder;
          next.push(folderRow);if(!expanded)return;
        }
        folderFiles.forEach(function(file){appendFile(file,Boolean(folder))});
      });
    }
    container._files=files;
    next.forEach(function(node,index){const current=container.children[index];if(current!==node)container.insertBefore(node,current||null)});
    previous.forEach(function(node){node.remove()});
  }

`;
