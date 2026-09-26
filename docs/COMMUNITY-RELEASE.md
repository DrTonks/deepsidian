# 社区发布指南

0.7.0 首次社区审核未通过：目录预览存在三处静态内联样式赋值，设置页手动创建 HTML 标题。0.7.1 将样式移入 CSS 并使用标准 Setting 标题，同时加入官方 ESLint 本地预检。维护者已授权发布和提交审核；发布完成不等于目录审核通过。当前状态请查看 [GitHub Releases](https://github.com/DrTonks/deepseedian/releases) 和社区管理页。

## 产品名称与兼容

按用户决定，显示名称已从 Deepsidian 改为 **Deepseedian**，不再含官方列举的 `-sidian` 变体。界面、安装说明和发布 manifest 已同步。插件 ID、安装目录及协议仍保留 `deepsidian`，仓库已更名为 `DrTonks/deepseedian`，已有聊天和设置无需迁移。新名称的唯一性及最终合规性仍以社区提交审核为准，见 [Manifest 规则](https://docs.obsidian.md/Reference/Manifest)。

发布插件不要求向 Obsidian 或 DeepSeek 上传使用者的文章。只有云端 AI 功能的请求需要相应上下文；回归测试可完全使用合成资料。本地目录与 Base 测试不调用模型。

## 本次发布准备

- 本次修复版本为 0.7.1，不覆盖已发布的 0.7.0。以后发布必须递增，Git 标签与 manifest.version 完全一致，例如 `0.7.1`，不要加 `v`。
- 最低 Obsidian 版本改为实际验证的 1.13.7，桌面专用。旧 1.7.2 声明没有实机依据。
- 社区安装只获取 `main.js`、`manifest.json`、`styles.css`。桥接源码和必要版权声明必须包含在 main.js 内；不能要求用户另下载 bridge.mjs。启动时物化的桥接文件是随包代码的运行产物，不从网络安装或更新依赖。
- Node.js 24+、DSH 0.1.7-rc.2 仍是手动安装的前置条件。社区安装插件不会安装这些软件；请在简介/README 中清楚说明。
- Tab 补全仍是默认关闭的手动功能。实际供应商可能返回错误事实或矛盾续写；不能将 HTTP 成功或出现灰字作为质量通过。

## 本地准备与审核

```sh
npm ci
npm run check
npm run doctor
npm run test:integration
npm run package:release
```

集成验证依赖本机 DSH；旧历史迁移需要另设 DSH_LEGACY_PACKAGE_ROOT 与 DSH_PREVIOUS_PACKAGE_ROOT。不提供旧安装时会跳过这些迁移，发布记录应如实区分。真实供应商测试需单独运行并人工读回答，不在 CI 内使用密钥或个人笔记。

发布目录为 `dist/release/0.7.1/`，只上传其中三个标准文件。验证应从这三个文件安装到测试库，不能用保留旧 bridge.mjs 的开发目录证明首次安装正常。不要上传 data.json、.runtime、记忆、个人库、凭据或 .runs。

## 正式发布步骤

### 1. 维护者完成最终审查

先检查 `git diff`，确认代码、README、manifest.json、versions.json 与构建内容一致。重点复查模型数据流、默认开启的网络/记忆权限、补全使用说明、最低 Obsidian 版本和测试边界。测试使用合成资料即可，社区发布不需要提交个人文章。

本次仓库 remote 为 `https://github.com/DrTonks/deepseedian.git`，插件 ID 仍为 `deepsidian`。确认后提交所需文件并推送至 main，查看远程 Checks。不要把本地未提交构建与远程旧源码组合成 Release。

### 2. 为已审查的提交构建发行文件

在准备发布的提交上执行前文检查及 `npm run package:release`。确认 `dist/release/0.7.1/manifest.json` 与根目录 manifest 一致，在干净测试库仅安装三个文件验证。保存本次验收结果；不得把此前构建的测试结果套用到后续未验证的修改。

若提交前调整版本，同步修改 package.json、package-lock.json、manifest.json 和 versions.json，再构建。社区版本须为 `x.y.z`，初步构建不代表必须使用 `1.0.0`。

### 3. 创建 GitHub Release

审查通过后，在 [仓库 Releases](https://github.com/DrTonks/deepseedian/releases) 选择新建 Release。选择已审查的提交，创建与 manifest.version **完全一致**的标签，例如 `0.7.1`（不要加 `v`）。可以先保存草稿检查附件；供社区安装的版本最终需要公开发布。

分别上传：

- `dist/release/0.7.1/main.js`
- `dist/release/0.7.1/manifest.json`
- `dist/release/0.7.1/styles.css`

不要只上传 ZIP，GitHub 自动生成的源码压缩包也不能代替这三个附件。Release 标题可为 `Deepseedian 0.7.1`，说明当前能力、Node/DSH 前置环境、手动补全边界、费用与数据流以及验证范围。

### 4. 在 Obsidian Community 提交

前往 [Obsidian Community](https://community.obsidian.md)，使用 Obsidian 账号登录，并在个人资料中关联有权管理仓库的 GitHub 账号。选择添加插件，填写 `DrTonks/deepseedian`；名称使用 Deepseedian，ID 使用 manifest 中的 deepsidian。

依赖第三方付费模型服务，付款类型按 [官方 FAQ](https://docs.obsidian.md/community-directory/faq) 选择 **Optional payment**，不能仅因插件源码免费而填 Free。目录读取默认分支 HEAD 的 manifest，并从匹配版本的 Release 下载文件，所以上述两处都需提前准备好。新名称与 ID 的可用性以提交时的实际检查为准。

### 5. 处理审核与首次安装

目录会检查 Manifest、Releases、Source code 与 Build verification。查看每项错误、警告和建议，修复后递增版本并发布新的 Release，必要时使用管理页的 **Check for new releases** 触发检查。管理页还提供 **Review branch**，可预览分支、标签或提交的检查结果，而不必先为每次修改发布 Release。

只有审核问题解决、目录允许安装后，才算完成上架。此时从 Obsidian 社区市场做一次全新安装，确认名称、设置、连接和基本对话可用，再对外宣布。

当前官方流程不是向 obsidian-releases 的 community-plugins.json 提交 PR。GitHub Release 可以供手动安装，但不等于通过社区审核。本轮获准创建标签、公开 Release 并提交社区审核；审核结果以目录实际状态为准。

## 发布前体验检查

真实库需要覆盖：首次安装与连接、来源清单/选区、关联证据和引用定位、停止与续聊、分支和历史恢复、记忆管理与关闭权限、目录预览与确认、手动补全接受/取消/撤销。检查文章正文与属性未被意外修改；生成管理文件应放入明确的测试位置，并保留回滚副本。

隐私范围须先确定：允许哪类现有笔记发送到哪家供应商。`draft`、`encrypted` 或补全排除目录并不自动约束聊天工具。预览本地内容不等于允许将它发送给模型。各场景的实际结果、失败样例和未验证项写入验收记录，不能将合成库结果冒充真实库验收。

官方依据：[提交插件](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)。

## 上架后的更新

仅推送源码不会让已安装用户获得新版。每个准备交付的修复或功能更新，先运行检查，递增 manifest.json、package.json 和 package-lock.json 的版本，提交并推送；若最低 Obsidian 版本变化，再同步 versions.json 的映射。然后为该提交创建与 manifest.version 完全一致的标签，构建并发布对应 GitHub Release，附加 main.js、manifest.json、styles.css。普通开发中的每次提交无需发版。

首次上架之后不必重复填写首次提交表单。社区目录会定期发现新 Release 并审查；可在管理页选择 Check for new releases 或 Request review，查看结果并修复阻断项。不要覆盖旧版本附件，修复已发布问题应递增补丁版本，例如0.7.0 → 0.7.1。官方说明见 [管理条目](https://docs.obsidian.md/community-directory/manage-entry) 与 [FAQ](https://docs.obsidian.md/community-directory/faq)。
