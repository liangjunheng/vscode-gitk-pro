import { renderMergeEditorHtml } from './mergeEditorDocument';

/** Isolated Monaco controls inside the aggregate card; the outer document owns sessions and drafts. */
export function mergeEditorCardSource(csp: string, monaco: string, icons: string, nonce: string): string {
    const html = renderMergeEditorHtml(csp, monaco, icons, nonce, true);
    return `
const mergeFrameHtml=${JSON.stringify(html).replace(/</g, '\\u003c')};
const mergeDrafts=new Map(),mergePending=new Map();
function mergeKey(entry){return JSON.stringify([lastIdentity,entry.path])}
function mergeTheme(){const style=getComputedStyle(document.documentElement),theme={};for(let i=0;i<style.length;i++){const key=style[i];if(key.startsWith('--vscode-'))theme[key]=style.getPropertyValue(key)}return {theme,themeClass:document.body.className}}
function requestMerge(entry){queueMicrotask(()=>{if(!cards.includes(entry))return;const key=mergeKey(entry);if(mergeDrafts.has(key)||mergePending.has(key))return;mergePending.set(key,true);window.gitkVscode.postMessage({type:'loadMerge',key:entry.path,identity:lastIdentity})})}
function mountMerge(entry){
 entry.staticContent=true;entry.bodyHeight=620;entry.navigationChangeCount=0;entry.body.style.height='620px';
 const key=mergeKey(entry),data=mergeDrafts.get(key);
 if(!data){entry.body.textContent='Loading merge inputs...';requestMerge(entry);return}
 if(data.error){entry.body.textContent=data.error;const retry=document.createElement('button');retry.textContent='Reload Conflict';retry.onclick=()=>{mergeDrafts.delete(key);mountMerge(entry)};entry.body.append(retry);return}
 if(data.complete){entry.body.textContent='Merge completed';return}
 if(entry.mergeFrame)return;
 const frame=document.createElement('iframe');frame.className='merge-editor-frame';frame.title='Merge Editor: '+entry.filePath;frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.style.cssText='border:0;width:100%;height:620px;display:block';entry.mergeFrame=frame;
 const initialize=()=>{if(entry.mergeFrame!==frame)return;const snapshot=Object.assign({},data.snapshot,mergeTheme(),{plan:data.plan||data.snapshot.plan,history:data.history,historyIndex:data.historyIndex,selected:data.selected,busy:data.busy});frame.contentWindow.postMessage(snapshot,'*')};
 entry.mergeInitialize=initialize;entry.body.replaceChildren(frame);frame.srcdoc=mergeFrameHtml;
}
function disposeMerge(entry){if(entry.mergeFrame){entry.mergeFrame.remove();entry.mergeFrame=null;entry.mergeInitialize=null}}
function mergeHostMessage(message){
 if(message.type==='mergeLoaded'){
  const key=JSON.stringify([message.identity,message.key]);mergePending.delete(key);
  if(mergeDrafts.has(key))return;
  mergeDrafts.set(key,message);const entry=cardByPath.get(message.key);
  if(message.identity===lastIdentity&&entry&&entry.card){mountMerge(entry)}return;
 }
 if(message.type==='mergeSaved'){
  for(const [key,data] of mergeDrafts){if(data.sessionId!==message.sessionId)continue;data.busy=false;if(!message.error){data.saved=data.plan&&data.plan.result;data.dirty=false;data.complete=message.complete===true}
   const entry=cardByPath.get(message.key);if(entry&&entry.mergeFrame&&data===mergeDrafts.get(mergeKey(entry)))entry.mergeFrame.contentWindow.postMessage({type:'saved',error:message.error},'*');break;
  }
 }
}
window.addEventListener('message',event=>{
 if(event.data?.type!=='mergeFrame')return;
 const entry=cards.find(c=>c.mergeFrame&&c.mergeFrame.contentWindow===event.source);if(!entry)return;
 const data=mergeDrafts.get(mergeKey(entry)),message=event.data.message;if(!data||!message)return;
 if(message.type==='ready'){entry.mergeInitialize();return}
 if(message.type==='focus'){clickedPath=entry.path;setActive(entry.path,true);return}
 if(message.type==='draft'){data.plan=message.plan;data.history=message.history;data.historyIndex=message.historyIndex;data.selected=message.selected;data.dirty=message.content!==(data.saved??data.snapshot.plan.result);window.gitkVscode.postMessage({type:'mergeDraft',sessionId:data.sessionId,content:message.content});return}
 if(message.type==='save'&&!data.busy){data.busy=true;window.gitkVscode.postMessage({type:'saveMerge',key:entry.path,sessionId:data.sessionId,content:message.content,remaining:message.remaining,complete:message.complete})}
});
new MutationObserver(()=>{for(const entry of cards)if(entry.mergeFrame)entry.mergeFrame.contentWindow.postMessage(Object.assign({type:'theme'},mergeTheme()),'*')}).observe(document.body,{attributes:true,attributeFilter:['class','style']});
`;
}
