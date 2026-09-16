import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type Deepsidian from './main';
import type { Settings } from './types';
import { SetupModal } from './setup';

export class DeepsidianSettings extends PluginSettingTab {
  constructor(readonly plugin: Deepsidian) { super(plugin.app, plugin); }
  display() {
    const el = this.containerEl; el.empty(); el.createEl('h2', { text: 'Deepsidian 学习助手' });
    el.createEl('p', { text: '复用本机 DSH 的模型与凭证。选区、对话和工具读取内容会发送给你配置的模型供应商。工具可检索笔记、搜索网络和读取网页，网络能力可分别关闭。' });
    new Setting(el).setName('首次使用与连接诊断').addButton(b => b.setButtonText('打开引导').onClick(() => new SetupModal(this.plugin).open()));
    new Setting(el).setName('自动连接与侧栏唤醒').setDesc('界面恢复或返回侧栏时自动连接；焦点在侧栏时保持连接，离开且无请求约5分钟后休眠。不自动发送模型请求。').addToggle(t=>t.setValue(this.plugin.state.settings.autoConnect).onChange(async value=>{this.plugin.state.settings.autoConnect=value;await this.plugin.persist();if(value)void this.plugin.connect().catch(e=>new Notice(String(e)));}));
    new Setting(el).setName('使用本库长期记忆').setDesc('下次提问生效。关闭后不再读取，并通知模型停用旧记忆；不会删除聊天历史。').addToggle(t=>t.setValue(this.plugin.state.settings.useMemory).onChange(async value=>{this.plugin.state.settings.useMemory=value;await this.plugin.persist();}));
    new Setting(el).setName('闲时生成记忆提案').setDesc('默认关闭。启用后，Obsidian 内连续5分钟无交互且没有前台请求时，逐批处理本库允许贡献的会话历史。按UTC日期每天最多2个整理任务、累计80000输入字符，每次4096输出token；失败和取消也计次；DSH内部重试可能额外计费。只生成待审提案，不自动写入记忆。').addToggle(t=>t.setValue(this.plugin.state.settings.idleMemory).onChange(async value=>{try{await this.plugin.setIdleMemory(value);}catch(error){t.setValue(this.plugin.state.settings.idleMemory);new Notice(String(error));}}));
    const idle=this.plugin.state.idleMemory;
    new Setting(el).setName('闲时整理状态').setDesc(`${this.plugin.idleScheduler.running?'正在生成':idle?.pending?'有一批待审提案':'暂无待审提案'} · ${idle?.day??'尚未运行'}：${idle?.calls??0}/2次，${idle?.chars??0}/80000字符。${this.plugin.idleScheduler.error || idle?.lastError || ''}`).addButton(b=>b.setButtonText('查看提案').onClick(()=>this.plugin.openOrganizer()));
    new Setting(el).setName('本库记忆').setDesc('跨会话读取、手动编辑、模型提案与人工确认；闲时生成可独立开启。').addButton(b=>b.setButtonText('管理记忆').onClick(()=>this.plugin.openMemory())).addButton(b=>b.setButtonText('编辑规则').onClick(()=>this.plugin.openMemory('rules'))).addButton(b=>b.setButtonText('查看或生成提案').onClick(()=>this.plugin.openOrganizer()));
    for (const [key, title, desc] of [['webSearch', '网络搜索', 'DSH 原生 DeepSeek 搜索，会将查询发送到搜索供应商并产生额外模型请求；新安装默认开启。'], ['webFetch', '网页读取', 'DSH 原生匿名 HTTP 网页读取，仅允许公网 HTTP(S)，新安装默认开启。']] as const) {
      new Setting(el).setName(title).setDesc(desc).addToggle(t => t.setValue(this.plugin.state.settings[key]).onChange(async value => {
        if (this.plugin.busy) { new Notice('请先结束当前回答'); t.setValue(this.plugin.state.settings[key]); return; }
        await this.plugin.disconnect(); this.plugin.state.settings[key] = value; await this.plugin.persist();
      }));
    }
    const text = (key: keyof Settings, title: string, desc: string) => new Setting(el).setName(title).setDesc(desc).addText(input => input.setValue(String(this.plugin.state.settings[key])).onChange(async value => {
      (this.plugin.state.settings as any)[key] = value; await this.plugin.persist();
    }));
    text('packageRoot', 'DSH 包目录', '留空自动检测，例如 …/node_modules/@deepseek-ai/dsh');
    text('nodePath', 'Node.js 路径', '留空自动检测；使用独立 Node，不使用 Obsidian 内置 Electron');
    text('dshHome', 'DSH 配置目录', '留空使用 DSH_HOME 或 ~/.dsh');
    try {
      const env = this.plugin.resolveEnvironment();
      new Setting(el).setName('已有模型').setDesc(`DSH ${env.versions.dsh}；默认读取 DSH 的模型选择`).addDropdown(drop => {
        drop.addOption('', '跟随 DSH 默认');
        for (const m of env.choices) drop.addOption(`${m.provider}\n${m.model}`, `${m.provider} / ${m.model}`);
        drop.setValue(this.plugin.state.settings.provider ? `${this.plugin.state.settings.provider}\n${this.plugin.state.settings.model}` : '');
        drop.onChange(async value => { const [provider = '', model = ''] = value.split('\n'); Object.assign(this.plugin.state.settings, { provider, model }); await this.plugin.persist(); });
      });
    } catch (error) { el.createEl('p', { text: String(error) }); }
    new Setting(el).setName('应用设置并检查连接').setDesc('不会发送模型请求；当前回答结束后可应用。').addButton(b => b.setButtonText('检查连接').onClick(async () => {
      if (this.plugin.busy) { new Notice('请先停止当前回答'); return; }
      try { await this.plugin.disconnect(); await this.plugin.connect(); new Notice('DSH 与桥接插件连接成功'); } catch (error) { new Notice(String(error)); }
    }));
    new Setting(el).setName('后台检查官方更新').setDesc('最多每天一次，只查询版本，不自动安装。').addToggle(t => t.setValue(this.plugin.state.settings.checkUpdates).onChange(async value => { this.plugin.state.settings.checkUpdates = value; await this.plugin.persist(); if (value) void this.plugin.update(false); }));
    new Setting(el).setName('检查更新').setDesc(this.plugin.state.updates?.newest ? `上次查询：${this.plugin.state.updates.newest}` : '尚未查询').addButton(b => b.setButtonText('立即检查').onClick(() => void this.plugin.update(true)));
  }
}

