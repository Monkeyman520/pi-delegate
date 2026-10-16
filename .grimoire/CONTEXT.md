# Context

## Concepts

### ThinkingPeek
- **Definition:** An open-tui presentation capability that monitors assistant reasoning streams and renders dynamic progress telemetry into Pi's native collapsed thinking component header (`HiddenThinkingComponent`). Supports single-line and two-line preview modes.
- **Synonyms:** Thinking Preview, Reasoning Peek
- **Relationships:**
  - contains DynamicSpinner
  - contains MilestoneExtraction
  - contains StreamingDuration
  - contains CollapsedThinkingSummary
  - contains SanitizedThinkingPreview

### DynamicSpinner
- **Definition:** An autonomous interval-based animation ticker (default 80ms) that continuously advances spinner animation frames and recalculates elapsed thinking duration during active reasoning, independent of incoming stream chunk delivery.
- **Synonyms:** Thinking Ticker, TickerTimer
- **Relationships:**
  - belongs to ThinkingPeek

### MilestoneExtraction
- **Definition:** Rule-based heuristic extraction from cumulative thinking text that identifies high-level reasoning phases, markdown headings, numbered steps, or guidance keywords (e.g., Planning, Analyzing, Checking, 规划, 分析, 检查) and formats them into a bracketed milestone badge.
- **Synonyms:** Phase Extraction, Reasoning Milestone
- **Relationships:**
  - belongs to ThinkingPeek

### StreamingDuration
- **Definition:** Real-time elapsed duration tracked from the first thinking chunk of an assistant turn, updated continuously via the dynamic ticker and frozen upon completion.
- **Synonyms:** Elapsed Timing, Thinking Duration
- **Relationships:**
  - belongs to ThinkingPeek

### CollapsedThinkingSummary
- **Definition:** A persistent completion summary label retained on the collapsed thinking block after thinking ends or settles (showing completed glyph, frozen duration, and milestone metadata), replacing legacy transient clearing.
- **Synonyms:** Completed Thinking Label
- **Relationships:**
  - belongs to ThinkingPeek

### SanitizedThinkingPreview
- **Definition:** Normalized preview text stripped of markdown headings, code fences, inline backticks, blockquotes, and bullet markers before clipping to terminal width budgets.
- **Relationships:**
  - belongs to ThinkingPeek
