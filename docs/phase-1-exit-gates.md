# Phase 1 exit gates

Phase 1 is complete only when all gates below are demonstrated by automated tests and the full suite remains green.

## Replay trust

- Tree status remains `exact`, `mixed`, or `drifted` with stable meanings.
- Overall replay succeeds only when the tree is exact and every recorded test outcome matches.
- Human and JSON output expose the tree status and test result without conflating them.
- `recipe replay` and `recipe diff-replay` exit nonzero for a non-exact tree, an unappliable checkpoint, or test-outcome drift.
- Fixtures cover exact replay, mixed replay, checkpoint-application drift, and exact-tree test drift.

## Portable privacy

- A serialized public recipe contains no absolute path to the operator's repository, git directory, session directory, or raw transcript.
- Raw transcript contents remain local and replay never requires them.
- Non-replay-critical text is deterministically bounded before publication, with path, original size, applied limit, and action recorded in privacy metadata.
- Replay-critical patches and final diffs are never truncated; oversize values produce an explicit finding.
- Secret redaction and size bounding compose without changing replay-critical bytes.

## Attribution contract

- Attribution coordinates are either correct for the captured final tree or explicitly identified as checkpoint-local everywhere they are rendered.
- Multiple checkpoints that insert or remove earlier lines cannot silently attribute a final line to the wrong step.
- Added lines, deletions, renames, and binary changes have documented behavior; unsupported cases return no attribution instead of a misleading answer.

## Schema 0.1 freeze

- The checked-in `0.1.0` recipe and ingest fixtures validate against the published schemas.
- Invalid or incompatible fixtures fail with actionable validation errors.
- New optional result/privacy metadata remains readable by existing `0.1.0` consumers.
- Canonical serialization and target SHA-256 remain deterministic.

## Verification

- Focused Phase 1 tests pass.
- `npm test` passes from the repository root.
- A fresh temporary repository completes capture, finalization, publication, inspection, verification, and exact replay.
