---
name: feynman-deep-research
description: Run a thorough, source-heavy investigation on any topic. Use when the user asks for deep research, a comprehensive analysis, an in-depth report, or a multi-source investigation. Produces a cited research brief with provenance tracking.
---

# Deep Research

Load `feynman_workflow` with workflow=deepresearch and the user’s target as input, then perform its instructions. The human can also use `/feynman deepresearch`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `verifier`, `reviewer`

Output: cited brief in `<artifact-root>/outputs/` with `.provenance.md` sidecar. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
