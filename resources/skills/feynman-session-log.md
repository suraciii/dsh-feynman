---
name: feynman-session-log
description: Write a durable session log capturing completed work, findings, open questions, and next steps. Use when the user asks to log progress, save session notes, write up what was done, or create a research diary entry.
---

# Session Log

Load `feynman_workflow` with workflow=log and the user’s focus as input, then perform its instructions. The human can also use `/feynman log [focus]`, which queues the same brief. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Output: session log in `notes/session-logs/`.
