---
name: feynman-source-comparison
description: Compare multiple sources on a topic and produce a grounded comparison matrix. Use when the user asks to compare papers, tools, approaches, frameworks, or claims across multiple sources.
---

# Source Comparison

Load `feynman_workflow` with workflow=compare and the user’s target as input, then perform its instructions. The human can also use `/feynman compare`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `verifier`

Output: comparison matrix in `<artifact-root>/outputs/`. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
