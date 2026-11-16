---
name: feynman-preview
description: Render Markdown or LaTeX research artifacts to HTML or PDF with pandoc. Use when the user wants to review a written artifact, export a report, or view a rendered document.
---

# Preview

Render Markdown or LaTeX artifacts with pandoc through the shell. `/feynman doctor` does not test pandoc: check `command -v pandoc` yourself and report a missing renderer instead of assuming it is installed.

```bash
ARTIFACT_ROOT=.feynman   # or "." for the upstream layout; see .feynman/project.json
pandoc "$ARTIFACT_ROOT/outputs/<slug>.md" -s -o "$ARTIFACT_ROOT/outputs/<slug>.html"   # HTML
pandoc "$ARTIFACT_ROOT/outputs/<slug>.md" -o "$ARTIFACT_ROOT/outputs/<slug>.pdf"       # PDF (needs a LaTeX engine)
open "$ARTIFACT_ROOT/outputs/<slug>.html"                                               # macOS; xdg-open on Linux
```

`<artifact-root>` is the project artifact root recorded in `.feynman/project.json` (default `.feynman/`; `.` keeps the upstream layout). Rendered HTML and PDF files are previews; the Markdown artifact stays canonical. If pandoc or a LaTeX engine is missing, say so and leave the Markdown artifact as the deliverable.
