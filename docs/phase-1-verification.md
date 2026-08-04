# Phase 1 verification

Verified on 2026-07-14 with Node.js v22.17.0.

| Exit gate | Implementation evidence | Verification |
| --- | --- | --- |
| Replay trust | Tree status and overall success are separate; `replay` and `diff-replay` fail on non-exact trees, unappliable checkpoints, or changed test outcomes. | `test/replay.test.js`: exact, mixed, drifted, exact-tree test drift, and mixed authorship. |
| Portable privacy | Published omission metadata is path-free; non-critical strings are bounded to 16 KiB; replay-critical values are preserved and flagged over 1 MiB. | `test/privacy.test.js` and `test/capture-session.test.js`: redaction, deterministic UTF-8 truncation, oversize preservation, and serialized path checks. |
| Attribution contract | Added-line ownership is maintained in final-tree coordinates across insertions, deletions, replacements, and pure renames; binary and unsupported content returns no claim. | `test/attribution.test.js`: shifted lines, replacement, rename, binary fallback, and deterministic ranges. |
| Schema 0.1 freeze | Runtime validation rejects incompatible closed fields and versions while documented extension objects remain open; canonical target hashing is deterministic. | `test/schema-command.test.js` and `fixtures/schema/0.1.0/`: valid and invalid recipe/ingest fixtures plus canonical hash checks. |
| Full integration | Capture, adapters, storage, publishing, GitHub resolution, replay, attribution, schema, and verification remain compatible. | `npm test`: 33 passed, 0 failed. |
| Fresh-repository flow | A temporary Git repository completed capture, checkpoint, test recording, commit, finalization, publication, inspection, verification, line lookup, and exact replay. | `node scripts/generate-screenshots.js`: exit 0; refreshed all five `docs/screenshots/*.svg` artifacts. |

The normative guarantees and explicit non-claims are in [`docs/trust-model.md`](trust-model.md). Phase 1 is complete against [`docs/phase-1-exit-gates.md`](phase-1-exit-gates.md).
