# Recipe OSS demos

Three independent agents produced these local, PR-ready fixes through `recipe run`. The coordinator reviewed issue suitability, diff scope, privacy, bundle restoration, deterministic replay, and verification on 2026-07-20.

| Repository | Open issue | Base | Target | Targeted regression | Replay | Demo |
|---|---|---|---|---|---|---|
| emotion-js/emotion | [#3386](https://github.com/emotion-js/emotion/issues/3386) | `b882bcba8513` | `2a88c4549523` | 1/1 coordinator rerun; 217/217 package run | Exact | [emotion-3386](emotion-3386/) |
| mui/material-ui | [#41067](https://github.com/mui/material-ui/issues/41067) | `307ccfd4fac5` | `ae3853d5c903` | 113 passed, 20 skipped | Exact | [material-ui-41067](material-ui-41067/) |
| shadcn-ui/ui | [#10543](https://github.com/shadcn-ui/ui/issues/10543) | `bc0705384b51` | `50fd7bf22fcc` | 2/2 coordinator rerun; eight Base targets built | Exact | [shadcn-ui-10543](shadcn-ui-10543/) |

## Acceptance

- All three issues were rechecked open, unassigned, and without linked active development on 2026-07-20.
- All three commits reconstruct from their declared base plus `demo.git.bundle`.
- All three normalized recipes replay to the exact target tree and pass `verify --replay` with zero failures.
- All readable artifacts and decompressed Recipe bundles were scanned for credentials, usernames, and temporary or absolute local paths; no findings remained.
- Emotion and shadcn targeted regressions were rerun by the coordinator. Material UI's preserved 113-test result was reviewed, but a fresh reinstall was not attempted after the temporary volume reached its disk limit.
- The recipes currently contain patch checkpoints but no normalized `test_run` events, so deterministic replay reports tests `0/0`; authoritative rerunnable test commands and outputs are included in each demo.

The five warnings in each `verify.json` are expected for local-only demos without hosted release URLs. Run `recipe publish HEAD --output .git/recipe-publish` after bundle restoration to regenerate local files referenced by the Recipe note before full verification.

## Publication status

These demos are **PR-ready locally**, not published upstream. No branch was pushed, no issue was commented on, and no upstream pull request was opened.

Machine-readable coordinator evidence is available in [audit.json](audit.json). The reusable reconstruction audit is [`scripts/audit-demos.mjs`](../scripts/audit-demos.mjs); optional `RECIPE_DEMO_*_SOURCE` environment variables can point it at local mirrors.
