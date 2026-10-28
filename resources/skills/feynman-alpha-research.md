---
name: feynman-alpha-research
description: Search, read, and query research papers via Feynman's alphaXiv-backed alpha tools. Use when the user asks about academic papers, wants to find research on a topic, needs to read a specific paper, ask questions about a paper, inspect a paper's code repository, or manage paper annotations.
---

Use alpha_search, alpha_get_paper, alpha_ask_paper, alpha_read_code, alpha_annotate_paper, and alpha_list_annotations when visible. Use `/feynman alpha login|status|logout` for account management and `/feynman alpha` for the supported action grammar. A missing account must fall back to feynman_science_database_search and feynman_fetch_content (or web_fetch for a single HTML page), with unavailable AlphaXiv-only checks marked blocked. Never assume the old Honk API or a bare global alpha installation. Keep generated AlphaXiv reports distinct from raw paper evidence.
