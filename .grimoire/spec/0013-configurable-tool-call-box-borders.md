# Configurable tool-call box border styling

**Spec ID:** 0013  
**Status:** Draft  
**Date:** 2026-10-13  
**Sources:** Accepted refinement contract (Clarified options 1.A, 2.A, 3.A); [ADR 0018](../adr/0018-public-host-tool-renderer-composition.md); [ADR 0019](../adr/0019-universal-tool-presentation-with-specialized-composition.md); `packages/pi-open-tui/src/tool-presentation.ts`.

## Source and Coordination Boundary

- **Intent:** In the current TUI, tool calls and their results need to appear as a box. The border of this box must support configurable top, bottom, and left border styles (symbols/line types such as single line, symbols, double line, dashed lines, thickness/weight, colors, and visibility/presence).
- **Settled Requirements:**
  - **Scope (1.A):** Covers tool call and tool result presentation cards in `packages/pi-open-tui`.
  - **Geometry (2.A):** 3-sided open box (top, bottom, and left edges; right edge is open).
  - **Style & Configuration (3.A):**
    - Presets for line styles/weights (`single`, `bold`, `double`, `dashed`, `custom`).
    - Independent per-edge (`top`, `bottom`, `left`) visibility toggles (`enabled`).
    - Independent per-edge character/symbol overrides.
    - Border color configuration supporting static colors and dynamic tool execution state coloring (running, ok, error).
- **Endpoint and Permissions:** Spec-only endpoint. No code implementation, dependency installation, or ticket decomposition (`grimoire-slice`) at this stage.

## Requirements

### R1 — Tool call card box scope
- Apply the box border presentation to tool call and tool result cards rendered by the Open TUI presentation layer.
- Framing applies to the tool presentation card as a single visual unit enclosing the call header and result output.
- When tool presentation enhancement is disabled, fallback to standard unenhanced presentation.

### R2 — Three-sided open box geometry
- Support borders on three edges:
  - **Top edge:** Horizontal border rendered above the tool call content.
  - **Left edge:** Vertical rail border rendered alongside all content lines of the tool presentation card.
  - **Bottom edge:** Horizontal border rendered below the tool call result.
- The right edge remains open (no right border). Content flows naturally across the terminal width.
- When both an adjacent horizontal edge (top or bottom) and the left vertical rail are enabled, the junction between them must connect without visual gaps.

### R3 — Configurable line styles, symbols, and edge visibility
- Provide line style presets representing distinct visual line weights and patterns: `single`, `bold`, `double`, `dashed`, and `custom`.
- Each edge (top, bottom, left) must support an independent visibility toggle to allow turning that side on or off.
- Each edge must allow specifying custom symbols/characters to override default preset glyphs.

### R4 — Border color and dynamic status-based coloring
- Border color must be configurable.
- Support dynamic color mode where the border color reflects the tool's execution status (running, ok, error).
- Support static color mode where a fixed configured color or theme token is applied.

### R5 — Terminal width and layout safety
- Top and bottom horizontal borders must fit within the available terminal column width without line wrapping.
- Left border must indent inner content cleanly to prevent overlap with tool content.

## Solution

### Seams

| Seam | Connects | Expects | Provides |
| --- | --- | --- | --- |
| Card Frame Decorator | `tool-presentation.ts` (`frame`) → TUI Component Tree | Configured border styles, tool execution status, card content | Encloses tool call components with configured top, left, and bottom borders |
| Border Configuration | `config.ts` (`OpenTuiConfig`) → Presentation Components | User/workspace configuration | Resolved border style presets, edge visibility, symbols, and color mode |

## End-to-End Tests

### Scenario 1: Top, bottom, and left borders with status color
- **Given:** Tool presentation is enabled with top, bottom, and left borders enabled, and color mode set to status-based.
- **When:** A tool call executes and completes.
- **Then:** The tool card renders with a top border line, left vertical rail, and bottom border line.
- **Then:** The borders display the active running color during execution and transition to ok (success) or error upon completion.

### Scenario 2: Selective edge visibility
- **Given:** User configuration disables the bottom border while keeping top and left borders enabled.
- **When:** A tool call card is rendered.
- **Then:** The top border and left rail are rendered, and no bottom border line is rendered.

### Scenario 3: Custom symbol override
- **Given:** User configures custom characters for the top border and left rail.
- **When:** A tool call card is rendered.
- **Then:** The top border and left rail use the configured custom characters.

## Decisions

- **Choice:** 3-sided open box geometry (top, bottom, left enabled; right open).
  - **Reason/source:** Clarified decision (Option 2.A). Avoids terminal padding alignment issues and wrapping breakage on variable terminal widths.
- **Choice:** Presentation scope limited to tool call / tool result cards.
  - **Reason/source:** Clarified decision (Option 1.A). Keeps borders focused on tool cards rather than modifying assistant message components.
- **Choice:** Style presets plus per-edge overrides and status/static coloring.
  - **Reason/source:** Clarified decision (Option 3.A). Fulfills user requirements for line type, symbols, thickness, color, and visibility.

## Implementation Details & Reversible Defaults (Non-blocking)

*These are implementation-level design choices to be decided during implementation, not hard contractual constraints:*
- Exact default Unicode glyphs for presets (e.g. `─`/`│`, `━`/`┃`, `═`/`║`, `┄`/`┆`).
- ASCII fallback mappings when terminal icon mode is ASCII.
- Exact TypeScript property names and schema nesting in `OpenTuiConfig`.
- Specific default theme color token names mapped to running/ok/error statuses.

## Out of Scope

- Right vertical border closure.
- Box borders around assistant markdown text, user message bubbles, or thinking peek blocks.
- Interactive border dragging or mouse resizing.
