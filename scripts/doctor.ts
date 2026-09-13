import { discover } from '../src/plugin/dsh.ts';
try {
  const env = discover();
  console.log(JSON.stringify({ node: env.node, packageRoot: env.root, configurationHome: env.home, versions: env.versions, testedVersion: '0.1.5-rc.2' }, null, 2));
  if (Object.values(env.versions).some(v => v !== '0.1.5-rc.2')) console.log('Unverified version combination. Run integration tests before deploying.');
} catch (error) { console.error(String(error)); process.exitCode = 1; }
