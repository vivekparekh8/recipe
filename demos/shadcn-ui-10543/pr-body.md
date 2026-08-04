## Summary

Fixes the Base UI Select popup width when Base UI is actively aligning the selected item with the trigger value. The popup now compensates for the alignment inset only in `data-side="none"` mode, preserving the existing behavior when item alignment is disabled or Base UI falls back to side positioning.

Closes #10543.

## Test plan

- Added a focused regression test for conditional popup sizing, all eight generated Base styles, and Radix isolation.
- Rebuilt all eight Base style and registry targets.
- Passed the v4 TypeScript check, targeted ESLint, targeted Prettier, and `git diff --check`.
- Replayed the attached Recipe exactly and verified its bundle and attachment integrity.

No upstream PR was opened. This body is preserved for local review only.
