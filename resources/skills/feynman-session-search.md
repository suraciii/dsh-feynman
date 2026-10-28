---
name: feynman-session-search
description: Search saved DSH transcripts to recover previous research and artifact paths.
---

Search transcripts under ~/.dsh/sessions/ (or the host’s configured session directory). Sessions are stored as `session.v4.jsonl.zstd`, so decompress first (`zstd -dc file | rg -i <term>`) or use `rg -z`; a plain `rg` over the directory matches nothing. DSH records append-only session events, including user/message, assistant/message, and tool/result; inspect the actual JSONL schema before extracting fields. Recover source URLs, verification state, and artifact paths rather than treating an old summary as current evidence. Resume through DSH’s session controls. `/feynman search` browses current-session web results, not previous sessions.
