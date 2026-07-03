#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function gitBuffer(args) {
  const result = spawnSync('git', args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error) {
    console.error(`git ${args.join(' ')} failed: ${result.error.message}`);
    console.error(`The staged diff may exceed the ${GIT_MAX_BUFFER} byte review-marker limit.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') || 'no stderr';
    console.error(`git ${args.join(' ')} failed: ${stderr}`);
    process.exit(1);
  }
  return result.stdout;
}

function diffHash() {
  const diff = gitBuffer([
    'diff',
    '--cached',
    '--binary',
    '--no-ext-diff',
    '--no-color',
    '--no-textconv',
  ]);
  return createHash('sha256').update(diff).digest('hex');
}

function gitDir() {
  return git(['rev-parse', '--git-dir']).trim();
}

function markerPath(hash) {
  return path.join(gitDir(), 'publication-safety', `${hash}.json`);
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key.startsWith('--') && next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else if (key.startsWith('--')) {
      args.set(key, true);
    }
  }
  return args;
}

function normalizeReviewers(reviewers) {
  if (!Array.isArray(reviewers)) {
    return [];
  }
  return reviewers
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasThreeUniqueReviewers(reviewers) {
  const normalized = normalizeReviewers(reviewers);
  return normalized.length >= 3 && new Set(normalized).size === normalized.length;
}

function checkMarker(hash) {
  const file = markerPath(hash);
  if (!existsSync(file)) {
    console.error(`Missing publication-safety review marker for staged diff ${hash}.`);
    console.error('Run independent reviews, then write a marker with:');
    console.error(
      'node scripts/publication-safety/mark-reviewed.mjs --write --reviewers secrets,internal,license --summary "final pass"',
    );
    process.exit(1);
  }
  const marker = JSON.parse(readFileSync(file, 'utf8'));
  const summary = typeof marker.summary === 'string' ? marker.summary.trim() : '';
  if (
    marker.hash !== hash ||
    marker.verdict !== 'pass' ||
    !hasThreeUniqueReviewers(marker.reviewers) ||
    !summary
  ) {
    console.error(`Invalid publication-safety review marker for staged diff ${hash}.`);
    process.exit(1);
  }
  console.log(`Publication-safety review marker accepted for ${hash}.`);
}

function writeMarker(hash, args) {
  const reviewers = normalizeReviewers(String(args.get('--reviewers') ?? '')
    .split(',')
    .map((value) => value.trim()));
  if (!hasThreeUniqueReviewers(reviewers)) {
    console.error('At least three unique independent reviewers are required.');
    process.exit(1);
  }
  const summary = String(args.get('--summary') ?? '').trim();
  if (!summary) {
    console.error('A final review summary is required.');
    process.exit(1);
  }
  const dir = path.dirname(markerPath(hash));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    markerPath(hash),
    `${JSON.stringify(
      {
        hash,
        verdict: 'pass',
        reviewers,
        summary,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote publication-safety review marker for ${hash}.`);
}

const args = parseArgs(process.argv);
const hash = diffHash();

if (args.has('--hash')) {
  console.log(hash);
} else if (args.has('--write')) {
  writeMarker(hash, args);
} else if (args.has('--check')) {
  checkMarker(hash);
} else {
  console.error('Use --hash, --write, or --check.');
  process.exit(1);
}
