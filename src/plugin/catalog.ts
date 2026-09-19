import { FileSystemAdapter, Modal, Notice, Setting, TFolder } from 'obsidian';
import type Deepsidian from './main';
import { assertCatalogPath, buildCatalog, catalogPath, CATALOG_LIMIT, type CatalogPlan } from './catalog-core';

/** Explicit preview-and-create workflow. Never edits or relocates the source articles. */
export class CatalogModal extends Modal {
  private source:string;
  private output='_本地管理';
  private plan?:CatalogPlan;
  private busy=false;
  private closed=false;
  private message='';
  private previewEl?:HTMLElement;
  constructor(private plugin:Deepsidian){super(plugin.app);this.source=this.app.vault.getAbstractFileByPath('posts') instanceof TFolder?'posts':'';}
  onOpen(){this.closed=false;this.render();}
  onClose(){this.closed=true;this.contentEl.empty();}
  private root(){const a=this.app.vault.adapter;if(!(a instanceof FileSystemAdapter))throw Error('目录整理仅支持桌面本地知识库');return a.getBasePath();}
  private invalidate(){this.plan=undefined;this.message='路径已变更，请重新扫描并预览';this.previewEl?.empty();this.previewEl?.createEl('p',{text:this.message,attr:{role:'status'}});}
  private render(){
    if(this.closed)return;
    const el=this.contentEl;el.empty();el.addClass('ds-catalog-modal');el.createEl('h2',{text:'整理文章目录'});
    el.createEl('p',{text:'生成 Obsidian Bases 表格和 Markdown 导航，不调用模型，不改动原文章。'});
    new Setting(el).setName('文章目录').setDesc('库内相对路径；留空代表整个知识库。').addText(t=>t.setValue(this.source).setPlaceholder('posts').setDisabled(this.busy).onChange(v=>{this.source=v;this.invalidate();}));
    new Setting(el).setName('输出目录').setDesc('仅新建文章管理.base、文章导航.md；同名文件存在时停止。').addText(t=>t.setValue(this.output).setDisabled(this.busy).onChange(v=>{this.output=v;this.invalidate();}));
    new Setting(el).addButton(b=>b.setButtonText(this.busy?'处理中…':'扫描并预览').setDisabled(this.busy).onClick(()=>void this.preview()));
    const preview=this.previewEl=el.createDiv();
    if(this.message)preview.createEl('p',{text:this.message,attr:{role:'status'}});
    if(this.plan){
      preview.createEl('p',{text:`共 ${this.plan.count} 篇。缺失属性：${Object.entries(this.plan.missing).map(([k,v])=>`${k} ${v}`).join(' · ')}。`});
      preview.createEl('p',{text:'兼容 title、category/categories、tags、date/pubDate、draft；草稿需为布尔值。属性类型不统一时请在原文中核对。只扫描 Markdown，隐藏路径与符号链接不参与；导航为静态快照，不推断发布日期。'});
      for(const [title,body] of [['文章管理.base',this.plan.base],['文章导航.md',this.plan.navigation]]){
        const details=preview.createEl('details');details.createEl('summary',{text:title});const pre=details.createEl('pre',{text:body.slice(0,12000)+(body.length>12000?'\n…预览已截断，生成文件保留全部内容':'')});pre.style.maxHeight='260px';pre.style.overflow='auto';pre.style.whiteSpace='pre-wrap';
      }
      new Setting(preview).addButton(b=>b.setButtonText('确认新建两个文件').setCta().setDisabled(this.busy).onClick(()=>void this.create()));
    }
  }
  private async preview(){
    if(this.busy)return;this.busy=true;this.plan=undefined;this.message='';this.render();
    try {
      const source=catalogPath(this.source,true),output=catalogPath(this.output),root=this.root();
      if(source && !(this.app.vault.getAbstractFileByPath(source) instanceof TFolder))throw Error('文章目录不存在或不是文件夹');
      await assertCatalogPath(root,source);await assertCatalogPath(root,output,true);
      const files=this.app.vault.getMarkdownFiles().filter(f=>(!source||f.path.startsWith(source+'/'))&&!f.path.startsWith(output+'/'));
      const rows=[];let skipped=0;
      for(const file of files){
        try{catalogPath(file.path);await assertCatalogPath(root,file.path);}catch{skipped++;continue;}
        if(rows.length===CATALOG_LIMIT)throw Error(`超过 ${CATALOG_LIMIT} 篇，请缩小文章目录`);
        const cached=this.app.metadataCache.getFileCache(file);
        if(!cached)throw Error('Obsidian 元数据索引尚未就绪，请稍后重试');
        rows.push({path:file.path,frontmatter:cached.frontmatter});
      }
      this.plan=buildCatalog(rows,source,output);this.source=source;this.output=output;
      this.message=`预览已准备；跳过 ${skipped} 个隐藏、不安全或不可读路径。生成视图会查询目录内文章，导航列出本次扫描结果。`;
    }catch(e){this.message=e instanceof Error?e.message:'扫描失败';}
    finally{this.busy=false;this.render();}
  }
  private async create(){
    if(this.busy||!this.plan)return;this.busy=true;const plan=this.plan;this.render();
    const created:string[]=[];
    try{
      const output=catalogPath(this.output),root=this.root(),paths=[`${output}/文章管理.base`,`${output}/文章导航.md`];
      for(const path of paths){await assertCatalogPath(root,path,true);if(await this.app.vault.adapter.exists(path))throw Error(`${path} 已存在，请更换输出目录；不会覆盖`);}
      let folder='';for(const part of output.split('/')){folder=folder?`${folder}/${part}`:part;await assertCatalogPath(root,folder,true);const existing=this.app.vault.getAbstractFileByPath(folder);if(existing&&!(existing instanceof TFolder))throw Error(`${folder} 不是文件夹`);if(!existing)await this.app.vault.createFolder(folder);}
      for(const [index,path] of paths.entries()){
        await assertCatalogPath(root,path,true);
        if(await this.app.vault.adapter.exists(path))throw Error(`${path} 已存在，停止创建`);
        await this.app.vault.create(path,index===0?plan.base:plan.navigation);created.push(path);
      }
      this.message=`已创建：${created.join('、')}。请在 Obsidian 打开文章管理.base；需启用核心插件 Bases。`;this.plan=undefined;new Notice('文章管理与导航已生成');
    }catch(e){this.plan=undefined;this.message=`${e instanceof Error?e.message:'创建失败'}。${created.length?`已创建 ${created.join('、')}，保留供检查；其余未完成。`:'未创建文章管理文件。'}`;}
    finally{this.busy=false;this.render();}
  }
}
