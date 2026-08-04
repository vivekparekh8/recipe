# Phase 2 workflow verification

Verified on 2026-07-14 with Node.js v22.17.0.

| Requirement | Evidence |
| --- | --- |
| `recipe init` | Creates versioned local state under the Git directory, changes no tracked files or hooks, and is idempotent. |
| `recipe run --prompt "..." -- <agent>` | Forwards exact argv without a shell, records the prompt and command, snapshots the resulting tree, creates a commit when needed, finalizes the recipe, and attaches it through `refs/notes/recipe`. |
| No workflow plumbing | The successful human output contains no session ID. Checkpoints, finalization, publication, and attachment require no follow-up commands. |
| Existing agent commits | A commit created by the wrapped agent is reused rather than followed by an empty Recipe commit. Repository-wide changes are captured even when invoked from a subdirectory. |
| Safe failure behavior | A dirty starting tree is rejected. A nonzero agent exit is not committed and can be resumed with `recipe run --resume` or discarded with `recipe run --abort`, without supplying an identifier. |
| Hook coexistence | `RECIPE_RUN_MANAGED` prevents the optional Recipe post-commit hook from racing the run orchestrator; existing hook automation retains its independent behavior. |
| Runtime package | The npm allowlist contains only runtime source plus package metadata and the README. A packed installation completes init, run, inspect, and exact replay from an unrelated temporary repository. |

Automated coverage lives in `test/init-run.test.js`, `test/package-install.test.js`, and `test/hooks-automation.test.js`. The full suite must remain green before release.

Final verification: `npm test` completed with 39 passed and 0 failed. The packed-install test invoked the installed binary from a fresh repository and completed `init`, `run`, `inspect`, `verify --replay`, and exact `replay`.
