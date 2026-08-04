# Contract and hook safety verification

Verified locally on 2026-07-14.

## Implemented contract

- Agent-created commits finalize and attach automatically.
- Dirty output requires interactive confirmation or `--commit`.
- Non-interactive runs without consent exit `2` as `awaiting_commit`.
- `--no-commit` suppresses Recipe-created commits and preserves the active run.
- Managed hooks use Git's effective `post-commit` path without modifying `core.hooksPath`.
- Hook uninstall removes only Recipe's marked block and restores original content and mode.
- Unsupported hooks remain untouched and produce manual-chain guidance.
- `init`, `doctor`, and `status` share cross-platform agent and hook detection.

## Evidence

- Focused bootstrap, consent, hook, and packed-install tests: 13 passed, 0 failed.
- Full suite: 45 passed, 0 failed.
- Packed tarball workflow installs, captures, attaches, uninstalls the hook, uninstalls the package, and restores the prior hook and Git configuration.
- Package dry-run contains 38 allowlisted runtime entries: `package.json`, `README.md`, `LICENSE`, and `src/**`.
- GitHub Actions runs the complete suite on macOS, Linux, and Windows.

The macOS gate was executed locally. Linux and Windows execution remains a remote CI gate and should be required before release; this workspace has no configured GitHub remote on which to run it.
