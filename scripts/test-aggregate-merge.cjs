const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {renderMultiDiffHtml}=require('../out/webview/multiDiffPanelDocument');
const {createMergePlan}=require('../out/webview/mergeEditor');

async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const html=renderMultiDiffHtml('http://fixture','http://fixture/icons.css','http://fixture/vs','test').replace('<style>', '<style>:root{--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-editor-foreground:#cccccc;--vscode-tab-activeForeground:#ffffff;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#aaaaaa;--vscode-widget-border:#454545;--vscode-editorGroup-border:#454545;--vscode-panel-border:#454545;--vscode-focusBorder:#007acc;--vscode-button-background:#0e639c;--vscode-button-hoverBackground:#1177bb;--vscode-button-foreground:#ffffff}');
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
  for(const [i,name] of ['one.ts','two.ts'].entries())await publish({type:'mergeLoaded',key:'conflict:'+name,identity,sessionId:i+1,snapshot:{type:'snapshot',path:name,base:'base\n',current:'ours\n',incoming:'theirs\n',plan:createMergePlan('base\n','ours\n','theirs\n'),automaticPlan:createMergePlan('base\n','ours\n','theirs\n')}});
  await page.waitForFunction(()=>document.querySelectorAll('.merge-card').length===2);
  const first=page.locator('.merge-card').nth(0),second=page.locator('.merge-card').nth(1);
  const mergeHeights=await page.locator('.merge-card').evaluateAll(cards=>cards.map(card=>({height:card.getBoundingClientRect().height,viewport:innerHeight})));
  assert.ok(mergeHeights.every(metric=>Math.abs(metric.height-metric.viewport*.7)<2),'Merge cards occupy 70 percent of the container height');
  await first.locator('.merge-status').filter({hasText:'1 Conflict Remaining'}).waitFor();
  await second.locator('.merge-status').filter({hasText:'1 Conflict Remaining'}).waitFor();
  const mergeWidths=await page.locator('.merge-card').evaluateAll(cards=>cards.map(card=>{const rect=card.getBoundingClientRect(),inputs=card.querySelector('.merge-inputs').getBoundingClientRect(),panes=[...card.querySelectorAll('.merge-pane')].map(pane=>pane.getBoundingClientRect());return {card:rect.width,inputs:inputs.width,panes:panes.map(pane=>pane.width)}}));
  for(const width of mergeWidths){assert.ok(width.card>900);assert.ok(Math.abs(width.card-width.inputs)<2);assert.ok(width.panes.every(pane=>pane>width.card*.45))}
  const verticalScrollbars=await first.locator('.monaco-scrollable-element > .scrollbar.vertical').evaluateAll(nodes=>nodes.map(node=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return {display:style.display,width:rect.width,opacity:style.opacity}}));
  assert.ok(verticalScrollbars.every(scrollbar=>scrollbar.display==='none'||scrollbar.width===0||scrollbar.opacity==='0'),'Merge panes do not expose individual vertical scrollbars');
  assert.equal(await first.locator('.merge-title-action.codicon-wand').count(),1);
  assert.equal(await first.locator('.merge-title-action.codicon-discard').count(),1);
  assert.deepEqual(await first.locator('.merge-pane-actions').evaluateAll(actions=>actions.map(action=>action.textContent.trim())),['Accept IncomingAccept Combination','Accept CurrentAccept Combination']);
  assert.equal(await first.locator('.merge-accept-all.codicon-check-all').count(),2);
  const titleActions=await first.locator('.merge-title-actions').evaluate(node=>[...node.children].map(child=>child.className));
  assert.deepEqual(titleActions,['merge-title-action codicon codicon-wand','merge-title-action codicon codicon-discard']);
  await first.locator('.merge-title-action.codicon-wand').click();
  assert.equal(await first.locator('.merge-status').textContent(),'1 Conflict Remaining');
  await first.locator('.merge-title-action.codicon-discard').click();
  assert.equal(await first.locator('.merge-status').textContent(),'1 Conflict Remaining');
  await page.screenshot({path:path.join(require('node:os').tmpdir(),'gitk-aggregate-merge-layout.png')});
  await first.locator('.merge-pane-actions button').filter({hasText:'Accept Combination'}).first().click();
  assert.equal(await first.getByRole('button',{name:'Complete Merge'}).isDisabled(),false);
  assert.equal(await second.getByRole('button',{name:'Complete Merge'}).isDisabled(),true);
  await first.getByRole('button',{name:'Complete Merge'}).click();
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='saveMerge')).catch(async error=>{console.error('save diagnostics',errors,await page.evaluate(()=>window.messages),await first.locator('.merge-status').textContent());throw error});
  let message=await page.evaluate(()=>window.messages.filter(m=>m.type==='saveMerge').at(-1));
  assert.equal(message.sessionId,1);assert.equal(message.content,'ours\ntheirs\n');
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
   gitlinkWorktreeDirty:true,gitlinkWorktreeChangeCount:2,gitlinkScanPending:false,
   newGitlinkCommit:{hash:sha,shortHash:'aaaaaaa',subject:'pointer moved'},
   gitlinkConflictBaseObjectId:base,gitlinkConflictCurrentObjectId:sha,gitlinkConflictIncomingObjectId:incoming});
  await page.setViewportSize({width:1200,height:900});
  const links=['conflict','unstaged','staged'].map(link);
  await publish({type:'snapshot',revision:20,identity:'file:///gitlinks\0uncommitted',loading:false,editable:true,diffs:links,total:3,completed:3,selectionEpoch:20});
  await page.waitForFunction(()=>document.querySelectorAll('.gitlink-worktree').length===3);
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
  await publish({type:'diffUpdates',revision:21,identity:'file:///gitlinks\0uncommitted',loading:false,diffs:[{...links[0],gitlinkConflictIncomingCommit:{hash:incoming,shortHash:'bbbbbbb',subject:'incoming metadata loaded'}}]});
  await page.waitForFunction(()=>document.querySelector('.gitlink-conflict-commits').textContent.includes('incoming metadata loaded'));
  const history={...link(undefined),diffKey:'history:child'};
  await publish({type:'snapshot',revision:22,identity:'file:///gitlinks\0history',loading:false,editable:false,diffs:[history],total:1,completed:1,selectionEpoch:22});
  await page.waitForFunction(()=>document.querySelectorAll('.diff').length===1);
  assert.equal(await page.locator('.gitlink-worktree').count(),0,'history must not expose the live worktree shortcut');
  assert.equal(await page.locator('.gitlink-commit[data-hash="'+sha+'"]').count(),1);
  assert.deepEqual(errors,[]);
  console.log('Aggregate Merge: multiple conflict cards, normal diff, isolated save, refresh/collapse persistence, completion removal passed');
 }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
