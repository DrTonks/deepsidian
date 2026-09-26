import {Prec,StateEffect,type Extension} from '@codemirror/state';
import {Decoration,EditorView,ViewPlugin,WidgetType,keymap,type DecorationSet,type ViewUpdate} from '@codemirror/view';
import {isolateHistory} from '@codemirror/commands';
import {completionStatus} from '@codemirror/autocomplete';
import {editorInfoField} from 'obsidian';
import {completionContext,normalizeCompletion,type CompletionInput} from './context';

export interface CompletionHost {
  enabled(path?:string):boolean;
  complete(input:CompletionInput,signal:AbortSignal):Promise<{text:string}>;
  report(message:string):void;
  accepted?():void;
  shown?():void;
}
interface Candidate {text:string;at:number;sequence:number;doc:EditorView['state']['doc'];file:object;path:string}
const display=StateEffect.define<Candidate|null>();
const controllers=new WeakMap<EditorView,CompletionController>();

class Ghost extends WidgetType {
  constructor(readonly text:string){super();}
  eq(other:Ghost){return other.text===this.text;}
  toDOM(view:EditorView){
    const element=view.dom.ownerDocument.createElement('span');
    element.className='deepsidian-completion-ghost';element.textContent=this.text;
    element.setAttribute('aria-hidden','true');element.contentEditable='false';
    return element;
  }
  ignoreEvent(){return true;}
}

class CompletionController {
  decorations:DecorationSet=Decoration.none;
  private candidate:Candidate|null=null;
  private sequence=0;
  private abort?:AbortController;
  private destroyed=false;
  private composing=false;
  private ownerWindow:Window|null;
  private readonly windowBlur=()=>this.cancel();
  constructor(readonly view:EditorView,readonly host:CompletionHost,readonly peers:Set<CompletionController>){
    controllers.set(view,this);peers.add(this);
    this.ownerWindow=view.dom.ownerDocument.defaultView;this.ownerWindow?.addEventListener('blur',this.windowBlur);
  }
  private file(){return this.view.state.field(editorInfoField,false)?.file;}
  private ready(){return !this.destroyed&&this.host.enabled(this.file()?.path)&&this.view.hasFocus&&!this.composing&&!this.view.composing&&!this.view.compositionStarted&&!completionStatus(this.view.state)&&!this.view.state.readOnly&&this.view.state.facet(EditorView.editable)&&this.view.state.selection.ranges.length===1&&this.view.state.selection.main.empty;}
  private valid(value:Candidate){
    const file=this.file();
    return this.ready()&&value.sequence===this.sequence&&value.doc===this.view.state.doc&&value.at===this.view.state.selection.main.head&&!!file&&file===value.file&&file.path===value.path&&file.extension==='md';
  }
  private invalidate(){this.sequence++;this.abort?.abort();this.abort=undefined;this.candidate=null;this.decorations=Decoration.none;}
  cancel(){
    if(this.destroyed)return;
    this.invalidate();this.view.dispatch({effects:display.of(null)});
  }
  update(update:ViewUpdate){
    if(update.docChanged||update.selectionSet||(update.focusChanged&&!this.view.hasFocus))this.invalidate();
    const ownerWindow=this.view.dom.ownerDocument.defaultView;
    if(ownerWindow!==this.ownerWindow){this.ownerWindow?.removeEventListener('blur',this.windowBlur);this.ownerWindow=ownerWindow;ownerWindow?.addEventListener('blur',this.windowBlur);this.invalidate();}
    for(const transaction of update.transactions)for(const effect of transaction.effects)if(effect.is(display)){
      this.candidate=effect.value&&this.valid(effect.value)?effect.value:null;
      this.decorations=this.candidate?Decoration.set([Decoration.widget({widget:new Ghost(this.candidate.text),side:1}).range(this.candidate.at)]):Decoration.none;
    }
    if(this.candidate&&!this.valid(this.candidate))this.invalidate();
  }
  compositionStart(){this.composing=true;this.cancel();}
  compositionEnd(){this.composing=false;this.cancel();}
  async request(){
    for(const peer of this.peers)peer.cancel();
    if(!this.host.enabled(this.file()?.path)){this.host.report('请在 Deepseedian 设置中启用实验性补全，并检查当前文件是否被排除。');return;}
    if(!this.ready()){this.host.report('请在可编辑笔记中放置单个光标，结束输入法组词后再请求补全。');return;}
    const file=this.file();
    if(!file||file.extension!=='md'){this.host.report('仅支持 Markdown 笔记内补全。');return;}
    const input=completionContext(this.view.state,file.basename);
    if(!input){this.host.report('当前位置暂不支持补全，或笔记语法解析尚未就绪。');return;}
    const snapshot:Candidate={text:'',at:this.view.state.selection.main.head,doc:this.view.state.doc,file,path:file.path,sequence:this.sequence};
    const abort=new AbortController();this.abort=abort;
    try{
      const result=await this.host.complete(input,abort.signal);
      if(abort.signal.aborted||!this.valid(snapshot))return;
      const text=normalizeCompletion(result.text,input);
      if(!text){this.host.report('此次没有可用的单行补全建议。');return;}
      this.view.dispatch({effects:display.of({...snapshot,text})});this.host.shown?.();
    }catch(error){if(!abort.signal.aborted&&this.valid(snapshot))this.host.report(error instanceof Error?error.message:String(error));}
    finally{if(this.abort===abort)this.abort=undefined;}
  }
  accept(){
    const candidate=this.candidate;
    if(!candidate||!this.valid(candidate))return false;
    const {at,text}=candidate;
    this.invalidate();
    this.view.dispatch({changes:{from:at,insert:text},selection:{anchor:at+text.length},effects:display.of(null),annotations:isolateHistory.of('full')});
    this.host.accepted?.();return true;
  }
  dismiss(){if(!this.ready()||(!this.candidate&&!this.abort))return false;this.cancel();return true;}
  destroy(){this.invalidate();this.destroyed=true;this.ownerWindow?.removeEventListener('blur',this.windowBlur);this.peers.delete(this);controllers.delete(this.view);}
}

export function createCompletionExtension(host:CompletionHost):{extension:Extension;cancelAll():void}{
  const peers=new Set<CompletionController>();
  const plugin=ViewPlugin.define(view=>new CompletionController(view,host,peers),{
    decorations:value=>value.decorations,
    eventHandlers:{compositionstart(){this.compositionStart();},compositionend(){this.compositionEnd();},blur(){this.cancel();}},
  });
  const bindings=Prec.high(keymap.of([
    {key:'Tab',run:view=>controllers.get(view)?.accept()??false},
    {key:'Escape',run:view=>controllers.get(view)?.dismiss()??false},
  ]));
  return {extension:[plugin,bindings],cancelAll(){for(const peer of peers)peer.cancel();}};
}

export async function requestCompletion(view:EditorView):Promise<void>{await controllers.get(view)?.request();}
