# Recipe 0.1 trust model

Recipe records user-visible provenance for an AI-assisted commit and deterministically
replays captured edits. It does not record hidden chain-of-thought, prove that an agent
understood a task, or regenerate a change from prompts.

## Replay outcomes

Replay starts from `repo.baseCommit`, applies checkpoint patches in event order, reruns
recorded test commands, and compares the resulting tree with `repo.targetCommit`.

- `exact`: every checkpoint applied and the replayed tree equals the captured target tree.
- `mixed`: every checkpoint applied, but the replayed tree differs from the captured target.
- `drifted`: at least one checkpoint could not be applied; later events are not replayed.

Tree status and test agreement are separate facts. Overall replay succeeds only when the
tree status is `exact` and every rerun test has the recorded exit code. An exact tree with
a changed test outcome is therefore unsuccessful and the replay commands exit nonzero.

## Attribution

Schema 0.1 attribution covers added text lines that survive in the captured final tree.
Coordinates returned by `recipe inspect --line` and rendered in summaries are final-tree
coordinates, not the coordinates of an intermediate checkpoint.

Checkpoint patches are processed in event order. A later insertion or deletion rebases
earlier ownership; deleting an attributed line removes its ownership; replacing it assigns
the replacement to the later checkpoint. A pure rename carries surviving attribution to
the new path. Cause and prompt fields identify the explicit causal event when present, or
the recorder's deterministic nearest-action inference.

Recipe makes no line-level claim for unchanged pre-existing lines, deleted lines, or
binary content. A binary change clears line attribution for that file. Unsupported or
malformed patch forms yield no attribution instead of checkpoint-local or guessed line
numbers.

## Replay-critical data

Deterministic replay requires:

- the original repository objects for `baseCommit` and `targetCommit`;
- ordered `file_edit_checkpoint` and `human_edit` events with complete patch bytes;
- recorded `test_run.command` values and expected exit codes;
- target tree and bundle integrity fingerprints used for comparison and verification.

The final patch is integrity and review data; checkpoint patches are what replay applies.
Prompts, summaries, tool inputs and outputs, approvals, and raw transcripts are useful
provenance but are not needed to apply the captured edits.

## Privacy and size limits

Public bundles contain normalized events, not raw agent transcripts. Raw transcripts are
local-only, are represented publicly only by path-free omission metadata, and are never
required by replay.

Secret scanning happens before publication. Secrets in non-replay-critical text are
redacted. Secrets found in replay-critical patches or test commands are preserved so replay
bytes do not change, and an explicit `preserved_replay_critical` finding records that risk.
Publishing should stop for review when such a finding is unacceptable.

Non-replay-critical text values are deterministically limited to 16 KiB of UTF-8 data after
redaction. Truncation metadata records the field path, original size, limit, published size,
and action. Checkpoint patches, final diffs, and test commands are never truncated; values
over 1 MiB produce an explicit oversize replay-critical finding.

## Schema compatibility

The frozen v0.1 identifier is exactly `0.1.0`. A bundle has six required sections:
`metadata`, `repo`, `instructions`, `events`, `outputs`, and `privacy`. Unknown structural
fields at closed schema levels are rejected, as are unknown event types, provenance states,
and ingest record kinds.

Documented open objects remain extension points: event `inputs`, `outputs`, and `result`,
the replay result object, referenced artifacts, and entries in privacy metadata arrays may
carry adapter- or producer-specific optional fields. A 0.1 consumer must ignore fields it
does not understand inside those objects. Adding a required field, changing a field type,
or changing a closed enum requires a new schema version.

Checked-in fixtures under `fixtures/schema/0.1.0/` define accepted and intentionally
rejected examples. Bundle integrity is deterministic: canonical JSON recursively sorts
object keys, sets `metadata.targetSha256` to `null` while hashing, and stores the resulting
SHA-256 in that field.
