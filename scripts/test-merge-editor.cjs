const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createMergePlan, mergeInputLabels, MergeEditor } = require('../out/webview/mergeEditor');
const { renderMergeEditorHtml } = require('../out/webview/mergeEditorDocument');
const { loadNativeGitBinding } = require('../out/git/nativeGitBinding');

async function main() {
    assert.equal(createMergePlan('one\ntwo\nthree\n', 'ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n').result, 'ONE\ntwo\nTHREE\n');
    assert.equal(createMergePlan('base', 'same', 'same').conflicts.length, 0);
    assert.equal(createMergePlan('x\n', '', 'x\n').result, '');
    assert.deepEqual(mergeInputLabels('<<<<<<< Updated upstream\nours\n=======\ntheirs\n>>>>>>> Stashed changes\n'), { currentLabel: 'Current', incomingLabel: 'Stashed Changes' });
    assert.deepEqual(mergeInputLabels('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n'), { currentLabel: 'Current', incomingLabel: 'Incoming' });
    const markers = 'prefix edited\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nsuffix\n';
    const plan = createMergePlan('prefix\nbase\nsuffix\n', 'prefix\nours\nsuffix\n', 'prefix\ntheirs\nsuffix\n', markers);
    assert.equal(plan.manualOnly, false); assert.ok(plan.result.startsWith('prefix edited\n'));
    const editor = new MergeEditor(plan);
    editor.edit(0, 0, 'manual\n');
    editor.choose(0, 'both');
    assert.equal(editor.result, 'manual\nprefix edited\nours\ntheirs\nsuffix\n');
    assert.equal(editor.remaining, 0);
    editor.choose(0, 'incomingFirst');
    assert.equal(editor.result, 'manual\nprefix edited\ntheirs\nours\nsuffix\n');
    editor.ignore(0, 'incoming'); assert.equal(editor.result, 'manual\nprefix edited\nours\nsuffix\n');
    editor.ignore(0, 'current'); assert.equal(editor.result, 'manual\nprefix edited\nbase\nsuffix\n'); assert.equal(editor.remaining, 1);
    editor.choose(0, 'both');
    editor.edit(editor.conflicts[0].start, 1, 'T'); assert.equal(editor.remaining, 1);
    editor.choose(0, 'manual'); assert.equal(editor.remaining, 0);
    const preserved = createMergePlan('a\n', 'b\n', 'c\n', 'custom result\n');
    assert.equal(preserved.result, 'custom result\n'); assert.equal(preserved.manualOnly, true);
    const html = renderMergeEditorHtml('http://fixture', 'http://fixture/vs', 'icons', 'test').replace('<style>', '<style>:root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#ccc;--vscode-editor-foreground:#ccc;--vscode-font-family:Arial;--vscode-editorWidget-background:#252526;--vscode-widget-border:#454545;--vscode-panel-border:#444;--vscode-descriptionForeground:#aaa;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-focusBorder:#0078d4}');
    for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
    await verifyNative();
    await verifyBrowser(html, plan);
    console.log('Merge Editor: model, native conflict stages/save/stale guard, Monaco interactions passed');
}

async function verifyNative() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-merge-'));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
    const binding = loadNativeGitBinding();
    const invoke = async (op, payload={}) => JSON.parse(await binding.invoke(op, JSON.stringify({ rootPath: root, ...payload })));
    try {
        git('init'); git('config','user.name','Merge Test'); git('config','user.email','merge@test'); git('config','core.autocrlf','false');
        const file = path.join(root,'file.gkt');
        fs.writeFileSync(file,'base\n');git('add','.');git('commit','-m','base');
        const branch = git('branch','--show-current');git('checkout','-b','incoming');
        fs.writeFileSync(file,'incoming\n');git('commit','-am','incoming');git('checkout',branch);
        fs.writeFileSync(file,'current\n');git('commit','-am','current');
        try { git('merge','incoming'); } catch {}
        const data = await invoke('readMergeConflict',{path:'file.gkt'});
        assert.deepEqual(data.stages.map(s=>s.content), ['base\n','current\n','incoming\n']);
        assert.ok(data.worktree.includes('<<<<<<<'));
        await assert.rejects(()=>invoke('readMergeConflict',{path:'../escape'}), /Invalid merge path/);
        await assert.rejects(()=>invoke('saveMergeResult',{path:'file.gkt',...data,content:data.worktree,complete:true}), /markers/);
        fs.writeFileSync(file, data.worktree+'external\n');
        await assert.rejects(()=>invoke('saveMergeResult',{path:'file.gkt',...data,content:'ours\n',complete:true}), /changed externally/);
        fs.writeFileSync(file,data.worktree.replace(/\n/g,'\r\n'));
        const crlf = await invoke('readMergeConflict',{path:'file.gkt'});
        const saved = await invoke('saveMergeResult',{path:'file.gkt',...crlf,content:'resolved\n',complete:false});
        assert.equal(saved.worktree,'resolved\r\n');assert.ok(git('ls-files','-u').length);
        await assert.rejects(()=>invoke('saveMergeResult',{path:'file.gkt',...crlf,content:'old\n'}), /changed externally/);
        await invoke('saveMergeResult',{path:'file.gkt',...crlf,worktree:saved.worktree,content:'resolved\n',complete:true});
        assert.equal(git('ls-files','-u'),'');assert.equal(git('show',':file.gkt'),'resolved');
        await assert.rejects(()=>invoke('readMergeConflict',{path:'file.gkt'}), /no longer/);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

async function verifyBrowser(html, plan) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({channel:'msedge',headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1200,height:800}});
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.route('http://fixture/**',route=>{
            const pathname = new URL(route.request().url()).pathname;
            if(pathname==='/'){return route.fulfill({body:html,contentType:'text/html'})}
            const file=path.resolve(__dirname,'../media/monaco',pathname.slice(1));
            if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});
            return route.fulfill({body:'',status:404});
        });
        await page.addInitScript(()=>{window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m)})});
        await page.goto('http://fixture/');
        await page.waitForFunction(()=>window.messages.some(m=>m.type==='ready'));
        await page.evaluate(plan=>window.dispatchEvent(new MessageEvent('message',{data:{type:'snapshot',path:'file.txt',base:'prefix\nbase\nsuffix\n',current:'prefix\nours\nsuffix\n',incoming:'prefix\ntheirs\nsuffix\n',plan}})),plan);
        await page.waitForFunction(()=>document.querySelectorAll('.editor > .monaco-editor').length===4).catch(async error=>{console.error('browser initialization', errors, await page.locator('#status').textContent(), await page.locator('.monaco-editor').count());throw error});
        assert.equal(await page.locator('#complete').isDisabled(),true);
        await page.locator('[data-choice="both"]').click();
        assert.equal(await page.locator('#complete').isDisabled(),false);
        const result=await page.evaluate(()=>monaco.editor.getModels().find(m=>m.getValue().startsWith('prefix edited')).getValue());
        assert.equal(result,'prefix edited\nours\ntheirs\nsuffix\n');
        await page.locator('#result .view-lines').click();await page.keyboard.press('Control+z');
        assert.equal(await page.locator('#complete').isDisabled(),true);
        await page.keyboard.press('Control+Shift+z');assert.equal(await page.locator('#complete').isDisabled(),false);
        await page.locator('#base').click();assert.equal(await page.locator('#base-pane').isVisible(),true);
        await page.locator('#layout').click();
        await page.locator('#save').click();
        assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.type==='save').at(-1).content),result);
        await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'saved'}})));
        await page.locator('#complete').click();assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.type==='save').at(-1).complete),true);
        await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'saved'}})));
        for(const width of [1200,600]){
            await page.setViewportSize({width,height:800});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            await page.screenshot({path:path.join(os.tmpdir(),'gitk-merge-'+width+'.png')});
        }
        assert.deepEqual(errors,[]);
    } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
