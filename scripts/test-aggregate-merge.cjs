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
  const html=renderMultiDiffHtml('http://fixture','http://fixture/icons.css','http://fixture/vs','test');
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
  assert.equal(colors[0].border,'rgb(241, 76, 76)','selected conflict card stays red');
  assert.equal(colors[1].border,'rgb(241, 76, 76)','unselected conflict card stays red');
  assert.equal(colors[2].border,'rgb(215, 186, 125)','unstaged card is yellow');
  for(const color of colors.filter(color=>color.kind!=='staged')){assert.equal(color.pinned,color.border);assert.equal(color.outline,color.border)}
  assert.notEqual(colors[0].background,colors[2].background,'header backgrounds reflect status');
  for(const [i,name] of ['one.ts','two.ts'].entries())await publish({type:'mergeLoaded',key:'conflict:'+name,identity,sessionId:i+1,snapshot:{type:'snapshot',path:name,base:'base\n',current:'ours\n',incoming:'theirs\n',plan:createMergePlan('base\n','ours\n','theirs\n')}});
  await page.waitForFunction(()=>document.querySelectorAll('iframe.merge-editor-frame').length===2);
  const first=page.frameLocator('iframe').nth(0),second=page.frameLocator('iframe').nth(1);
  await first.locator('#status').filter({hasText:'1 unhandled'}).waitFor();
  await second.locator('#status').filter({hasText:'1 unhandled'}).waitFor();
  await first.locator('[data-choice="both"]').click();
  assert.equal(await first.locator('#complete').isDisabled(),false);
  assert.equal(await second.locator('#complete').isDisabled(),true);
  await first.locator('#save').click();
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='saveMerge'));
  let message=await page.evaluate(()=>window.messages.filter(m=>m.type==='saveMerge').at(-1));
  assert.equal(message.sessionId,1);assert.equal(message.content,'ours\ntheirs\n');
  await publish({type:'mergeSaved',key:'conflict:one.ts',sessionId:1});
  await publish({type:'snapshot',revision:2,identity,loading:false,editable:true,diffs:diffs.map(d=>({...d})),total:3,completed:3,selectionEpoch:1});
  await first.locator('#complete:not([disabled])').waitFor();
  assert.equal(await first.locator('#complete').isDisabled(),false,'refresh keeps resolved choices');
  await page.locator('.file-header').first().click();await page.locator('.file-header').first().click();
  await first.locator('#complete:not([disabled])').waitFor();
  assert.equal(await first.locator('#complete').isDisabled(),false,'collapse/reopen retains draft');
  await first.locator('#complete').click();
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='saveMerge'&&m.complete)).catch(async e=>{console.error('complete diagnostics',errors,await page.evaluate(()=>window.messages),await first.locator('#status').textContent());throw e});
  message=await page.evaluate(()=>window.messages.filter(m=>m.type==='saveMerge').at(-1));assert.equal(message.sessionId,1);
  await publish({type:'mergeSaved',key:'conflict:one.ts',sessionId:1,complete:true});
  await publish({type:'snapshot',revision:3,identity,loading:false,editable:true,diffs:diffs.slice(1),total:2,completed:2,selectionEpoch:1});
  await page.waitForFunction(()=>document.querySelectorAll('iframe.merge-editor-frame').length===1);
  await page.frameLocator('iframe').locator('#path').filter({hasText:'two.ts'}).waitFor();
  await page.screenshot({path:path.join(require('node:os').tmpdir(),'gitk-aggregate-merge.png')});
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.waitForFunction(()=>monaco.editor.getModels().some(model=>model.getValue()==='after\n'));
  assert.equal(await page.evaluate(()=>document.querySelectorAll('iframe').length),1,'normal diff and merge card coexist');
  await page.setViewportSize({width:600,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('Aggregate Merge: multiple conflict cards, normal diff, isolated save, refresh/collapse persistence, completion removal passed');
 }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
