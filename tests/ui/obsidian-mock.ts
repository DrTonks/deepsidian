// Browser-only host adapter for rendering the production view with synthetic fixtures.
// This is not bundled into the Obsidian plugin.
const icons = new Map<string,string>();
export function addIcon(name:string,svg:string) { icons.set(name,svg); }
export function setIcon(element:HTMLElement,name:string) {
  element.innerHTML = `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" aria-hidden="true">${icons.get(name) ?? ({history:'<circle cx="50" cy="50" r="36"/><path d="M50 26v26l17 10"/>',plus:'<path d="M50 20v60M20 50h60"/>',x:'<path d="M25 25l50 50M25 75l50-50"/>','arrow-up':'<path d="M50 80V20L25 45M50 20l25 25"/>','file-text':'<path d="M25 15h35l15 15v55H25zM38 48h24M38 63h24"/>','settings-2':'<path d="M20 30h60M20 70h60M40 20v20M65 60v20"/>',square:'<rect x="25" y="25" width="50" height="50"/>','paperclip':'<path d="M40 70V35a10 10 0 0120 0v40a20 20 0 01-40 0V30a30 30 0 0160 0v40"/>'} as Record<string,string>)[name] ?? '<circle cx="50" cy="50" r="24"/>'}</svg>`;
}
function create(parent:HTMLElement,tag:string,options:any = {}) {
  const element = document.createElement(tag);
  if(typeof options === 'string') element.className=options;
  else { if(options.cls) element.className=options.cls; if(options.text) element.textContent=options.text; for(const [k,v] of Object.entries(options.attr ?? {})) element.setAttribute(k,String(v)); for(const k of ['value','href','type']) if(options[k] !== undefined) (element as any)[k]=options[k]; }
  parent.append(element); return element;
}
Object.assign(HTMLElement.prototype,{
  createEl(this:HTMLElement,tag:string,options:any){return create(this,tag,options);},
  createDiv(this:HTMLElement,options:any){return create(this,'div',options);},
  createSpan(this:HTMLElement,options:any){return create(this,'span',options);},
  empty(this:HTMLElement){this.replaceChildren();},
  addClass(this:HTMLElement,...names:string[]){this.classList.add(...names);},
  setText(this:HTMLElement,text:string){this.textContent=text;},
});
export class Component {load(){} unload(){} addChild(child:Component){return child;}}
export class ItemView extends Component {
  app:any; contentEl:HTMLElement;
  constructor(leaf:any){super();this.app=leaf.app;this.contentEl=leaf.container;}
}
export class WorkspaceLeaf {}
// Preview uses the view's DOM fallback; real Obsidian owns scope dispatch.
export class Scope { constructor(_parent?: unknown) {} register(..._args: unknown[]) {} }
export class MarkdownView {}
export class TFile {}
export class Notice {constructor(message:string){const toast=create(document.body,'div',{cls:'preview-notice',text:message});setTimeout(()=>toast.remove(),4000);}}
export const MarkdownRenderer = {async render(_app:any,text:string,target:HTMLElement){
  // Text-only host substitute: never executes fixture HTML.
  for(const paragraph of text.split('\n\n')) create(target,'p',{text:paragraph});
}};
export class Modal {
  contentEl:HTMLElement; private overlay:HTMLElement; app:any;
  constructor(app:any){this.app=app;this.overlay=create(document.body,'div',{cls:'preview-modal-layer'});this.overlay.hidden=true;this.contentEl=create(this.overlay,'div',{cls:'preview-modal'});}
  open(){this.overlay.hidden=false;(this as any).onOpen?.();} close(){this.overlay.remove();}
}
export class FuzzySuggestModal<T> extends Modal {setPlaceholder(_s:string){} }
export class Setting {
  private name:HTMLElement; private desc:HTMLElement; private controls:HTMLElement;
  constructor(parent:HTMLElement){const row=create(parent,'div',{cls:'setting-item'});const info=create(row,'div',{cls:'setting-item-info'});this.name=create(info,'div',{cls:'setting-item-name'});this.desc=create(info,'div',{cls:'setting-item-description'});this.controls=create(row,'div',{cls:'setting-item-control'});}
  setName(text:string){this.name.textContent=text;return this;} setDesc(text:string){this.desc.textContent=text;return this;}
  addButton(callback:any){const button=create(this.controls,'button') as HTMLButtonElement;const api={setButtonText(text:string){button.textContent=text;return api;},setCta(){button.classList.add('mod-cta');return api;},setDisabled(value:boolean){button.disabled=value;return api;},onClick(fn:any){button.onclick=fn;return api;}};callback(api);return this;}
  addText(callback:any){const input=create(this.controls,'input') as HTMLInputElement;const api={setValue(value:string){input.value=value;return api;},onChange(fn:any){input.onchange=()=>fn(input.value);return api;}};callback(api);return this;}
}
export async function requestUrl(){throw Error('Networking is disabled in the component preview.');}
