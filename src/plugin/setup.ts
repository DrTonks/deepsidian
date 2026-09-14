import { Modal, Setting } from 'obsidian';
import type Deepsidian from './main';

import { TESTED_DSH } from './versions';
export { TESTED_DSH } from './versions';
export class SetupModal extends Modal {
  private checking = false;
  constructor(private plugin: Deepsidian, private done?: () => void) { super(plugin.app); }
  onOpen() {
    const root = this.contentEl; root.empty(); root.addClass('ds-setup');
    root.createEl('h2', { text: '连接 DeepSeek Harness' });
    root.createEl('p', { text: '只需配置一次。Deepsidian 复用本机 DSH 的模型配置，不在插件中收集 API key。' });
    const step = (title: string, description: string, command?: string) => {
      const section = root.createDiv('ds-setup-step'); section.createEl('h3', { text: title }); section.createEl('p', { text: description });
      if (command) section.createEl('pre', { text: command });
      return section;
    };
    step('1 · 安装 Node.js', '安装 Node.js 24 或更新版本，安装后重启 Obsidian。macOS 从 Finder 启动时可能无法读取终端 PATH；若自动检测失败，请填写下方绝对路径。').createEl('a', { text: 'Node.js 官方下载', href: 'https://nodejs.org/en/download' });
    step('2 · 安装 DSH', `在系统终端执行以下命令。当前已验证 ${TESTED_DSH}；插件不会后台自动安装或升级。`, `npm install -g @deepseek-ai/dsh@${TESTED_DSH}`)
      .createEl('a', { text: 'DeepSeek Harness 官方安装说明', href: 'https://github.com/deepseek-ai/deepseek-harness' });
    step('3 · 配置模型', '在 DSH Web 页面完成供应商和模型设置，并在那里验证一次对话。配置完成后可以关闭 Web 服务，Deepsidian 会启动自己的轻量实例。', 'dsh web');
    step('4 · 检查连接', '下方检查将按需启动插件自己的 DSH 进程并读取模型目录，不发送模型请求。连接成功不代表 API key、余额或模型权限已通过云端验证。');
    for (const [key, name, hint] of [
      ['packageRoot', 'DSH 包目录', '通常留空自动检测；填写时，在 npm root -g 的输出后追加 /@deepseek-ai/dsh'],
      ['nodePath', 'Node 可执行文件', '通常留空；Windows 用 where.exe node，macOS/Linux 用 command -v node 获取绝对路径'],
      ['dshHome', 'DSH 配置目录', '通常留空使用 ~/.dsh'],
    ] as const) new Setting(root).setName(name).setDesc(hint).addText(input => input.setValue(this.plugin.state.settings[key]).onChange(value => { this.plugin.state.settings[key] = value.trim(); }));
    const status = root.createDiv({ cls: 'ds-setup-status', attr: { role: 'status' } });
    new Setting(root).addButton(button => button.setButtonText('检查并连接').setCta().onClick(async () => {
      if (this.checking || this.plugin.busy) { status.setText('请等待当前操作结束。'); return; }
      this.checking = true; button.setDisabled(true); status.setText('正在检查本地运行时…');
      try {
        await this.plugin.persist(); await this.plugin.disconnect();
        const client = await this.plugin.connect(); this.plugin.models = await client.models();
        this.plugin.state.settings.setupComplete = true; await this.plugin.persist();
        status.setText(`已连接 DSH ${this.plugin.runtimeVersion}，发现 ${this.plugin.models.length} 个候选模型。现在可以返回侧栏提问；连接空闲约 5 分钟后会自动释放。`);
        this.done?.();
      } catch (error) { status.setText(`未连接：${String(error)}。请检查上方步骤与路径；安装后需要重启 Obsidian。`); }
      finally { this.checking = false; button.setDisabled(false); }
    })).addButton(button => button.setButtonText('返回侧栏').onClick(() => this.close()));
  }
}
