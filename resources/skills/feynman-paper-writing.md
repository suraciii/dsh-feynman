---
name: feynman-paper-writing
description: Turn research findings into a polished paper-style draft with sections, equations, and citations. Use when the user asks to write a paper, draft a report, write up findings, or produce a technical document from collected research.
---

# Paper Writing

Load `feynman_workflow` with workflow=draft and the user’s target as input, then perform its instructions. The human can also use `/feynman draft`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `writer`, `verifier`

Output: paper draft in `<artifact-root>/papers/`. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
