---
name: feynman-paper-code-audit
description: Compare a paper's claims against its public codebase. Use when the user asks to audit a paper, check code-claim consistency, verify reproducibility of a specific paper, or find mismatches between a paper and its implementation.
---

# Paper-Code Audit

Load `feynman_workflow` with workflow=audit and the user’s target as input, then perform its instructions. The human can also use `/feynman audit`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `verifier`

Output: audit report in `<artifact-root>/outputs/`. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
