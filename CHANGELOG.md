# Changelog

## v0.1.2 — Patch (bug fixes + performance)

### 🐛 Bug fixes

**Bug #1 — Absolute container reported wrong x/y** (`absolute.ts`, `engine.ts`)

`solveAbsolute` was computing the correct resolved position but not returning it.
`engine.ts` was reading the *first child's* `x`/`y` as the container's own position.
An absolute container with no children would snap to the parent origin entirely.

Fix: `AbsoluteResult` now includes `x` and `y`. `engine.ts` uses `result.x` /
`result.y` directly for the container record.

**Bug #2 — `push(...solveNode())` crashes at ~65 k nodes** (all solvers)

Every solver used `records.push(...ctx.solveNode(...))`. V8's `Function.prototype.apply`
passes spread args on the call stack with a hard limit of ~65 000–130 000 arguments.
At 100 k nodes this throws `RangeError: Maximum call stack size exceeded`, directly
undermining the headline benchmark.

Fix: All spread-into-push patterns replaced with explicit `for` loops. A `pushAll<T>()`
helper added to `engine.ts` for the container + children return pattern.

---

### ⚡ Performance

**Perf #3 — `measureNode` for containers ran the full layout twice** (`engine.ts`, `flex.ts`, `grid.ts`)

When a flex container had `alignItems` other than `stretch`, the engine called
`solveNode` on each cross-axis child just to read its height — allocating every
descendant record and immediately discarding them. For trees where a root flex row
contains many flex-column children, this was O(n²) layout work.

Fix: Added `measureFlexSize()` (flex.ts) and `measureGridSize()` (grid.ts) —
lightweight paths that run the size-distribution passes only and never allocate
output records. `measureNode` now routes `flex` and `grid` nodes through these.

**Perf #4 — No fast-path for `direction: 'row'`** (`flex.ts`)

`solveFlexColumn` had an O(n) fast path for vertical fixed-size lists. There was
no symmetric path for the horizontal case, so nav bars, toolbars, and card rows
fell through to the full 3-pass solver unnecessarily.

Fix: Added `solveFlexRow()` — same guard conditions as the column path (all
fixed-size `box` children, no flex-grow, no margins, `justifyContent: flex-start`),
single O(n) loop, no intermediate allocations.

---

### 🔧 Algorithm correctness

**Algo #6 — flex-shrink weight used `mainSize` instead of `flexBasis`** (`flex.ts`)

Per the CSS Flexbox spec, the shrink factor weight must be `flexShrink × flexBasis`,
not `flexShrink × mainSize`. The difference is only visible when a child has an
explicit `flexBasis` that differs from its intrinsic size.

Fix: Shrink weight now resolves `flexBasis` first, falling back to `mainSize` when
`flexBasis` is not set (auto).

---

### 🔧 Limit lifted

**Limit #7 — Magazine node could only spill across 2 columns** (`magazine.ts`)

The column-overflow logic used a hardcoded `part0` / `part1` split, so a content
block taller than two columns was truncated after the second. This was a silent data
loss for large `columnCount` values with tall blocks.

Fix: Replaced the two-step split with a `while (remaining > 0)` loop. A tall block
now emits `part0`, `part1`, `part2`, … until all content is placed across as many
columns as needed.

---

## v0.1.0 — Initial release

- Flexbox layout (row/column, flex-grow, flex-shrink, gap, align, justify, wrap)
- Basic grid (uniform columns or rows)
- Magazine multi-column text flow
- Absolute positioning
- Pretext integration for text measurement
- Virtualization-ready flat output
- Column fast-path for fixed-size vertical lists
