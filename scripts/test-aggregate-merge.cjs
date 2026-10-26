const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const {renderMultiDiffHtml}=require('../out/webview/multiDiffPanelDocument');
const {createMergePlan}=require('../out/webview/mergeEditor');

async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const html=renderMultiDiffHtml('http://fixture','http://fixture/icons.css','http://fixture/vs','test').replace('<style>', '<style>:root{--vscode-editor-font-family:Consolas,monospace;--vscode-editor-font-size:16px;--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-editor-foreground:#cccccc;--vscode-tab-activeForeground:#ffffff;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#aaaaaa;--vscode-widget-border:#454545;--vscode-editorGroup-border:#454545;--vscode-panel-border:#454545;--vscode-focusBorder:#007acc;--vscode-button-background:#0e639c;--vscode-button-hoverBackground:#1177bb;--vscode-button-foreground:#ffffff}');
  for(const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Function(m[1]);
  await page.route('http://fixture/**',route=>{
   const name=new URL(route.request().url()).pathname;
   if(name==='/')return route.fulfill({body:html,contentType:'text/html'});
   const file=name.startsWith('/vs/')?path.resolve(__dirname,'../media/monaco',name.slice(1)):path.resolve(__dirname,'../media/codicons',name==='/icons.css'?'codicon.css':'codicon.ttf');
   if(fs.existsSync(file))return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});
   return route.fulfill({status:404,body:''});
  });
  await page.addInitScript(()=>{window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m),getState:()=>({}),setState(){}})});
  await page.goto('http://fixture/');
  const identity='file:///repo\0uncommitted';
  const conflict=name=>({path:name,diffKey:'conflict:'+name,workingTreeKind:'conflict',status:'U',loaded:true,original:'base\n',modified:'markers\n'});
  const diffs=[conflict('one.ts'),conflict('two.ts'),
   {path:'normal.ts',diffKey:'unstaged:normal.ts',workingTreeKind:'unstaged',status:'M',loaded:true,original:'before\n',modified:'after\n'},
   {path:'staged.ts',diffKey:'staged:staged.ts',workingTreeKind:'staged',status:'M',loaded:true,original:'before\n',modified:'index\n'}];
  const publish=data=>page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);
  await publish({type:'snapshot',revision:1,identity,loading:false,editable:true,diffs,total:3,completed:3,selectionEpoch:1,revealPath:'conflict:one.ts'});
  await page.waitForFunction(()=>window.messages.filter(m=>m.type==='loadMerge').length===2);
  assert.deepEqual(await page.locator('.diff').evaluateAll(cards=>cards.map(card=>card.dataset.workingTreeKind)), ['conflict','conflict','unstaged','staged'], 'MultiDiff uses the same Merge / Unstaged / Staged order');
  const colors=await page.locator('.diff').evaluateAll(cards=>cards.map(card=>({
   kind:card.dataset.workingTreeKind,border:getComputedStyle(card).borderTopColor,
   pinned:getComputedStyle(card.querySelector('.pinned-group')).borderTopColor,
   outline:getComputedStyle(card.querySelector('.pinned-group'),'::after').borderTopColor,
   background:getComputedStyle(card.querySelector('.file-header')).backgroundColor
  })));
  assert.equal(colors[0].border,'rgb(0, 122, 204)','selected conflict card uses the standard focus border');
  assert.match(colors[1].border,/0\.3\)|30%/,'unselected conflict card outline uses 30 percent red');
  assert.match(colors[2].border,/0\.3\)|30%/,'unstaged card outline uses 30 percent yellow');
  assert.equal(colors[0].pinned,'rgb(0, 122, 204)','selected conflict sticky header uses the standard focus outline');
  assert.equal(colors[0].outline,'rgb(0, 122, 204)','selected conflict sticky header cap uses the standard focus outline');
  for(const color of colors.slice(1).filter(color=>color.kind!=='staged')){assert.equal(color.pinned,color.border);assert.equal(color.outline,color.border)}
  assert.notEqual(colors[0].background,colors[2].background,'header backgrounds reflect status');
  assert.notEqual(colors[0].pinned,colors[1].pinned,'selected conflict card promotes the sticky header outline');
  const firstPrefix=Array.from({length:40},(_,i)=>'prefix '+i+'\n').join(''),firstSuffix=Array.from({length:40},(_,i)=>'suffix '+i+'\n').join('');
  const firstBase=firstPrefix+'base\n'+firstSuffix,firstCurrent=firstPrefix+'ours\n'+firstSuffix,firstIncoming=firstPrefix+'theirs\n'+firstSuffix;
  const firstPlan=createMergePlan(firstBase,firstCurrent,firstIncoming),firstExpected=firstPrefix+'theirs\nours\n'+firstSuffix;
  await publish({type:'mergeLoaded',key:'conflict:one.ts',identity,sessionId:1,snapshot:{type:'snapshot',path:'one.ts',base:firstBase,current:firstCurrent,incoming:firstIncoming,currentLabel:'Current',incomingLabel:'Stashed Changes',plan:firstPlan,automaticPlan:firstPlan}});
  const secondBase=Array.from({length:80},(_,i)=>'line '+(i+1)+'\n').join('');
  const secondCurrent=secondBase.replace('line 10\n','current 10\n').replace('line 60\n','current 60\n');
  const secondIncoming=secondBase.replace('line 10\n','incoming 10\n').replace('line 60\n','incoming 60\n');
  const secondPlan=createMergePlan(secondBase,secondCurrent,secondIncoming);
  await publish({type:'mergeLoaded',key:'conflict:two.ts',identity,sessionId:2,snapshot:{type:'snapshot',path:'two.ts',base:secondBase,current:secondCurrent,incoming:secondIncoming,plan:secondPlan,automaticPlan:secondPlan}});
  await page.waitForFunction(()=>document.querySelectorAll('.merge-card').length===2);
  const first=page.locator('.merge-card').nth(0),second=page.locator('.merge-card').nth(1);
  await page.waitForFunction(()=>{const root=document.querySelector('.merge-card');if(!root)return false;const editors=monaco.editor.getEditors().filter(editor=>root.contains(editor.getDomNode()));return editors.length===3&&editors.every(editor=>editor.getVisibleRanges().some(range=>range.startLineNumber<=41&&range.endLineNumber>=41))});
  const firstVisible=await first.evaluate(root=>monaco.editor.getEditors().filter(editor=>root.contains(editor.getDomNode())).map(editor=>({path:editor.getModel().uri.path,ranges:editor.getVisibleRanges().map(range=>[range.startLineNumber,range.endLineNumber])})));
  assert.ok(firstVisible.length===3&&firstVisible.every(editor=>editor.ranges.some(range=>range[0]<=41&&range[1]>=41)),'all three panes initially reveal the first conflict: '+JSON.stringify(firstVisible));
  await page.waitForFunction(()=>monaco.editor.getEditors().some(editor=>editor.getModel()?.uri.scheme!=='gitk-merge'&&editor.getModel()?.getValue()==='after\n'));
  const typography=await page.evaluate(()=>{
   const editors=monaco.editor.getEditors();
   const normal=editors.find(editor=>editor.getModel()?.uri.scheme!=='gitk-merge'&&editor.getModel()?.getValue()==='after\n');
   const read=editor=>{const font=editor.getOption(monaco.editor.EditorOption.fontInfo);return {fontFamily:font.fontFamily,fontSize:font.fontSize,fontWeight:font.fontWeight,lineHeight:font.lineHeight,letterSpacing:font.letterSpacing,language:editor.getModel().getLanguageId()}};
   return {normal:read(normal),merge:editors.filter(editor=>editor.getModel()?.uri.scheme==='gitk-merge').map(read)};
  });
  assert.equal(typography.normal.fontSize,16,'Diff uses the configured VS Code editor size');
  assert.ok(typography.merge.length===6,'Both merge cards expose three editors');
  for(const font of typography.merge)assert.deepEqual(font,typography.normal,'Merge panes use the same editor typography and language as Diff cards');
  for(const width of [1200,640]){
   await page.setViewportSize({width,height:900});
   for(const selector of ['.merge-result h3','.merge-result-host']){
    await first.locator(selector).evaluate(target=>{
     const header=target.closest('.diff').querySelector('.pinned-group');
     window.scrollBy(0,target.getBoundingClientRect().top-header.getBoundingClientRect().height+16);
    });
    await page.waitForFunction(()=>{
     const card=document.querySelector('.merge-card')?.closest('.diff');
     if(!card)return false;
     const header=card.querySelector('.pinned-group'),rect=header.getBoundingClientRect();
     return rect.top>=-1&&rect.top<2;
    });
    const layering=await first.evaluate(root=>{
     const header=root.closest('.diff').querySelector('.pinned-group'),rect=header.getBoundingClientRect();
     const overlay=document.createElement('div');
     overlay.style.cssText='position:fixed;inset:0;z-index:9999';
     root.querySelector('.merge-result').append(overlay);
     const points=[rect.left+20,rect.left+rect.width/2,rect.right-20];
     const headerOnTop=points.every(x=>header.contains(document.elementFromPoint(x,rect.top+rect.height-8)));
     overlay.remove();
     return {isolation:getComputedStyle(root).isolation,headerOnTop};
    });
    assert.equal(layering.isolation,'isolate','Merge contents have their own stacking context');
    assert.equal(layering.headerOnTop,true,'Sticky file header stays above the Result title and Monaco content');
   }
  }
  await page.setViewportSize({width:1200,height:900});
  await page.evaluate(()=>window.scrollTo(0,0));
  const mergeHeights=await page.locator('.merge-card').evaluateAll(cards=>cards.map(card=>({height:card.getBoundingClientRect().height,viewport:innerHeight})));
  assert.ok(mergeHeights.every(metric=>Math.abs(metric.height-metric.viewport*.85)<2),'Merge cards occupy 85 percent of the container height');
  await first.locator('.merge-status').filter({hasText:'1 Conflict Remaining'}).waitFor();
  await second.locator('.merge-status').filter({hasText:'2 Conflicts Remaining'}).waitFor();
  const mergeWidths=await page.locator('.merge-card').evaluateAll(cards=>cards.map(card=>{const rect=card.getBoundingClientRect(),inputs=card.querySelector('.merge-inputs').getBoundingClientRect(),panes=[...card.querySelectorAll('.merge-pane')].map(pane=>pane.getBoundingClientRect());return {card:rect.width,inputs:inputs.width,panes:panes.map(pane=>pane.width)}}));
  for(const width of mergeWidths){assert.ok(width.card>900);assert.ok(Math.abs(width.card-width.inputs)<2);assert.ok(width.panes.every(pane=>pane>width.card*.45))}
  const verticalScrollbars=await first.locator('.monaco-scrollable-element > .scrollbar.vertical').evaluateAll(nodes=>nodes.map(node=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return {display:style.display,width:rect.width,opacity:style.opacity}}));
  assert.ok(verticalScrollbars.every(scrollbar=>scrollbar.display==='none'||scrollbar.width===0||scrollbar.opacity==='0'),'Merge panes do not expose individual vertical scrollbars');
  const automaticButton=first.locator('.merge-title-action.codicon-wand');assert.equal(await automaticButton.count(),1);assert.equal(await automaticButton.isDisabled(),true);assert.equal(await automaticButton.getAttribute('title'),'No non-conflicting changes to apply');
  assert.equal(await first.locator('.merge-title-action.codicon-discard').count(),1);
  assert.deepEqual(await first.locator('.merge-input-zone').evaluateAll(actions=>actions.map(action=>action.textContent.trim())),['Accept Stashed ChangesAccept Combination (Stashed Changes First)Ignore','Accept CurrentAccept Combination (Current First)Ignore']);
  const ignoreUi=await first.locator('.merge-pane-incoming .merge-input-zone').evaluate(zone=>{const accept=zone.querySelector('button'),ignore=[...zone.querySelectorAll('button')].find(button=>button.textContent==='Ignore'),read=button=>{const style=getComputedStyle(button);return {color:style.color,background:style.backgroundColor,fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,height:style.height}};return {accept:read(accept),ignore:read(ignore),ignoreActive:ignore.classList.contains('active')}});
  assert.deepEqual(ignoreUi.ignore,ignoreUi.accept,'Ignore uses the same typography, color, background and height as the other conflict actions');
  assert.equal(ignoreUi.ignoreActive,false,'Ignore is not highlighted merely because that side has not been accepted');
  assert.equal(await first.locator('.merge-result-zone').filter({hasText:'No Changes Accepted'}).count(),1);
  assert.equal(await first.locator('.merge-accept-all.codicon-check-all').count(),2);
  const titleActions=await first.locator('.merge-title-actions').evaluate(node=>[...node.children].map(child=>child.className));
  assert.deepEqual(titleActions,['merge-status merge-status-button','merge-title-action codicon codicon-wand','merge-title-action codicon codicon-discard']);
  const headerActions=page.locator('.diff').nth(0).locator('.diff-actions');
  assert.deepEqual(await headerActions.locator('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label'))),['Previous Conflict','Next Conflict','在编辑器中打开当前文件'],'conflict navigation sits immediately left of Open Current File');
  assert.deepEqual(await headerActions.locator('.merge-header-conflict-nav .codicon').evaluateAll(icons=>icons.map(icon=>icon.className)),['codicon codicon-arrow-up','codicon codicon-arrow-down'],'title-bar conflict navigation uses arrow icons instead of chevrons');
  assert.equal(await first.locator('.merge-header-conflict-nav,.merge-conflict-nav').count(),0,'Result title no longer owns conflict navigation');
  const conflictFrame=await first.locator('.merge-pane-incoming .merge-input-zone').evaluate(zone=>{const style=getComputedStyle(zone);return {top:style.borderTopWidth,right:style.borderRightWidth,bottom:style.borderBottomWidth,left:style.borderLeftWidth,shadow:style.boxShadow}});
  assert.deepEqual({...conflictFrame,shadow:undefined},{top:'0px',right:'0px',bottom:'0px',left:'0px',shadow:undefined},'the action row has no independent CSS border');
  assert.equal((conflictFrame.shadow.match(/inset/g)||[]).length,3,'one shared frame supplies the action row top, left and right edges');
  assert.equal(await first.locator('.merge-pane-incoming .merge-conflict-top').first().evaluate(edge=>getComputedStyle(edge).boxShadow),'none','there is no yellow divider between conflict actions and changed code');
  assert.ok(await first.locator('.merge-pane-incoming .merge-conflict-frame').count()>0,'the changed lines continue the same outer conflict frame below the actions');
  const secondHeader=page.locator('.diff').nth(1),secondPrevious=secondHeader.getByRole('button',{name:'Previous Conflict'}),secondNext=secondHeader.getByRole('button',{name:'Next Conflict'});
  assert.equal(await secondPrevious.isDisabled(),true);assert.equal(await secondNext.isDisabled(),false);
  const secondConflictLine=secondPlan.conflicts[1].currentLine;
  await second.locator('.merge-status-button').click();
  assert.equal(await secondPrevious.isDisabled(),false);assert.equal(await secondNext.isDisabled(),true);
  let secondVisible=await second.evaluate(root=>monaco.editor.getEditors().filter(editor=>root.contains(editor.getDomNode())).map(editor=>editor.getVisibleRanges().map(range=>[range.startLineNumber,range.endLineNumber])));
  assert.ok(secondVisible.every(ranges=>ranges.some(range=>range[0]<=secondConflictLine&&range[1]>=secondConflictLine)),'clicking the remaining-conflict label reveals the next unresolved conflict in all panes: '+JSON.stringify(secondVisible));
  await secondPrevious.click();assert.equal(await secondPrevious.isDisabled(),true);assert.equal(await secondNext.isDisabled(),false);
  await second.locator('.merge-pane-incoming .merge-input-zone button').filter({hasText:'Accept Incoming'}).first().click();
  await second.locator('.merge-status').filter({hasText:'1 Conflict Remaining'}).waitFor();
  assert.equal(await secondPrevious.isDisabled(),false);assert.equal(await secondNext.isDisabled(),true);
  secondVisible=await second.evaluate(root=>monaco.editor.getEditors().filter(editor=>root.contains(editor.getDomNode())).map(editor=>editor.getVisibleRanges().map(range=>[range.startLineNumber,range.endLineNumber])));
  assert.ok(secondVisible.every(ranges=>ranges.some(range=>range[0]<=secondConflictLine&&range[1]>=secondConflictLine)),'resolving a conflict automatically reveals the next unresolved conflict in all panes: '+JSON.stringify(secondVisible));
  await secondPrevious.click();assert.equal(await secondPrevious.isDisabled(),true);assert.equal(await secondNext.isDisabled(),false);
  await secondNext.click();assert.equal(await secondPrevious.isDisabled(),false);assert.equal(await secondNext.isDisabled(),true);
  secondVisible=await second.evaluate(root=>monaco.editor.getEditors().filter(editor=>root.contains(editor.getDomNode())).map(editor=>editor.getVisibleRanges().map(range=>[range.startLineNumber,range.endLineNumber])));
  assert.ok(secondVisible.every(ranges=>ranges.some(range=>range[0]<=secondConflictLine&&range[1]>=secondConflictLine)),'toolbar conflict navigation still reveals the selected conflict in all panes: '+JSON.stringify(secondVisible));
  await first.locator('.merge-pane-incoming .merge-input-zone button').filter({hasText:'Accept Stashed Changes'}).click();
  assert.equal(await automaticButton.isDisabled(),true,'accepting a conflict does not create pending non-conflicting changes');
  await first.evaluate(root=>{const host=root.querySelector('.merge-result-host'),editor=monaco.editor.getEditors().find(candidate=>host.contains(candidate.getDomNode()));editor.executeEdits('automatic-plan-test',[{range:new monaco.Range(1,1,1,1),text:'manual prefix\n'}])});
  await first.locator('.merge-title-action.codicon-wand:not(:disabled)').waitFor();
  assert.equal(await automaticButton.getAttribute('title'),'Apply non-conflicting changes');
  await automaticButton.click();
  assert.equal(await first.locator('.merge-status').textContent(),'All Conflicts Resolved');
  assert.equal(await first.locator('.merge-result-zone').textContent(),'Stashed Changes Accepted');
  assert.equal(await first.evaluate(root=>monaco.editor.getEditors().find(editor=>root.querySelector('.merge-result-host').contains(editor.getDomNode())).getValue()),firstPrefix+'theirs\n'+firstSuffix,'automatic merge removes the manual non-conflicting edit while preserving accepted conflict choices');
  assert.equal(await automaticButton.isDisabled(),true,'applying the automatic plan disables the button once there is nothing left to change');
  await first.locator('.merge-title-action.codicon-discard').click();
  assert.equal(await first.locator('.merge-status').textContent(),'1 Conflict Remaining');
  await page.screenshot({path:path.join(require('node:os').tmpdir(),'gitk-aggregate-merge-layout.png')});
  await first.locator('.merge-pane-incoming .merge-input-zone button').filter({hasText:'Accept Stashed Changes'}).click();
  assert.equal(await first.locator('.merge-result-zone').textContent(),'Stashed Changes Accepted');
  assert.equal(await first.getByRole('button',{name:'Complete Merge'}).isDisabled(),false);
  await first.locator('.merge-pane-incoming .merge-input-zone button').filter({hasText:'Ignore'}).click();
  assert.equal(await first.locator('.merge-result-zone').textContent(),'No Changes Accepted');
  assert.equal(await first.getByRole('button',{name:'Complete Merge'}).isDisabled(),true);
  await first.locator('.merge-pane-incoming .merge-input-zone button').filter({hasText:'Accept Combination'}).click();
  assert.equal(await first.getByRole('button',{name:'Complete Merge'}).isDisabled(),false);
  assert.equal(await first.evaluate(root=>monaco.editor.getEditors().find(editor=>root.querySelector('.merge-result-host').contains(editor.getDomNode())).getValue()),firstExpected,'the visible Result model matches the accepted combination');
  assert.equal(await second.getByRole('button',{name:'Complete Merge'}).isDisabled(),true);
  await first.getByRole('button',{name:'Complete Merge'}).click();
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='saveMerge')).catch(async error=>{console.error('save diagnostics',errors,await page.evaluate(()=>window.messages),await first.locator('.merge-status').textContent());throw error});
  let message=await page.evaluate(()=>window.messages.filter(m=>m.type==='saveMerge').at(-1));
  assert.equal(message.sessionId,1);assert.equal(message.content,firstExpected);
  await publish({type:'mergeSaved',key:'conflict:one.ts',sessionId:1});
  await publish({type:'snapshot',revision:2,identity,loading:false,editable:true,diffs:diffs.map(d=>({...d})),total:3,completed:3,selectionEpoch:1});
  await first.getByRole('button',{name:'Complete Merge'}).waitFor({state:'visible'});
  assert.equal(await first.getByRole('button',{name:'Complete Merge'}).isDisabled(),false,'refresh keeps resolved choices');
  await page.locator('.file-header').first().click({force:true});await page.locator('.file-header').first().click({force:true});
  await first.getByRole('button',{name:'Complete Merge'}).waitFor({state:'visible'});
  assert.equal(await first.getByRole('button',{name:'Complete Merge'}).isDisabled(),false,'collapse/reopen retains draft');
  await first.getByRole('button',{name:'Complete Merge'}).click();
  await page.waitForFunction(()=>window.messages.filter(m=>m.type==='saveMerge'&&m.complete).length===2).catch(async e=>{console.error('complete diagnostics',errors,await page.evaluate(()=>window.messages),await first.locator('.merge-status').textContent());throw e});
  message=await page.evaluate(()=>window.messages.filter(m=>m.type==='saveMerge').at(-1));assert.equal(message.sessionId,1);
  await publish({type:'mergeSaved',key:'conflict:one.ts',sessionId:1,complete:true});
  await publish({type:'snapshot',revision:3,identity,loading:false,editable:true,diffs:diffs.slice(1),total:2,completed:2,selectionEpoch:1});
  await page.waitForFunction(()=>document.querySelectorAll('.merge-card').length===1);
  assert.equal(await page.locator('.diff[data-path="two.ts"] .merge-card').count(),1);
  await page.screenshot({path:path.join(require('node:os').tmpdir(),'gitk-aggregate-merge.png')});
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.waitForFunction(()=>monaco.editor.getModels().some(model=>model.getValue()==='after\n'));
  assert.equal(await page.locator('.merge-card').count(),1,'normal diff and merge card coexist');
  await page.setViewportSize({width:600,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // A dirty child and an explicit Gitlink commit are independent targets.
  assert.deepEqual(errors,[]);
  // Start the static Gitlink scenario in a fresh document, independent of
  // pending Monaco view callbacks from the text-editor lifecycle scenario.
  await page.goto('http://fixture/');
  const sha='a'.repeat(40),incoming='b'.repeat(40),base='c'.repeat(40);
  const link=kind=>({path:'child',diffKey:kind+':child',workingTreeKind:kind,status:kind==='conflict'?'U':'M',isGitlink:true,loaded:true,
   oldObjectId:base,newObjectId:sha,
   gitlinkWorktreeDirty:true,gitlinkWorktreeChangeCount:2,gitlinkScanPending:false,
   newGitlinkCommit:{hash:sha,shortHash:'aaaaaaa',subject:'pointer moved'},
   gitlinkConflictBaseObjectId:base,gitlinkConflictCurrentObjectId:sha,gitlinkConflictIncomingObjectId:incoming});
  await page.setViewportSize({width:1200,height:900});
  const links=['conflict','unstaged','staged'].map(link);
  await publish({type:'snapshot',revision:20,identity:'file:///gitlinks\0uncommitted',loading:false,editable:true,diffs:links,total:3,completed:3,selectionEpoch:20});
  await page.waitForFunction(()=>document.querySelectorAll('.gitlink-worktree').length===3);
  assert.equal(await page.locator('.gitlink-conflict-stage').count(),3);
  assert.equal(await page.locator('.gitlink-conflict-notice').count(),0);
  assert.ok((await page.locator('.diff[data-diff-key="conflict:child"] .file-meta').textContent()).includes('子模块指针冲突'));
  const unstagedCard=page.locator('.diff[data-diff-key="unstaged:child"]');
  const unstagedMeta=await unstagedCard.locator('.file-meta').textContent();
  assert.ok(unstagedMeta.includes('Submodule commit')&&unstagedMeta.includes('子模块有 2 个未提交变更文件'),'pointer movement and child worktree dirtiness are both shown');
  for(const kind of ['conflict','unstaged','staged']){
   const card=page.locator('.diff[data-diff-key="'+kind+':child"]');
   const commit=card.locator('.gitlink-commit[data-hash="'+sha+'"]');
   await commit.click();
   let message=await page.evaluate(()=>window.messages.filter(m=>m.type==='selectGitlinkCommit').at(-1));
   assert.deepEqual(message,{type:'selectGitlinkCommit',path:'child',hash:sha,key:kind+':child'});
   await card.locator('.gitlink-worktree').click();
   message=await page.evaluate(()=>window.messages.filter(m=>m.type==='selectGitlinkCommit').at(-1));
   assert.equal(message.hash,'uncommitted');assert.equal(message.key,kind+':child');
  }
  const dirtyOnly={...link('unstaged'),oldObjectId:sha,newObjectId:sha,oldGitlinkCommit:{hash:sha,shortHash:'aaaaaaa',subject:'same pointer'}};
  await publish({type:'snapshot',revision:20.5,identity:'file:///gitlinks\0dirty-only',loading:false,editable:true,diffs:[dirtyOnly],total:1,completed:1,selectionEpoch:20.5});
  await page.waitForFunction(()=>document.querySelectorAll('.gitlink-worktree').length===1);
  assert.equal(await page.locator('.gitlink-commit[data-hash="'+sha+'"]').count(),0,'unchanged dirty Gitlink shows only the worktree entry');
  await publish({type:'snapshot',revision:20.75,identity:'file:///gitlinks\0uncommitted',loading:false,editable:true,diffs:links,total:3,completed:3,selectionEpoch:20.75});
  await page.waitForFunction(()=>document.querySelectorAll('.gitlink-worktree').length===3);
  await publish({type:'snapshot',revision:20.8,identity:'file:///gitlinks\0range',loading:false,editable:true,diffs:[{...links[1],workingTreeKind:undefined,gitlinkWorktreeDirty:false,oldObjectId:base,newObjectId:sha,oldGitlinkCommit:{hash:base,shortHash:'ccccccc',subject:'old pointer'},newGitlinkCommit:{hash:sha,shortHash:'aaaaaaa',subject:'new pointer'},gitlinkRangeCommits:[{hash:sha,shortHash:'aaaaaaa',subject:'new pointer'}]}],total:1,completed:1,selectionEpoch:20.8});
  await page.waitForFunction(hash=>document.querySelectorAll('.gitlink-commit[data-hash="'+hash+'"]').length===1,sha);
  assert.equal(await page.locator('.gitlink-commit[data-hash="'+base+'"]').count(),0,'the old index object is not a commit in the gitlink range list');
  await publish({type:'snapshot',revision:20.9,identity:'file:///gitlinks\0uncommitted',loading:false,editable:true,diffs:links,total:3,completed:3,selectionEpoch:20.9});
  await page.waitForFunction(()=>document.querySelectorAll('.gitlink-worktree').length===3);
  await publish({type:'diffUpdates',revision:21,identity:'file:///gitlinks\0uncommitted',loading:false,diffs:[{...links[0],gitlinkConflictIncomingCommit:{hash:incoming,shortHash:'bbbbbbb',subject:'incoming metadata loaded'}}]});
  await page.waitForFunction(()=>document.querySelector('.gitlink-conflict-commits').textContent.includes('incoming metadata loaded'));
  const history={...link(undefined),diffKey:'history:child'};
  await publish({type:'snapshot',revision:22,identity:'file:///gitlinks\0history',loading:false,editable:false,diffs:[history],total:1,completed:1,selectionEpoch:22});
  await page.waitForFunction(()=>document.querySelectorAll('.diff').length===1);
  assert.equal(await page.locator('.gitlink-worktree').count(),0,'history must not expose the live worktree shortcut');
  assert.equal(await page.locator('.gitlink-commit[data-hash="'+sha+'"]').count(),1);
  assert.deepEqual(errors,[]);
  // Check rendered pixels: a correctly colored outline can still be above the viewport.
  const unavailable={...link('conflict'),gitlinkWorktreeDirty:false,gitlinkConflictBaseObjectId:undefined,gitlinkConflictCurrentObjectId:undefined,gitlinkConflictIncomingObjectId:undefined};
  const absent={...link('conflict'),path:'deleted-child',diffKey:'conflict:deleted-child',gitlinkWorktreeDirty:false,gitlinkConflictBaseObjectId:'0'.repeat(40),gitlinkConflictIncomingObjectId:'0'.repeat(40)};
  await publish({type:'snapshot',revision:23,identity:'file:///gitlinks\0missing-stages',loading:false,editable:true,diffs:[unavailable,absent],total:2,completed:2,selectionEpoch:23});
  await page.waitForFunction(()=>document.querySelectorAll('.gitlink-conflict-stage').length===6);
  const missingCard=page.locator('.diff[data-path="child"]'),absentCard=page.locator('.diff[data-path="deleted-child"]');
  assert.equal(await missingCard.locator('.gitlink-conflict-notice').count(),1);
  assert.equal(await missingCard.locator('.gitlink-conflict-stage-unavailable').count(),3);
  assert.ok((await missingCard.textContent()).includes('阶段数据未提供'));
  assert.ok(!(await missingCard.textContent()).includes('Unavailable'));
  assert.equal(await absentCard.locator('.gitlink-conflict-notice').count(),0);
  assert.ok((await absentCard.textContent()).includes('该阶段不存在'));
  assert.ok((await absentCard.textContent()).includes('该侧不存在此子模块'));
  await page.setViewportSize({width:420,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(require('node:os').tmpdir(),'gitk-gitlink-conflict-states.png')});
  for(const width of [1200,640])for(const navigation of [false,true])for(const kind of [undefined,'unstaged','conflict']){
   await page.goto('http://fixture/');
   await page.setViewportSize({width,height:900});
   const tall={path:'sticky-child',diffKey:'sticky-child',status:'M',workingTreeKind:kind,isGitlink:true,loaded:true,
    gitlinkRangeCommits:Array.from({length:60},(_,i)=>({hash:sha,shortHash:'aaaaaaa',subject:'commit '+i}))};
   await publish({type:'snapshot',revision:1,identity:'file:///sticky',loading:false,editable:false,diffs:[tall,{...tall,path:'tail',diffKey:'tail'}],total:2,completed:2,selectionEpoch:1,
    parentCommit:navigation?{hash:sha,title:'Parent commit'}:undefined});
   const card=page.locator('.diff[data-path="sticky-child"]');
   await card.waitFor();
   await card.evaluate(node=>{node.querySelector('.diff-body').style.minHeight='1600px';node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))});
   await page.evaluate(()=>window.scrollTo(0,160));
   await page.waitForFunction(top=>{
    const card=document.querySelector('.diff[data-path="sticky-child"]');
    return card?.classList.contains('selected')&&Math.abs(card.querySelector('.pinned-group').getBoundingClientRect().top-top)<.1;
   },navigation?40:0);
   const header=await card.locator('.pinned-group').boundingBox();
   const image=PNG.sync.read(await page.screenshot());
   const offset=(Math.round(header.y)*image.width+Math.floor(header.x+header.width/2))*4;
   const pixel=[...image.data.subarray(offset,offset+3)];
   assert.ok(pixel[0]<10&&pixel[1]>80&&pixel[2]>150,'Selected sticky header must render its blue top edge inside the viewport: '+pixel);
   await page.evaluate(()=>{beginUserMultiDiffInteraction();suppressSyncUntil=performance.now()+1000;setActive('tail',false)});
   await page.waitForFunction(()=>!document.querySelector('.diff[data-path="sticky-child"]').classList.contains('selected'));
   const unselected=PNG.sync.read(await page.screenshot());
   const inactivePixel=[...unselected.data.subarray(offset,offset+3)];
   assert.ok(!(inactivePixel[0]<10&&inactivePixel[1]>80&&inactivePixel[2]>150),'Deselected sticky header must not retain the blue edge: '+JSON.stringify({width,navigation,kind,inactivePixel,selected:await card.getAttribute('class')}));
  }
  // Real wheel events must chain to the document only at a pane's boundary.
  await page.goto('http://fixture/');
  await page.setViewportSize({width:1200,height:900});
  const scrollIdentity='file:///wheel\0uncommitted';
  const scrollDiffs=[conflict('before.ts'),conflict('wheel.ts'),conflict('after.ts')];
  await publish({type:'snapshot',revision:1,identity:scrollIdentity,loading:false,editable:true,diffs:scrollDiffs,total:3,completed:3,selectionEpoch:1});
  await page.waitForFunction(()=>window.messages.filter(m=>m.type==='loadMerge').length===3);
  const baseText=Array.from({length:200},(_,i)=>'line '+i+'\n').join('');
  const currentText=baseText.replace('line 100\n','ours\n'),incomingText=baseText.replace('line 100\n','theirs\n');
  for(const [i,name] of ['before.ts','wheel.ts','after.ts'].entries())await publish({type:'mergeLoaded',key:'conflict:'+name,identity:scrollIdentity,sessionId:i+1,snapshot:{type:'snapshot',path:name,base:baseText,current:currentText,incoming:incomingText,plan:createMergePlan(baseText,currentText,incomingText)}});
  await page.waitForFunction(()=>document.querySelectorAll('.merge-card').length===3);
  for(const selector of ['.merge-pane:nth-child(1) .merge-editor-host','.merge-pane:nth-child(2) .merge-editor-host','.merge-result-host']){
   const host=page.locator('.diff[data-path="wheel.ts"] '+selector);
   for(const [boundary,delta] of [['top',-120],['bottom',120],['middle',120],['top',120],['bottom',-120]]){
    const before=await host.evaluate(async(node,boundary)=>{
     window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
     const card=node.closest('.diff');
     window.scrollTo(0,window.scrollY+card.getBoundingClientRect().top-60);
     await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
     const editor=monaco.editor.getEditors().find(editor=>node.contains(editor.getDomNode()));
     const max=editor.getScrollHeight()-editor.getLayoutInfo().height;
     editor.setScrollTop(boundary==='top'?0:boundary==='bottom'?max:Math.floor(max/2));
     return {page:window.scrollY,top:editor.getScrollTop()};
    },boundary);
    const rect=await host.boundingBox();
    await page.mouse.move(rect.x+rect.width/2,rect.y+Math.min(50,rect.height/2));
    await page.mouse.wheel(0,delta);
    if((boundary==='top'&&delta<0)||(boundary==='bottom'&&delta>0)){
     await page.waitForFunction(({page,delta})=>delta<0?window.scrollY<page:window.scrollY>page,{page:before.page,delta});
    }else{
     await host.evaluate(async(node,{top,delta})=>{
      const editor=monaco.editor.getEditors().find(editor=>node.contains(editor.getDomNode()));
      for(let i=0;i<60;i++){
       if(delta<0?editor.getScrollTop()<top:editor.getScrollTop()>top)return;
       await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      throw new Error('Wheel did not scroll the merge pane');
     },{top:before.top,delta});
     assert.equal(await page.evaluate(()=>window.scrollY),before.page,'Internal scrolling must not move the document');
    }
   }
  }
  assert.deepEqual(errors,[]);
  for(const delta of [-120,120]){
   const host=page.locator('.diff[data-path="wheel.ts"] .merge-result-host');
   const before=await host.evaluate(async node=>{
    window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    const card=node.closest('.diff');
    window.scrollTo(0,window.scrollY+card.getBoundingClientRect().top-60);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const editors=monaco.editor.getEditors().filter(editor=>card.contains(editor.getDomNode()));
    for(const editor of editors)editor.getModel().setValue('short\n');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return window.scrollY;
   });
   const rect=await host.boundingBox();
   await page.mouse.move(rect.x+rect.width/2,rect.y+40);
   await page.mouse.wheel(0,delta);
   await page.waitForFunction(({before,delta})=>delta<0?window.scrollY<before:window.scrollY>before,{before,delta});
  }
  assert.deepEqual(errors,[]);
  console.log('Aggregate Merge: multiple conflict cards, normal diff, isolated save, refresh/collapse persistence, completion removal passed');
 }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
