#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scanScript = path.join(scriptDir, 'scan-staged.mjs');
const markerScript = path.join(scriptDir, 'mark-reviewed.mjs');

function run(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    ...options,
  });
}

function must(command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'publication-safety-'));
  must('git', ['init'], dir);
  must('git', ['config', 'user.email', 'test@example.invalid'], dir);
  must('git', ['config', 'user.name', 'Publication Safety Test'], dir);
  mkdirSync(path.join(dir, 'scripts', 'publication-safety'), { recursive: true });
  writeFileSync(
    path.join(dir, 'scripts', 'publication-safety', 'config.json'),
    `${JSON.stringify({ strictReviewMarker: true }, null, 2)}\n`,
  );
  must('git', ['add', 'scripts/publication-safety/config.json'], dir);
  must('git', ['commit', '-m', 'init publication-safety config'], dir);
  return dir;
}

function stageFile(repo, file, content) {
  const full = path.join(repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  must('git', ['add', file], repo);
}

function commitFile(repo, file, content, message) {
  stageFile(repo, file, content);
  must('git', ['commit', '-m', message], repo);
}

function expectPass(name, command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${name} expected pass:\n${result.stderr}\n${result.stdout}`);
  }
  console.log(`PASS ${name}`);
}

function expectFail(name, command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status === 0) {
    throw new Error(`${name} expected fail.`);
  }
  console.log(`PASS ${name}`);
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# Safe public text\n');
  expectPass('safe staged diff', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  stageFile(repo, '.env', 'SECRET_TOKEN=example\n');
  expectFail('blocks .env path', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  const fakeToken = `token ${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('blocks token content', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  const fakeToken = `++${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('blocks token content after leading pluses', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  const fakeToken = `++ b/${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('blocks token content that resembles a diff header', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  commitFile(repo, 'README.md', '-- old-header-like\n', 'add header-like old content');
  const fakeToken = `++ b/${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('blocks replacement content that resembles a diff header', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  const fakeToken = `example ${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('allowlist does not suppress token on same line', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, 'scripts', 'publication-safety', 'config.json'),
    `${JSON.stringify({
      strictReviewMarker: true,
      blockedContentRegexes: ['example|secret-[A-Za-z0-9]+'],
    }, null, 2)}\n`,
  );
  must('git', ['add', 'scripts/publication-safety/config.json'], repo);
  stageFile(repo, 'README.md', 'example secret-leak\n');
  expectFail('scanner checks every blocked match on a line', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', `token ${'ghp_'}${'123456789012345678901234567890123456'}\n`);
  writeFileSync(
    path.join(repo, 'scripts', 'publication-safety', 'config.json'),
    `${JSON.stringify({ allowedContentRegexes: ['.*'] }, null, 2)}\n`,
  );
  expectFail('unstaged config cannot weaken scanner rules', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, 'scripts', 'publication-safety', 'config.json'),
    `${JSON.stringify({ allowedContentRegexes: ['.*'] }, null, 2)}\n`,
  );
  must('git', ['add', 'scripts/publication-safety/config.json'], repo);
  stageFile(repo, 'README.md', `token ${'ghp_'}${'123456789012345678901234567890123456'}\n`);
  expectFail('staged config cannot weaken scanner rules', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, 'scripts', 'publication-safety', 'config.json'),
    '{ invalid json\n',
  );
  must('git', ['add', 'scripts/publication-safety/config.json'], repo);
  stageFile(repo, 'README.md', '# Invalid scanner config test\n');
  expectFail('invalid staged config fails closed', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=hide\n');
  writeFileSync(path.join(repo, 'hide-textconv.mjs'), "console.log('hidden');\n");
  must('git', ['config', 'diff.hide.textconv', 'node hide-textconv.mjs'], repo);
  const fakeToken = `token ${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'secret.txt', fakeToken);
  expectFail('textconv cannot hide staged secrets from scanner', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  writeFileSync(path.join(repo, 'external-diff.mjs'), "process.exit(0);\n");
  must('git', ['config', 'diff.external', 'node external-diff.mjs'], repo);
  const fakeToken = `token ${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('external diff cannot hide staged secrets from scanner', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  const largeContent = `${'a'.repeat(1024 * 1024 + 1)}\n${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'large.txt', largeContent);
  expectFail('large staged blobs cannot hide secrets from scanner', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, 'scripts', 'publication-safety', 'config.local.json'),
    `${JSON.stringify({ allowedContentRegexes: ['.*'] }, null, 2)}\n`,
  );
  const fakeToken = `token ${'ghp_'}${'123456789012345678901234567890123456'}\n`;
  stageFile(repo, 'README.md', fakeToken);
  expectFail('local config cannot weaken scanner rules', 'node', [scanScript], repo);
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# Review marker test\n');
  expectFail('missing marker blocks strict mode', 'node', [markerScript, '--check'], repo);
  expectPass(
    'write marker',
    'node',
    [
      markerScript,
      '--write',
      '--reviewers',
      'secrets,internal,license',
      '--summary',
      'final pass',
    ],
    repo,
  );
  expectPass('matching marker passes', 'node', [markerScript, '--check'], repo);
  stageFile(repo, 'README.md', '# Review marker changed\n');
  expectFail('stale marker rejected', 'node', [markerScript, '--check'], repo);
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# Duplicate reviewer marker test\n');
  expectFail(
    'duplicate marker reviewers are rejected',
    'node',
    [
      markerScript,
      '--write',
      '--reviewers',
      'secrets,secrets,secrets',
      '--summary',
      'duplicate reviewer test',
    ],
    repo,
  );
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# Weak marker test\n');
  const hash = must('node', [markerScript, '--hash'], repo).stdout.trim();
  mkdirSync(path.join(repo, '.git', 'publication-safety'), { recursive: true });
  writeFileSync(
    path.join(repo, '.git', 'publication-safety', `${hash}.json`),
    `${JSON.stringify({
      hash,
      verdict: 'pass',
      reviewers: ['secrets', 'secrets', 'secrets'],
      summary: 'duplicate reviewer test',
    }, null, 2)}\n`,
  );
  expectFail('weak marker without unique reviewers is rejected', 'node', [markerScript, '--check'], repo);
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# Blank reviewer marker test\n');
  const hash = must('node', [markerScript, '--hash'], repo).stdout.trim();
  mkdirSync(path.join(repo, '.git', 'publication-safety'), { recursive: true });
  writeFileSync(
    path.join(repo, '.git', 'publication-safety', `${hash}.json`),
    `${JSON.stringify({
      hash,
      verdict: 'pass',
      reviewers: ['', ' ', '\t'],
      summary: 'blank reviewer test',
    }, null, 2)}\n`,
  );
  expectFail('blank marker reviewers are rejected', 'node', [markerScript, '--check'], repo);
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# External diff bypass test\n');
  const normalHash = must('node', [markerScript, '--hash'], repo).stdout.trim();
  must('git', ['config', 'diff.external', 'true'], repo);
  const externalDiffHash = must('node', [markerScript, '--hash'], repo).stdout.trim();
  if (normalHash !== externalDiffHash) {
    throw new Error('marker hash changed when diff.external was configured');
  }
  console.log('PASS marker hash ignores external diff configuration');
}

{
  const repo = makeRepo();
  stageFile(repo, 'README.md', '# Unstaged marker config bypass test\n');
  writeFileSync(
    path.join(repo, 'scripts', 'publication-safety', 'config.json'),
    `${JSON.stringify({ strictReviewMarker: false }, null, 2)}\n`,
  );
  expectFail('unstaged config cannot disable marker check', 'node', [markerScript, '--check'], repo);
}
