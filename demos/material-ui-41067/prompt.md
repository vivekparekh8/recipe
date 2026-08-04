Fix https://github.com/mui/material-ui/issues/41067 in this checkout. The issue is currently open and concerns persistent SpeedDialAction tooltips overlapping actions when SpeedDial direction is left or right.

Read and follow AGENTS.md, CLAUDE.md, CONTRIBUTING.md, and relevant existing SpeedDial/SpeedDialAction tests. Keep the fix narrowly scoped. Do not commit, push, modify lockfiles, or touch unrelated files; Recipe will create the commit.

Requirements:
- Preserve the existing default tooltip placement of "left" for both vertical directions, "up" and "down".
- For both horizontal directions, "left" and "right", use a non-overlapping default static-tooltip placement. Prefer "bottom" consistently unless the existing architecture strongly requires another choice.
- Implement actual static-tooltip positioning styles for both "top" and "bottom" placements in SpeedDialAction, including appropriate transform origins and spacing, rather than only changing a class name.
- Add the missing top/bottom utility classes and keep public class typing/generation consistent.
- Add focused regression tests covering all four direction-to-default-placement mappings and top/bottom static-tooltip styles. Ensure vertical behavior is unchanged and caller-provided tooltip placement still overrides the default.
- Follow existing code style and testing conventions. Do not weaken or delete tests.

Run the smallest authoritative checks: the jsdom-only SpeedDial/SpeedDialAction tests, then focused lint/type checks that are practical for the changed files. Report commands and outcomes, including any environment limitation.
