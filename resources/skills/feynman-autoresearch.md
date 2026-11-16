---
name: feynman-autoresearch
description: Bounded research experiment loop that tries hypotheses, measures benchmark evidence, keeps what works, and records what fails. Use when the user asks to optimize a research metric, run an experiment loop, improve model/retrieval/evaluation performance iteratively, or benchmark a research hypothesis.
---

# Autoresearch

Load `feynman_workflow` with workflow=autoresearch and the user’s target as input, then perform its instructions. The human can also use `/feynman autoresearch`. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Run the benchmark through the shell and record each result, its evidence, and the keep/revert decision in the session files.

Session files: `<artifact-root>/experiments/autoresearch.md`, `<artifact-root>/experiments/autoresearch.sh`, `<artifact-root>/experiments/autoresearch.jsonl`
