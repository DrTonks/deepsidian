import {EditorState,EditorSelection} from '@codemirror/state';
import {EditorView,keymap} from '@codemirror/view';
import {history,undo,redo} from '@codemirror/commands';
import {markdown} from '@codemirror/lang-markdown';
import {editorInfoField} from 'obsidian';
import {createCompletionExtension,requestCompletion,type CompletionHost} from '../../src/plugin/completion/editor';

/** Real CM6 view/keymap/history; only the Obsidian file association is a fixture. */
export async function checkCompletion(container:HTMLElement=document.body){
  const check=(ok:unknown,label:string)=>{if(!ok)throw Error(label);};
  const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,30));
  const parent=container.ownerDocument.createElement('div');container.append(parent);
  const file={path:'测试.md',basename:'测试',extension:'md'};
  const info={file} as any;
  let enabled=true,calls=0,shown=0,accepted=0,fallbackTabs=0,fallbackEscapes=0;
  const reports:string[]=[];
  let implementation:CompletionHost['complete']=async()=>({text:'补全文字'});
  const host:CompletionHost={enabled:()=>enabled,complete:(input,signal)=>{calls++;return implementation(input,signal);},report:value=>reports.push(value),shown:()=>shown++,accepted:()=>accepted++};
  const instance=createCompletionExtension(host);
  const view=new EditorView({parent,state:EditorState.create({doc:'已有正文',selection:{anchor:4},extensions:[
    markdown(),history(),EditorState.allowMultipleSelections.of(true),editorInfoField.init(()=>info),instance.extension,
    keymap.of([{key:'Tab',run:()=>{fallbackTabs++;return true;}},{key:'Escape',run:()=>{fallbackEscapes++;return true;}}]),
  ]})});
  const key=(name:string)=>view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:name,code:name,bubbles:true,cancelable:true}));
  const ghost=()=>view.dom.querySelector('.deepsidian-completion-ghost')?.textContent;
  const pending=()=>{
    let resolve!:(value:{text:string})=>void,signal!:AbortSignal;
    implementation=async(_input,currentSignal)=>{signal=currentSignal;return new Promise<{text:string}>(done=>{resolve=done;});};
    return {resolve:(text:string)=>resolve({text}),get signal(){return signal;}};
  };
  try{
    view.focus();await tick();key('Tab');check(fallbackTabs===1,'Tab falls through without suggestion');
    view.dispatch({changes:{from:view.state.doc.length,insert:'手写'},selection:{anchor:6},userEvent:'input.type'});
    await requestCompletion(view);await tick();
    check(ghost()==='补全文字','real widget shows completion');check(view.state.doc.toString()==='已有正文手写','ghost is absent from document');
    key('Tab');await tick();check(view.state.doc.toString()==='已有正文手写补全文字'&&accepted===1,'Tab accepts displayed text once');
    check(!ghost(),'accept clears ghost');check(undo(view),'acceptance is undoable');check(view.state.doc.toString()==='已有正文手写','undo isolates acceptance from prior typing');
    check(!ghost(),'undo does not resurrect suggestion');check(redo(view),'acceptance redo works');check(view.state.doc.toString()==='已有正文手写补全文字','redo restores accepted text');

    await requestCompletion(view);await tick();key('Escape');await tick();check(!ghost()&&fallbackEscapes===0,'Escape dismisses candidate');key('Escape');check(fallbackEscapes===1,'Escape without suggestion falls through');
    const changing=pending();const changedRequest=requestCompletion(view);
    view.dispatch({changes:{from:view.state.doc.length,insert:'新'},selection:{anchor:view.state.doc.length+1}});
    check(changing.signal.aborted,'document change aborts request');changing.resolve('过期正文');await changedRequest;await tick();check(!ghost(),'late response after typing is ignored');
    const switching=pending();const switchedRequest=requestCompletion(view);info.file={...file,path:'另一个.md'};switching.resolve('错误文件');await switchedRequest;await tick();check(!ghost(),'same-content file switch invalidates response');info.file=file;

    implementation=async()=>({text:'光标建议'});await requestCompletion(view);await tick();view.dispatch({selection:{anchor:1}});await tick();check(!ghost(),'moving cursor clears candidate');
    view.dispatch({selection:{anchor:view.state.doc.length}});await requestCompletion(view);await tick();
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));await tick();check(!ghost(),'compositionstart clears existing candidate');
    const callsBefore=calls;await requestCompletion(view);check(calls===callsBefore,'composition blocks network request');key('Tab');check(fallbackTabs===2,'Tab is not consumed while composing');
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));await tick();

    view.focus();await tick();implementation=async()=>({text:'one\ntwo'});await requestCompletion(view);await tick();check(!ghost(),'multiline candidate never displays');
    implementation=async()=>({text:'有效建议'});await requestCompletion(view);await tick();check(ghost()==='有效建议','request works after composition');
    enabled=false;key('Tab');check(fallbackTabs===3,'disabled feature never accepts stale candidate');instance.cancelAll();await tick();check(!ghost(),'settings cancellation clears candidate');enabled=true;
    view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(2)])});
    const multipleCalls=calls;await requestCompletion(view);check(calls===multipleCalls,'multiple cursors block request');view.dispatch({selection:{anchor:view.state.doc.length}});
    const blurring=pending();const blurRequest=requestCompletion(view);view.contentDOM.blur();check(blurring.signal.aborted,'blur aborts request');blurring.resolve('失焦建议');await blurRequest;await tick();check(!ghost(),'blurred editor never receives late suggestion');
    view.focus();await tick();const closing=pending();const closeRequest=requestCompletion(view);view.destroy();check(closing.signal.aborted,'destroy aborts request');closing.resolve('销毁建议');await closeRequest;
    check(shown>=4&&reports.length>=2,'show and unavailable status callbacks are exercised');
    const result=container.ownerDocument.createElement('p');result.textContent='ALL COMPLETION CHECKS PASSED: real EditorView, ghost isolation, Tab/Escape, undo/redo, stale response, file switch, composition, blur, destroy';container.append(result);
  }finally{view.destroy();parent.remove();}
}
