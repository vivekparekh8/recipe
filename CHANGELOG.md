# Changelog

Recipe follows semantic versioning after the experimental `0.x` line. The CLI and schema may still change before 1.0.

## 0.1.0 - 2026-08-10

First public early preview.

- Capture AI-assisted changes with explicit commit consent and resumable interrupted runs.
- Inspect event timelines and map final-tree lines back to causal steps and prompts.
- Deterministically replay edit checkpoints and verify bundle, attachment, tree, and test integrity.
- Record mixed agent and human authorship without requiring raw transcript publication.
- Attach portable recipe metadata through Git notes and hand off public-safe artifacts through GitHub.
- Compose with existing Git hooks and restore repository configuration on uninstall.
- Support Codex and Claude Code adapters plus arbitrary agent commands through `recipe run`.
- Verify packed installation and the complete 47-test workflow on Linux, macOS, and Windows.
