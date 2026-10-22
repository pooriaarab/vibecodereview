// Failure cases declared before implementation: missing chair wiring repeats
// downloads; PATH-only and home-only installs must work; broken CLIs fail closed.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const root = resolve(import.meta.dirname, '..');
test('every chair uses the verified shared CLI', () => {
  const action = readFileSync(join(root, 'action.yml'), 'utf8');
  const chairs = action.split(/\n    - name: /).filter(s => s.includes('uses: anthropics/claude-code-action@v1'));
  assert.equal(chairs.length, 5);
  for (const chair of chairs) assert.match(chair, /path_to_claude_code_executable: \$\{\{ env\.VCR_CLAUDE_EXECUTABLE \}\}/);
});
for (const location of ['path', 'home', 'broken']) {
  test(`installer validates and exports ${location} CLI`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcr-cli-'));
    try {
      const bin = join(dir, location === 'home' ? '.local/bin' : 'bin');
      mkdirSync(bin, { recursive: true });
      const cli = join(bin, 'claude');
      writeFileSync(cli, `#!/bin/sh\n${location === 'broken' ? 'exit 7' : 'echo "2.1.308 (Claude Code)"'}\n`, { mode: 0o755 });
      const envFile = join(dir, 'env');
      writeFileSync(envFile, '');
      const result = spawnSync('bash', [join(root, 'scripts/install-claude-cli.sh')], {
        env: { ...process.env, HOME: dir, PATH: `${location === 'home' ? '' : bin + ':'}/usr/bin:/bin`, GITHUB_PATH: join(dir, 'path'), GITHUB_ENV: envFile, RUNNER_TEMP: dir }, encoding: 'utf8'
      });
      if (location === 'broken') assert.notEqual(result.status, 0);
      else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(envFile, 'utf8'), `VCR_CLAUDE_EXECUTABLE=${cli}\n`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
// Cold-path failures: installer download fails; downloaded installer fails;
// npm fallback fails. Successful fallback must be pinned and reused next time.
for (const failure of ['download', 'native', 'both']) {
  test(`cold install handles ${failure} failure`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcr-cold-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'curl'), `#!/bin/sh\n${failure === 'native' ? 'for target; do :; done\nprintf "exit 8\\n" > "$target"\nexit 0' : 'exit 22'}\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$*" >> "$HOME/npm.calls"\n${failure === 'both' ? 'exit 9' : 'mkdir -p "$HOME/.local/bin"\nprintf \'#!/bin/sh\\necho "2.1.308 (Claude Code)"\\n\' > "$HOME/.local/bin/claude"\nchmod +x "$HOME/.local/bin/claude"'}\n`, { mode: 0o755 });
      const envFile = join(dir, 'env');
      writeFileSync(envFile, '');
      const env = { ...process.env, HOME: dir, PATH: `${bin}:/usr/bin:/bin`, GITHUB_PATH: join(dir, 'path'), GITHUB_ENV: envFile, RUNNER_TEMP: dir };
      const run = () => spawnSync('bash', [join(root, 'scripts/install-claude-cli.sh')], { env, encoding: 'utf8' });
      const result = run();
      if (failure === 'both') {
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(envFile, 'utf8'), '');
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(readFileSync(join(dir, 'npm.calls'), 'utf8'), /@anthropic-ai\/claude-code@2\.1\.308/);
        assert.equal(run().status, 0);
        assert.equal(readFileSync(join(dir, 'npm.calls'), 'utf8').trim().split('\n').length, 1);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
