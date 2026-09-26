import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

// Gate Obsidian's recommended rules at their published severity. General JS/TS
// findings start as visible warnings while the existing code is migrated to
// linting, matching the directory scan's advisory treatment of these findings.
// This is a local preflight, not a replacement for the community review.
const communityPreflight = obsidianmd.configs.recommended.map(config => ({
  ...config,
  ...(config.rules ? { rules: Object.fromEntries(Object.entries(config.rules).map(([name, rule]) => {
    if (name.startsWith('obsidianmd/')) return [name, rule];
    const [severity, ...options] = Array.isArray(rule) ? rule : [rule];
    return [name, severity === 'error' || severity === 2 ? ['warn', ...options] : rule];
  })) } : {}),
}));

export default defineConfig([
  { ignores: ['node_modules/**', '.runs/**', '.preview/**', 'dist/**', 'main.js'] },
  ...communityPreflight,
  {
    files: ['src/plugin/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
  },
]);
