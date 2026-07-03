# LunarCodeInterpreter Publication Readiness

LunarCodeInterpreter is a public fork of ClickHouse Code Interpreter.

This repository must not contain internal deployment details, production
domains, private URLs, customer or employee data, secrets, local machine paths,
or private source-control references.

## Upstream And License

- Preserve upstream Apache-2.0 license material.
- Preserve upstream NOTICE attribution.
- Add prominent change notices to modified Apache-2.0 files when required.
- Do not imply official ClickHouse, LibreChat, or OpenAI affiliation.
- For prominent references, use the required trademark legend:
  `ClickHouse is a registered trademark of ClickHouse, Inc.`
  See `https://clickhouse.com/legal/trademark-policy`.

## Commit Gate

Before every commit:

1. Run the deterministic publication-safety staged-diff scanner.
2. Run independent reviews for secrets, internal data, and licensing/branding.
3. Record a local review marker only after the final consolidated verdict is pass.
4. Commit without bypassing hooks.

Install the local hook in every checkout before committing:

```sh
git config core.hooksPath .githooks
```

Organization-specific scanner patterns belong in the ignored local overlay
`scripts/publication-safety/config.local.json`, not in tracked files.
Tracked and local scanner configs may only add stricter blocked-path or
blocked-content rules; allowlisted placeholders are owned by the scanner code.
