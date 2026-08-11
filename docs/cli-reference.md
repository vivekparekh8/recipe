# CLI reference

This page covers Recipe's advanced and lower-level surfaces. Most users need only `init`, `doctor`, `run`, `inspect`, and `verify` from the main README.

## Repository setup

```bash
recipe init
recipe init --no-hooks
recipe doctor
recipe doctor --json
recipe status
recipe status --json
recipe hooks install
recipe hooks status
recipe hooks uninstall
```

`recipe init` stores local state under the Git directory and composes a versioned managed block into a compatible shell `post-commit` hook. It does not replace `core.hooksPath`. Uninstall removes only Recipe's block and preserves external edits.

## One-command capture

```bash
recipe run --commit --message "fix: parser bounds" --prompt "Fix parser bounds" -- codex exec --full-auto
recipe run --commit --prompt "Refactor parser" -- claude --print
recipe run --no-commit --prompt "Explore a fix" -- aider
recipe run --resume -- codex exec --full-auto
recipe run --abort
```

Arguments after `--` are forwarded exactly, with no shell interpolation. `--message` applies only when Recipe creates the commit.

## Inspect, replay, and verify

```bash
recipe inspect HEAD
recipe inspect HEAD --timeline
recipe inspect HEAD --line src/file.js:42
recipe replay HEAD
recipe diff-replay HEAD
recipe verify HEAD --replay
recipe verify HEAD --replay --json
```

Replay applies each captured checkpoint to the recorded base, reruns recorded test commands, and compares the resulting tree with the target commit. An overall successful replay requires an exact tree and matching test outcomes.

## Recipe references

Commands that accept a recipe reference can resolve:

```text
HEAD
<commit-sha>
pr:123
pr:123#45
pr:123@abcdef12
https://github.com/owner/repo/releases/download/recipe-artifacts/<bundle>.json.zst
```

`pr:123#45` selects a synced Recipe comment. `pr:123@abcdef12` selects a recipe by target commit prefix. Use `recipe resolve <ref> --json` to inspect the selected source and resolution metadata.

## Publishing and GitHub handoff

```bash
recipe publish HEAD
recipe publish HEAD --verify --replay
recipe publish HEAD --release-tag recipe-artifacts
recipe github sync-pr --pr 123 HEAD --replay
recipe github sync-pr --pr 123 HEAD --replay --release-tag recipe-artifacts
```

Local publishing writes a compressed bundle, Markdown summary, trailer block, reviewer comment, and machine-readable manifest. It also attaches portable metadata through `refs/notes/recipe`.

The GitHub bridge uses `gh` to upsert one sticky PR comment. `--release-tag` optionally uploads public-safe artifacts to a GitHub release asset bucket so reviewers can resolve the recipe without the operator's machine.

## Low-level recorder

```bash
recipe capture --start --source-agent codex --base HEAD --prompt "Fix calc"
recipe capture --checkpoint --session <id> --summary "Apply agent edits"
recipe capture --record-test --session <id> --command "npm test"
recipe capture --finalize --session <id> --target HEAD
recipe capture --input work/example-recipe.json
```

The lower-level flow exists for adapter authors. It starts a session, appends normalized events, captures incremental working-tree patches, records tests, and finalizes against a target commit.

## Thin adapters and JSONL ingest

```bash
recipe codex start --prompt "Fix calc" --json
recipe codex step --session <id> --command "node scripts/edit.js"
recipe codex observe --session <id> --command "codex exec ..."
recipe codex test --session <id> --command "npm test"
cat events.jsonl | recipe codex ingest --session <id> --stdin
recipe codex finalize --session <id> --target HEAD

recipe claude start --prompt "Refactor parser"
recipe claude observe --session <id> --command "claude --print ..."
```

Supported streamed record kinds are `prompt`, `transcript`, `shell`, `tool`, `test`, `checkpoint`, and generic `event`. Both adapters produce the same recipe bundle format.

## Open schemas

```bash
recipe schema recipe
recipe schema ingest-record
recipe schema ingest-stream
recipe validate recipe HEAD
recipe validate ingest events.jsonl
```

The open schemas define the versioned recipe bundle and normalized ingest records. Current normalization code lives in `src/core/schema.js` and `src/core/recipe.js`.

## Storage

| Data | Default location |
| --- | --- |
| Recipe bundle | `.git/recipes/<target-commit>.json.zst` |
| Configuration | `.git/recipe/` |
| Active sessions | `.git/recipe-sessions/` |
| Publish artifacts | `.git/recipe-publish/` |
| Commit attachment | `refs/notes/recipe` |

Raw transcripts stay local and are not required to inspect, publish, verify, or replay a structured recipe.
