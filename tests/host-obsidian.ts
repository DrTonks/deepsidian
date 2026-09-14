// Minimal Node host for lifecycle/command tests; UI tests use the browser adapter.
export class Plugin {
  app:any={workspace:{onLayoutReady:(cb:()=>void)=>{this.ready=cb;},on:()=>({})}};
  ready?:()=>void;
  manifest={id:'deepsidian'};
  saved:any=null;
  async loadData(){return this.saved;} async saveData(_data:any){}
  registerView(){} addRibbonIcon(){} addCommand(){} registerEvent(){} addSettingTab(){} registerInterval(){}
}
export class Component {}
export class ItemView {}
export class Scope { constructor(_parent?: unknown) {} register(..._args: unknown[]) {} }
export class Modal {}
export class PluginSettingTab {}
export class WorkspaceLeaf {}
export class MarkdownView {}
export class FileSystemAdapter {}
export class TFile {}
export class FuzzySuggestModal {}
export class Setting {}
export class Notice {constructor(..._args:any[]) {}}
export const MarkdownRenderer={};
export function addIcon(){} export function setIcon(){}
export async function requestUrl(){throw Error('Unexpected network request');}
