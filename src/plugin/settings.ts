import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type Deepsidian from './main';
import type { Settings } from './types';
import { SetupModal } from './setup';

export class DeepsidianSettings extends PluginSettingTab {
  constructor(readonly plugin: Deepsidian) { super(plugin.app, plugin); }
  private expanded = new Map<string,boolean>();
  private section(parent:HTMLElement,id:string,title:string,description:string,open:boolean) {
    const details=parent.createEl('details',{cls:'ds-settings-section',attr:{'data-settings-section':id}});
    details.open=this.expanded.get(id)??open;
    const summary=details.createEl('summary');
    summary.createSpan({cls:'ds-settings-title',text:title});
    summary.createSpan({cls:'ds-settings-summary',text:description});
    details.addEventListener('toggle',()=>this.expanded.set(id,details.open));
    return details.createDiv({cls:'ds-settings-body'});
  }
  display() {
    const el = this.containerEl; for(const section of Array.from(el.querySelectorAll<HTMLDetailsElement>('[data-settings-section]')))this.expanded.set(section.dataset.settingsSection!,section.open); el.empty(); el.addClass('ds-settings'); el.createEl('h2', { text: 'Deepseedian' });
    el.createEl('p', { text: '复用本机 DSH 的模型与凭证。选区、对话和工具读取内容会发送给你配置的模型供应商。工具可检索笔记、搜索网络和读取网页，网络能力可分别关闭。' });
    const common=this.section(el,'common','常规','连接与默认模型',true);
    const memory=this.section(el,'memory','长期记忆','读取、AI管理与闲时整理',true);
    const network=this.section(el,'network','网络工具','搜索与网页读取',true);
    const completion=this.section(el,'completion','实验性补全','手动请求 · Tab 接受',false);
    const advanced=this.section(el,'advanced','高级运行时','Node.js与DSH路径，通常无需修改',false);
    const updates=this.section(el,'updates','更新与诊断','版本检查及连接排查',false);
    new Setting(updates).setName('首次使用与连接诊断').addButton(b => b.setButtonText('打开引导').onClick(() => new SetupModal(this.plugin).open()));
    new Setting(common).setName('自动连接与侧栏唤醒').setDesc('界面恢复或返回侧栏时自动连接；焦点在侧栏时保持连接，离开且无请求约5分钟后休眠。不自动发送模型请求。').addToggle(t=>t.setValue(this.plugin.state.settings.autoConnect).onChange(async value=>{this.plugin.state.settings.autoConnect=value;await this.plugin.persist();if(value)void this.plugin.connect().catch(e=>new Notice(String(e)));}));
    new Setting(memory).setName('使用本库长期记忆').setDesc('下次提问生效。关闭后不再读取，并通知模型停用旧记忆；不会删除聊天历史。').addToggle(t=>t.setValue(this.plugin.state.settings.useMemory).onChange(async value=>{this.plugin.state.settings.useMemory=value;await this.plugin.persist();}));
    new Setting(memory).setName('允许 AI 管理记忆').setDesc('直接说“请记住”“更正”或“忘记”，AI即可保存，无需再次确认。默认开启，保留已有关闭选择。').addToggle(t=>t.setValue(this.plugin.state.settings.manageMemory).onChange(async value=>{try{await this.plugin.setManageMemory(value);}catch(error){t.setValue(this.plugin.state.settings.manageMemory);new Notice(String(error));}}));
    const managementHelp=memory.createEl('details',{cls:'ds-settings-help'});
    managementHelp.createEl('summary',{text:'管理范围与撤销'});
    managementHelp.createEl('p',{text:'需开启本库和本会话记忆读取、会话贡献。仅处理当前消息的明确要求；在 /memory 维护页可撤销最近操作。切换会重新加载工具，下次请求生效。删除记忆不擦除聊天和运行时日志。'});
    new Setting(memory).setName('闲时生成记忆提案').setDesc('默认关闭。连续5分钟无交互且无前台请求时生成待审提案，确认后才写入。会产生模型费用。').addToggle(t=>t.setValue(this.plugin.state.settings.idleMemory).onChange(async value=>{try{await this.plugin.setIdleMemory(value);}catch(error){t.setValue(this.plugin.state.settings.idleMemory);new Notice(String(error));}}));
    const limits=memory.createEl('details',{cls:'ds-settings-help'});
    limits.createEl('summary',{text:'整理预算与限制'});
    limits.createEl('p',{text:'按UTC日期每天最多2个任务、累计80000输入字符，每次最多4096输出token。失败与取消也计次，DSH内部重试可能额外计费。只处理允许贡献的会话；已有待审提案时暂停生成。'});
    const idle=this.plugin.state.idleMemory;
    new Setting(memory).setName('闲时整理状态').setDesc(`${this.plugin.idleScheduler.running?'正在生成':idle?.pending?'有一批待审提案':'暂无待审提案'} · ${idle?.day??'尚未运行'}：${idle?.calls??0}/2次，${idle?.chars??0}/80000字符。${this.plugin.idleScheduler.error || idle?.lastError || ''}`).addButton(b=>b.setButtonText('查看提案').onClick(()=>this.plugin.openOrganizer()));
    new Setting(memory).setName('本库记忆').setDesc('跨会话读取、手动编辑、模型提案与人工确认；闲时生成可独立开启。').addButton(b=>b.setButtonText('管理记忆').onClick(()=>this.plugin.openMemory())).addButton(b=>b.setButtonText('编辑规则').onClick(()=>this.plugin.openMemory('rules'))).addButton(b=>b.setButtonText('查看或生成提案').onClick(()=>this.plugin.openOrganizer()));
    for (const [key, title, desc] of [['webSearch', '网络搜索', 'DSH 原生 DeepSeek 搜索，会将查询发送到搜索供应商并产生额外模型请求；新安装默认开启。'], ['webFetch', '网页读取', 'DSH 原生匿名 HTTP 网页读取，仅允许公网 HTTP(S)，新安装默认开启。']] as const) {
      new Setting(network).setName(title).setDesc(desc).addToggle(t => t.setValue(this.plugin.state.settings[key]).onChange(async value => {
        if (this.plugin.busy) { new Notice('请先结束当前回答'); t.setValue(this.plugin.state.settings[key]); return; }
        await this.plugin.disconnect(); this.plugin.state.settings[key] = value; await this.plugin.persist();
      }));
    }
    new Setting(completion).setName('启用手动笔记补全').setDesc('默认关闭。通过命令“请求当前位置补全（实验）”生成单行灰字，Tab 接受、Esc 丢弃。光标前后少量正文会发送给付费 deepseek-official / deepseek-flash；不读取聊天、记忆或关联笔记。不会自动触发。').addToggle(t=>t.setValue(this.plugin.state.settings.completionEnabled).onChange(async value=>{
      try{await this.plugin.setCompletion({completionEnabled:value});}catch(error){t.setValue(this.plugin.state.settings.completionEnabled);new Notice(String(error));}
    }));
    new Setting(completion).setName('排除文件或目录').setDesc('每行一个库内路径，例如 私人 或 日记/草稿.md；匹配该文件或目录内全部文件。不支持通配符。').addTextArea(input=>input.setValue(this.plugin.state.settings.completionExcluded).onChange(async value=>{
      try{await this.plugin.setCompletion({completionExcluded:value});}catch(error){new Notice(String(error));}
    }));
    const completionBudget=this.plugin.state.completionBudget;
    new Setting(completion).setName('补全调用额度').setDesc(`本库按 UTC 日期每天最多 200 次，每分钟 10 次，间隔至少 2 秒；发出前保存预占额度，失败与取消不退还。调用额度不是金额上限。${completionBudget?` ${completionBudget.day}：${completionBudget.calls}/200 次，展示 ${completionBudget.shown} 次，接受 ${completionBudget.accepted} 次。`:''}`);
    const text = (key: keyof Settings, title: string, desc: string) => new Setting(advanced).setName(title).setDesc(desc).addText(input => input.setValue(String(this.plugin.state.settings[key])).onChange(async value => {
      (this.plugin.state.settings as any)[key] = value; await this.plugin.persist();
    }));
    text('packageRoot', 'DSH 包目录', '留空自动检测，例如 …/node_modules/@deepseek-ai/dsh');
    text('nodePath', 'Node.js 路径', '留空自动检测；使用独立 Node，不使用 Obsidian 内置 Electron');
    text('dshHome', 'DSH 配置目录', '留空使用 DSH_HOME 或 ~/.dsh');
    try {
      const env = this.plugin.resolveEnvironment();
      new Setting(common).setName('默认模型').setDesc(`DSH ${env.versions.dsh}；默认读取 DSH 的模型选择`).addDropdown(drop => {
        drop.addOption('', '跟随 DSH 默认');
        for (const m of env.choices) drop.addOption(`${m.provider}\n${m.model}`, `${m.provider} / ${m.model}`);
        drop.setValue(this.plugin.state.settings.provider ? `${this.plugin.state.settings.provider}\n${this.plugin.state.settings.model}` : '');
        drop.onChange(async value => { const [provider = '', model = ''] = value.split('\n'); Object.assign(this.plugin.state.settings, { provider, model }); await this.plugin.persist(); });
      });
    } catch (error) { common.createEl('p', { text: String(error) }); }
    new Setting(updates).setName('应用设置并检查连接').setDesc('不会发送模型请求；当前回答结束后可应用。').addButton(b => b.setButtonText('检查连接').onClick(async () => {
      if (this.plugin.busy) { new Notice('请先停止当前回答'); return; }
      try { await this.plugin.disconnect(); await this.plugin.connect(); new Notice('DSH 与桥接插件连接成功'); } catch (error) { new Notice(String(error)); }
    }));
    new Setting(updates).setName('后台检查官方更新').setDesc('最多每天一次，只查询版本，不自动安装。').addToggle(t => t.setValue(this.plugin.state.settings.checkUpdates).onChange(async value => { this.plugin.state.settings.checkUpdates = value; await this.plugin.persist(); if (value) void this.plugin.update(false); }));
    new Setting(updates).setName('检查更新').setDesc(this.plugin.state.updates?.newest ? `上次查询：${this.plugin.state.updates.newest}` : '尚未查询').addButton(b => b.setButtonText('立即检查').onClick(() => void this.plugin.update(true)));
  }
}

