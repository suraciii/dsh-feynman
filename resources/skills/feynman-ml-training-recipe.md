---
name: feynman-ml-training-recipe
description: Find implementable ML training recipes from papers, datasets, docs, and code. Use when the user wants to fine-tune, train, reproduce, or choose a practical ML method, dataset, hyperparameter setup, or benchmark recipe.
---

# ML Training Recipe

Load `feynman_workflow` with workflow=recipe and the user’s target as input, then perform its instructions. The human can also use `/feynman recipe`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, optionally `verifier`

Output: ranked recipe brief in `<artifact-root>/outputs/` with dataset, method, code, and source provenance. `<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream project-root layout).
