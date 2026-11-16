---
name: feynman-research-review
description: Run a tough but constructive internal research critique of an AI research artifact. Use when the user asks for a review, critique, feedback on a paper or draft, or wants to identify weaknesses before submission.
---

# Research Review

Load `feynman_workflow` with workflow=review and the user’s target as input, then perform its instructions. The human can also use `/feynman review`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `reviewer`

Output: structured review in `<artifact-root>/outputs/`. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
