# Security policy

## Reporting a vulnerability

Please do not open a public issue for suspected credential exposure, path traversal, unsafe command execution, artifact tampering, or a privacy-boundary bypass.

Use GitHub's private vulnerability reporting for this repository. Include the affected command, a minimal reproduction, impact, and whether public Recipe artifacts are involved. You should receive an acknowledgement within five business days.

## Scope

Security-sensitive surfaces include redaction, bundle validation, attachment resolution, replay path handling, Git hook composition, GitHub artifact publication, and exact argument forwarding.

Recipe executes commands explicitly supplied by its operator and replays recorded test commands. A recipe from an untrusted source should be inspected before replay, just as an untrusted build script should be reviewed before execution.

Raw transcripts are local-only by design. Public artifacts should never contain credentials or absolute local paths; please report any counterexample privately.
