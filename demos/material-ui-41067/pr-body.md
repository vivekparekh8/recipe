Fixes https://github.com/mui/material-ui/issues/41067

Persistent SpeedDial action labels had no positioning styles for horizontal expansion. `SpeedDial` supplied `top`, but the static tooltip renderer only implemented `left` and `right`, causing labels to overlap action buttons.

This change:

- keeps the existing `left` default for `up` and `down` directions;
- defaults `left` and `right` directions to `bottom`;
- adds static label positioning and utility classes for `top` and `bottom`;
- verifies all direction defaults, caller overrides, and static placement styles.

Validation:

- `pnpm test:node SpeedDial --run`: 113 passed, 20 skipped
- file-scoped Prettier: passed
- file-scoped ESLint: passed
- Material package TypeScript check: passed in the captured implementation run
- deterministic Recipe replay: exact

No generated files, lockfiles, or unrelated formatting are included.
