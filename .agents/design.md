# vibecodereview design context

## Overview

vibecodereview has a `developer-ui` surface: Action metadata, CLI output, MCP JSON-RPC, logs, and generated Markdown findings.

The main sources are `action.yml`, `bin/vibecodereview.mjs`, `mcp/server.mjs`, and `scripts/council-review.mjs`.

Keep the engine as the output source of truth. Surfaces must not fork provider or lens behavior.

## Colors

The CLI and MCP server define no ANSI colors. Status and errors use visible text.

GitHub Action metadata sets the Marketplace icon to `eye` and its color to `purple` in `action.yml`.

Treat that metadata as platform branding, not a product palette. Do not derive colors from the logo alone.

## Typography

Host terminals and Markdown renderers control fonts. The repository defines no font family, weight, or scale.

Use plain text for CLI output. Preserve literal provider keys, commands, paths, and configuration names.

Generated findings use Markdown headings, blockquotes, italics, and inline code from `scripts/council-review.mjs`.

## Layout

CLI command output follows the order in `bin/vibecodereview.mjs`.

`doctor` prints `Chair:`, then two-space-indented status rows. It follows with `Council members:` and their status rows.

`review-prs` separates pull requests with `=== owner/repo#number ===`. It ends with reviewed and error counts.

The MCP server sends one JSON-RPC object per line on standard output. Parse errors go to standard error.

Findings start with one H1 and an explanatory paragraph. Notices use blockquotes. Each member gets one H2 with its lens.

The terminal controls wrapping. JSON-RPC framing must remain one object per line.

## Elevation & Depth

Not applicable. The developer surfaces define no overlays, shadows, or stacking.

Headings, blank lines, blockquotes, and indentation express hierarchy.

## Shapes

CLI status uses words such as `set`, `MISSING`, `not set`, `SKIP/ERR`, and `ok`.

Multi-repository output uses `===` separators. Findings use judge, warning, and information symbols with text labels.

The current surfaces define no controls, radii, spinners, or custom borders.

## Components

The CLI exposes `init`, `review`, `review-prs`, `doctor`, and `secrets`.

`init` reports the written workflow and next step. `secrets` prints commands without reading secret values.

`review` prints generated findings. `review-prs` can also post them through the GitHub CLI.

The MCP server exposes `council_review`. Successful and failed tool calls return text content inside JSON-RPC responses.

The council report lists each model and lens. Missing keys, failures, and truncation appear as explicit notes.

The GitHub Action combines the council findings with a chair review. Fix pushes depend on its configured inputs and limits.

The owned surfaces define no animation. Text labels keep status understandable without color or motion.

## Do's and Don'ts

- Do keep provider and lens logic in the engine. Do not copy it into a surface.
- Do disclose skipped members and truncated input. Do not imply full council coverage when members did not run.
- Do keep MCP standard output valid JSON-RPC. Do not write decorative logs there.
- Do preserve text status and error labels. Do not make meaning depend on color or symbols.
- Do treat findings as claims for verification. Do not present raw council output as confirmed defects.
- Do add delivery routes only after ownership is proven. Do not infer ownership from the shared catalog link.
