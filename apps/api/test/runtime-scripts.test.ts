import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  scripts: {
    start: string;
  };
};

type TsConfig = {
  compilerOptions: {
    outDir: string;
    rootDir: string;
  };
};

describe('runtime scripts', () => {
  it('points npm start to the TypeScript build output path', () => {
    const packageJson = JSON.parse(
      fs.readFileSync('package.json', 'utf8'),
    ) as PackageJson;
    const tsConfig = JSON.parse(
      fs.readFileSync('tsconfig.json', 'utf8'),
    ) as TsConfig;

    expect(tsConfig.compilerOptions.outDir).toBe('dist');
    expect(tsConfig.compilerOptions.rootDir).toBe('.');
    expect(packageJson.scripts.start).toBe('node dist/src/main.js');
  });

  it('keeps agent-core-eval as an executable real contract eval', () => {
    const script = fs.readFileSync('../../scripts/llm/agent-core-eval.ts', 'utf8');

    expect(script).not.toContain("mode: 'offline-fake'");
    expect(script).not.toContain('passed: cases.length');
    expect(script).toContain("mode: 'offline-real-contract'");
    expect(script).toContain('consultationGraphRunner.run');
    expect(script).toContain('process.exitCode = 1');
  });
});
