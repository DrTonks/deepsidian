import { posix, win32 } from 'node:path';

interface DiscoveryOptions {
  platform: string;
  path: string;
  home: string;
  appData?: string;
  packageRoot?: string;
  nodePath?: string;
  envRoot?: string;
  npmPrefix?: string;
  nvmBin?: string;
}

/** Build candidates without invoking a shell or using Electron as Node. */
export function discoveryCandidates(options: DiscoveryOptions) {
  const windows = options.platform === 'win32';
  const path = windows ? win32 : posix;
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];
  const paths = options.path.split(path.delimiter).filter(Boolean);
  const bins = unique([
    ...paths,
    options.nvmBin,
    options.npmPrefix && (windows ? options.npmPrefix : path.join(options.npmPrefix, 'bin')),
    ...(windows ? ['C:/Program Files/nodejs'] : [
      ...(options.platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
      '/usr/local/bin', '/usr/bin',
    ]),
  ]);
  const nodes = unique([options.nodePath, ...bins.map(bin => path.join(bin, windows ? 'node.exe' : 'node'))]);
  const nodeBins = unique([options.nodePath && path.dirname(options.nodePath), ...bins]);
  const roots = unique([
    options.packageRoot,
    options.envRoot,
    ...nodeBins.flatMap(bin => [
      path.join(bin, 'node_modules/@deepseek-ai/dsh'),
      ...(!windows ? [path.resolve(bin, '../lib/node_modules/@deepseek-ai/dsh')] : []),
    ]),
    ...(windows ? [path.join(options.appData ?? options.home, 'npm/node_modules/@deepseek-ai/dsh')] : []),
  ]);
  return { nodes, roots };
}
