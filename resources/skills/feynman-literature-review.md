---
name: feynman-literature-review
description: Run a literature review using paper search and primary-source synthesis. Use when the user asks for a lit review, paper survey, state of the art, or academic landscape summary on a research topic.
---

# Literature Review

Load `feynman_workflow` with workflow=lit and the user’s target as input, then perform its instructions. The human can also use `/feynman lit`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `verifier`, `reviewer`

Output: literature review in `<artifact-root>/outputs/` with `.provenance.md` sidecar. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
