#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG = {
  strictReviewMarker: true,
  blockedPathRegexes: [
    '(^|/)\\.env$',
    '(^|/)\\.env\\.(?!example$|sample$)[^/]+$',
    '\\.(pem|key|p12|pfx|sqlite|sqlite3|db|dump|log)$',
  ],
  blockedContentRegexes: [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    '\\bghp_[A-Za-z0-9_]{20,}\\b',
    '\\bglpat-[A-Za-z0-9_-]{20,}\\b',
    '\\bhf_[A-Za-z0-9]{20,}\\b',
    '\\bsk-[A-Za-z0-9_-]{20,}\\b',
    '\\bBearer\\s+[A-Za-z0-9._-]{30,}\\b',
  ],
};
const SAFE_ALLOWED_CONTENT_REGEXES = ['^example$', '^your-api-key$', '^sk-change-me$'];
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
    ...options,
  });
}

function mergeConfigs(...configs) {
  return configs.reduce((merged, config) => ({
    strictReviewMarker: merged.strictReviewMarker,
    blockedPathRegexes: [
      ...(merged.blockedPathRegexes ?? []),
      ...(config.blockedPathRegexes ?? []),
    ],
    blockedContentRegexes: [
      ...(merged.blockedContentRegexes ?? []),
      ...(config.blockedContentRegexes ?? []),
    ],
  }), {});
}

function mergeLocalStrictRules(config, localConfig) {
  return {
    ...config,
    blockedPathRegexes: [
      ...(config.blockedPathRegexes ?? []),
      ...(localConfig.blockedPathRegexes ?? []),
    ],
    blockedContentRegexes: [
      ...(config.blockedContentRegexes ?? []),
      ...(localConfig.blockedContentRegexes ?? []),
    ],
  };
}

function readJsonIfExists(configPath) {
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function readJsonFromIndexIfExists(indexPath) {
  let raw;
  try {
    raw = git(['show', `:${indexPath}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Invalid staged JSON in ${indexPath}: ${error.message}`);
    process.exit(1);
  }
}

function loadConfig() {
  const configDir = path.join(process.cwd(), 'scripts', 'publication-safety');
  const repoConfig = mergeConfigs(
    DEFAULT_CONFIG,
    readJsonFromIndexIfExists('scripts/publication-safety/config.json'),
  );
  return mergeLocalStrictRules(
    repoConfig,
    readJsonIfExists(path.join(configDir, 'config.local.json')),
  );
}

function toRegexList(patterns) {
  return patterns.map((pattern) => new RegExp(pattern, 'i'));
}

function isAllowed(value, allowRules) {
  return allowRules.some((rule) => rule.test(value));
}

function allMatches(value, rule) {
  const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
  const globalRule = new RegExp(rule.source, flags);
  const matches = [];
  let match;

  while ((match = globalRule.exec(value)) !== null) {
    matches.push(match[0]);
    if (match[0] === '') {
      globalRule.lastIndex += 1;
    }
  }

  return matches;
}

function redact(value) {
  if (value.length <= 12) {
    return '[redacted]';
  }
  return `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`;
}

function stagedFiles() {
  const raw = git([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMRTUXB',
    '--no-ext-diff',
    '--no-textconv',
    '-z',
  ]);
  return raw.split('\0').filter(Boolean);
}

function stagedFileContent(file) {
  try {
    return git(['show', `:${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    console.error(`Unable to read staged content for ${file}: ${error.message}`);
    process.exit(1);
  }
}

function main() {
  const config = loadConfig();
  const pathRules = toRegexList(config.blockedPathRegexes ?? []);
  const contentRules = toRegexList(config.blockedContentRegexes ?? []);
  const allowRules = toRegexList(SAFE_ALLOWED_CONTENT_REGEXES);
  const findings = [];

  const files = stagedFiles();

  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    for (const rule of pathRules) {
      if (rule.test(normalized)) {
        findings.push({
          type: 'path',
          file,
          rule: String(rule),
          sample: normalized,
        });
      }
    }
  }

  for (const file of files) {
    const content = stagedFileContent(file);
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      for (const rule of contentRules) {
        for (const matchedValue of allMatches(line, rule)) {
          if (isAllowed(matchedValue, allowRules)) {
            continue;
          }
          findings.push({
            type: 'content',
            file,
            rule: String(rule),
            sample: redact(matchedValue),
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error('Publication-safety scan failed:');
    for (const finding of findings) {
      console.error(
        `- ${finding.type} ${finding.file}: ${finding.rule} (${finding.sample})`,
      );
    }
    process.exit(1);
  }

  console.log('Publication-safety scan passed.');
}

main();
