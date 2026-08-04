# recipe v1 implementation audit

Audit date: 2026-07-14

## Verdict

The local-first prototype is executable, Phase 1 trust hardening is complete, and the Phase 2 zero-friction local workflow is implemented. Capture, normalized bundles, deterministic playback, recorded-test verification, mixed authorship, final-tree line attribution, privacy scrubbing and size bounds, publishing, git-note attachment, PR comment synchronization, remote artifact resolution, and shared recorder surfaces have automated coverage.

This is not yet the entire initial roadmap. The core is credible; developer adoption and live distribution proof remain the next work.

## Phase 1

| Area | Status | Evidence |
| --- | --- | --- |
| Replay contract | Complete | `exact`, `mixed`, and `drifted` retain tree meanings. Overall success requires an exact tree and matching recorded test outcomes; both replay commands exit nonzero otherwise. |
| Portable privacy | Complete | Public bundles omit raw transcripts without local paths, deterministically bound non-critical text, and preserve replay-critical bytes with explicit secret/oversize findings. |
| Attribution | Complete | Added-line ownership uses final-tree coordinates and is rebased through later edits. Replacements transfer ownership, pure renames preserve it, and deleted/binary content makes no misleading claim. |
| Schema 0.1 | Complete | Checked-in valid/invalid fixtures freeze recipe and ingest contracts, incompatible closed fields fail actionably, and canonical target hashing is deterministic. |
| Verification | Complete | Focused gates pass, the full suite passes 33/33, and a fresh temporary repository completes the full local workflow. |

Detailed command and test evidence is recorded in [`docs/phase-1-verification.md`](phase-1-verification.md); normative semantics are in [`docs/trust-model.md`](trust-model.md).

## Original plan

| Milestone | Assessment | Remaining evidence or work |
| --- | --- | --- |
| M0: spec and trust model | Implemented | Expand the four canonical schema fixtures into the originally proposed 10 public sample traces. |
| M1: recorder and playback core | Implemented | Build the originally proposed named 20-trace benchmark corpus, including dependency drift and aborted sessions. |
| M2: dual adapters | Mostly complete | Codex and Claude share one recorder and ingest contract; native event interception and same-task parity coverage remain. |
| M3: GitHub attachment | Partial | Notes, sticky comments, Release assets, and remote resolution work in automated simulations. Actual commit-message trailers and a public clean-clone GitHub proof remain. |
| M4: launch package | In progress | One-command onboarding, package allowlisting, packed-install verification, and a 60-second quickstart are implemented. An example repository, public demo PR, comparisons, CI matrix, and release distribution remain. |

## Shipping priorities

1. Add Linux and Windows CI evidence for the packed init/run/inspect/replay workflow; macOS is covered locally.
2. Publish the trace corpus and example repository, then replay a public demo PR from a clean clone without the operator's machine.
3. Decide the commit-trailer integration point before commit creation; post-commit rewriting changes commit identity.
4. Validate real GitHub permissions, fork/private-repository behavior, release limits, and failure recovery before describing the bridge as production-ready.

Known scope limits remain deliberate: no hosted backend, no post-hoc history reconstruction, no semantic branch porting, no hidden chain-of-thought capture, and no line attribution for deleted or binary content.
