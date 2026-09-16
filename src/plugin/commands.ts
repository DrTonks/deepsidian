export const commands = [
  { name: 'plan', hint: '<问题>', description: '为问题制定计划（单轮规划）' },
  { name: 'goal', hint: '[目标 | clear]', description: '设置或查看本会话目标（不自动续跑）' },
  { name: 'memory', hint: '', description: '管理本库记忆' },
  { name: 'rules', hint: '', description: '编辑记忆整理规则' },
  { name: 'remember', hint: '<内容>', description: '明确保存一条本库记忆' },
  { name: 'organize', hint: '', description: '整理已存记忆的索引（本地，无模型调用）' },
  { name: 'extract', hint: '', description: '从会话提炼记忆提案，确认后保存' },
  { name: 'new', hint: '', description: '新建对话' },
  { name: 'connect', hint: '', description: '连接 DSH' },
  { name: 'help', hint: '', description: '查看可用指令' },
] as const;
export function parseCommand(text: string) {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() } : undefined;
}
export function commandMatches(text: string) {
  const match = /^\/([a-z]*)$/i.exec(text);
  return match ? commands.filter(c => c.name.startsWith(match[1]!.toLowerCase())) : [];
}
