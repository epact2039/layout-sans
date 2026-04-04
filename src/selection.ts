// LayoutSans — selection.ts (v0.2)
//
// Sub-glyph cursor resolution, selection state management, and clipboard text
// extraction. The critical invariant: zero CanvasRenderingContext2D.measureText()
// calls in any hot-path function (PRD §3.3). All glyph geometry is pre-computed
// by Pretext's prepareWithSegments() and stored in TextLineData.

import type { TextLineData, SelectionCursor, SelectionRange } from './types.js'

// ─── Engine interface (structural, no import of engine.ts → no circular dep) ──

/**
 * Minimal structural interface that LayoutEngine satisfies.
 * Used by getSelectedText() to read TextLineData and document order.
 */
export interface TextLayoutSource {
  /** Per-node segment/line data built during compute(). */
  readonly textLineMap: ReadonlyMap<string, TextLineData>
  /**
   * Node ids of all text/heading nodes in tree-traversal (document) order.
   * Used to enumerate the selection range across multiple nodes.
   */
  getOrderedTextNodeIds(): readonly string[]
}

// ─── SelectionState ───────────────────────────────────────────────────────────

/**
 * Singleton selection store owned by LayoutEngine.
 *
 * The canvas RAF loop reads from this object to paint highlight rects.
 * The Proxy Caret reads from it to populate textarea.value on change.
 *
 * onChange listeners are called synchronously inside set() / clear() so the
 * Proxy Caret can be updated before the browser's next event tick.
 */
export class SelectionState {
  private range: SelectionRange | null = null
  private readonly listeners: Array<() => void> = []

  /** Return the current SelectionRange, or null if nothing is selected. */
  get(): SelectionRange | null {
    return this.range
  }

  /** Replace the current selection. Notifies all onChange listeners. */
  set(range: SelectionRange): void {
    this.range = range
    this.notify()
  }

  /** Clear the selection. Notifies all onChange listeners. */
  clear(): void {
    this.range = null
    this.notify()
  }

  /** True when there is no active selection. */
  isEmpty(): boolean {
    return this.range === null
  }

  /**
   * Subscribe to selection changes (set / clear).
   * Returns an unsubscribe function — call it to remove the listener.
   *
   * @example
   * const off = sel.onChange(() => proxyCaret.syncText())
   * // later:
   * off()
   */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i !== -1) this.listeners.splice(i, 1)
    }
  }

  private notify(): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i]!()
    }
  }
}

// ─── resolvePixelToCursor ─────────────────────────────────────────────────────

/**
 * Resolve a canvas-space pixel coordinate to a SelectionCursor.
 *
 * @param nodeId    The node id reported by SpatialIndex.queryPoint().
 * @param localX    Hit X relative to record.x (i.e. canvas hitX − record.x).
 * @param localY    Hit Y relative to record.y (i.e. canvas hitY − record.y).
 * @param tld       TextLineData for the hit node (from LayoutEngine.textLineMap).
 * @returns         SelectionCursor with O(log k) grapheme resolution.
 *
 * Algorithm (PRD §3.3):
 *
 *   1. lineIndex = clamp(floor(localY / lineHeight), 0, lines.length − 1)
 *   2. clamp localX to [0, line.width]
 *   3. Walk segments line.start.segmentIndex … line.end.segmentIndex,
 *      accumulating accX using pre-measured widths. No measureText() called.
 *   4. For the hit segment:
 *        a. If breakablePrefixWidths[si] is non-null: binary search the array
 *           to find the largest grapheme index k where the cumulative prefix
 *           width ≤ (localX − accX) + base, where base corrects for a
 *           segment whose first line starts mid-segment (graphemeIndex > 0).
 *           O(log graphemes_in_segment) ≈ O(log 15) ≈ 4 comparisons.
 *        b. Otherwise (single-grapheme or non-breakable segment): snap to the
 *           grapheme boundary closer to localX.
 *   5. Return SelectionCursor { nodeId, lineIndex, segmentIndex, graphemeIndex,
 *      pixelX }.
 */
export function resolvePixelToCursor(
  nodeId: string,
  localX: number,
  localY: number,
  tld: TextLineData,
): SelectionCursor {
  const { lines, prepared, lineHeight } = tld

  // ── 1. Resolve line index ─────────────────────────────────────────────────
  if (lines.length === 0 || prepared.widths.length === 0) {
    return { nodeId, lineIndex: 0, segmentIndex: 0, graphemeIndex: 0, pixelX: 0 }
  }

  const rawLine = Math.floor(localY / lineHeight)
  const lineIndex = Math.max(0, Math.min(rawLine, lines.length - 1))
  const line = lines[lineIndex]!

  // ── 2. Clamp localX to visible line extent ────────────────────────────────
  const clampedX = Math.max(0, Math.min(localX, line.width))

  // ── 3. Walk segments ──────────────────────────────────────────────────────
  let accX = 0

  // LayoutLine.end is an EXCLUSIVE cursor (mirrors Pretext's buildLineTextFromRange
  // which loops `i < endSegmentIndex`):
  //
  //   • end.graphemeIndex === 0:  segment end.segmentIndex belongs entirely to the
  //     NEXT line.  The last visual segment on THIS line is end.segmentIndex − 1.
  //
  //   • end.graphemeIndex > 0:   segment end.segmentIndex is split across the line
  //     boundary; graphemes [0, end.graphemeIndex) are on this line.
  //
  // Without this distinction, a click exactly at the rightmost pixel of a line
  // (clampedX === line.width, which equals the sum of all real segment widths)
  // causes every `accX + segW > clampedX` check to return false, the loop falls
  // through to the forced `isLastSeg` exit on end.segmentIndex — a segment that
  // lives on the next line — and the returned cursor has the wrong segmentIndex.
  const hasPartialEndSeg = line.end.graphemeIndex > 0
  // trueEndSi: the highest segment index that has ANY content on this line.
  const trueEndSi = hasPartialEndSeg
    ? line.end.segmentIndex
    : Math.max(line.start.segmentIndex, line.end.segmentIndex - 1)
  // endGiForLastSeg: the exclusive grapheme upper bound for trueEndSi.
  //   • Partial-end segment → limit to the graphemes actually on this line.
  //   • Full segment (no split) → 0 = "through the last grapheme" (full).
  const endGiForLastSeg = hasPartialEndSeg ? line.end.graphemeIndex : 0

  for (let si = line.start.segmentIndex; si <= trueEndSi; si++) {
    // Start grapheme for this segment on this line (non-zero only for the first
    // segment when a long word was broken mid-segment onto this line).
    const startGi = si === line.start.segmentIndex ? line.start.graphemeIndex : 0
    const isLastSeg = si === trueEndSi
    const endGi = isLastSeg ? endGiForLastSeg : 0

    const segW = segmentWidthOnLine(prepared, si, startGi, endGi)

    // Hit condition: we've found the segment when localX is inside it, or when
    // we've reached the final segment (last resort — avoids falling off the end).
    const isHit = isLastSeg || accX + segW > clampedX

    if (isHit) {
      return resolveGraphemeInSegment(
        nodeId,
        lineIndex,
        si,
        startGi,
        isLastSeg ? endGi : 0,
        accX,
        clampedX,
        prepared,
      )
    }

    accX += segW
  }

  // Should be unreachable — the loop always exits via isHit on the last segment.
  return {
    nodeId,
    lineIndex,
    segmentIndex: trueEndSi,
    graphemeIndex: endGiForLastSeg,
    pixelX: line.width,
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Width contributed by segment `si` on a line, accounting for partial segments
 * (startGi > 0 when a long word was broken mid-segment onto this line, or
 *  endGi > 0 when the segment is truncated at the line's end cursor).
 *
 * Falls back to prepared.widths[si] when breakablePrefixWidths[si] is null
 * (single-grapheme or non-breakable segments are never split mid-grapheme).
 */
export function segmentWidthOnLine(
  prepared: import('@chenglou/pretext').PreparedTextWithSegments,
  si: number,
  startGi: number, // inclusive
  endGi: number,   // exclusive (0 = full remaining segment)
): number {
  const pfx = prepared.breakablePrefixWidths[si]
  if (pfx === null || pfx === undefined || pfx.length === 0) {
    return prepared.widths[si]!
  }
  // base = prefix width accumulated before the first visible grapheme on this line.
  const base = startGi > 0 ? pfx[startGi - 1]! : 0
  // end = prefix width at the last visible grapheme on this line.
  const endPfx = endGi > 0 ? pfx[endGi - 1]! : pfx[pfx.length - 1]!
  return endPfx - base
}

/**
 * Given that localX falls within segment `si`, binary-search
 * breakablePrefixWidths[si] for the exact grapheme boundary.
 *
 * Cursor semantics (mirrors browser / Pretext LayoutCursor):
 *   graphemeIndex = 0  → cursor BEFORE grapheme 0
 *   graphemeIndex = k  → cursor BEFORE grapheme k (after k−1)
 *   graphemeIndex = n  → cursor AFTER the last grapheme (end of segment)
 *
 * Binary search target:
 *   absTarget = (clampedX − accX) + base
 *   Find largest k in [startGi, maxGi] where pfx[k] ≤ absTarget.
 *   The returned graphemeIndex is k + 1 (cursor after grapheme k).
 *
 * pixelX (pre-computed caret X within the line, from record.x):
 *   accX + pfx[graphemeIndex − 1] − base   when graphemeIndex > 0
 *   accX                                    when graphemeIndex = 0
 */
function resolveGraphemeInSegment(
  nodeId: string,
  lineIndex: number,
  si: number,
  startGi: number, // inclusive grapheme start for this line
  endGi: number,   // exclusive (0 = full segment)
  accX: number,    // pixel X at left edge of segment on line
  clampedX: number,
  prepared: import('@chenglou/pretext').PreparedTextWithSegments,
): SelectionCursor {
  const pfx = prepared.breakablePrefixWidths[si]

  // ── Single-grapheme or non-breakable segment: snap to nearest boundary ────
  if (pfx === null || pfx === undefined || pfx.length === 0) {
    const segW = prepared.widths[si]!
    const mid = accX + segW * 0.5
    const graphemeIndex = clampedX >= mid ? startGi + 1 : startGi
    const pixelX = graphemeIndex > startGi ? accX + segW : accX
    return { nodeId, lineIndex, segmentIndex: si, graphemeIndex, pixelX }
  }

  // ── Multi-grapheme: binary search ─────────────────────────────────────────
  // base: absolute prefix width already consumed before the first visible
  // grapheme (non-zero only when this segment was split across a line break).
  const base = startGi > 0 ? pfx[startGi - 1]! : 0
  const absTarget = clampedX - accX + base

  // Search range: [startGi, maxGi] (both inclusive grapheme indices into pfx).
  // maxGi is the last grapheme whose right edge we consider; for the final
  // segment of the line endGi is exclusive so we back off by 1.
  const maxGi = endGi > 0 ? endGi - 1 : pfx.length - 1

  let lo = startGi
  let hi = maxGi
  // Default: cursor before the first visible grapheme.
  let graphemeIndex = startGi

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pfx[mid]! <= absTarget) {
      // localX is at or past the right edge of grapheme `mid` — cursor is
      // at least after this grapheme.
      graphemeIndex = mid + 1
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  // Clamp: cursor cannot exceed the right boundary of the visible range.
  if (graphemeIndex > maxGi + 1) graphemeIndex = maxGi + 1

  // Pre-compute pixelX: canvas X position of the caret within the line.
  // pfx[graphemeIndex − 1] is the cumulative width through the grapheme to the
  // left of the cursor; subtract base to get line-relative offset.
  const pixelX =
    graphemeIndex > 0
      ? accX + pfx[graphemeIndex - 1]! - base
      : accX

  return { nodeId, lineIndex, segmentIndex: si, graphemeIndex, pixelX }
}

// ─── getSelectedText ──────────────────────────────────────────────────────────

/**
 * Normalise a SelectionRange so that `start` is always document-earlier than
 * `end`, returning [start, end, isReversed].
 *
 * Document order is determined by the `orderedIds` array (the engine's
 * getOrderedTextNodeIds() result). Within the same node, line/segment/grapheme
 * indices determine order.
 */
export function normalizeSelection(
  range: SelectionRange,
  orderedIds: readonly string[],
): [start: SelectionCursor, end: SelectionCursor, reversed: boolean] {
  const { anchor, focus } = range

  // Same node — compare intra-node position.
  if (anchor.nodeId === focus.nodeId) {
    const anchorFirst = cursorLessThanOrEqual(anchor, focus)
    return anchorFirst
      ? [anchor, focus, false]
      : [focus, anchor, true]
  }

  // Different nodes — compare document order.
  const ai = orderedIds.indexOf(anchor.nodeId)
  const fi = orderedIds.indexOf(focus.nodeId)

  if (ai <= fi) return [anchor, focus, false]
  return [focus, anchor, true]
}

/** True when cursor a is ≤ cursor b within the same node (no cross-node check). */
function cursorLessThanOrEqual(a: SelectionCursor, b: SelectionCursor): boolean {
  if (a.lineIndex !== b.lineIndex) return a.lineIndex < b.lineIndex
  if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex < b.segmentIndex
  return a.graphemeIndex <= b.graphemeIndex
}

/**
 * Extract the plain-text string covered by the current selection.
 *
 * Walks the in-memory TextLineData map — no DOM reads, no measureText() calls.
 * This is called once on mouseup / Ctrl+C, not in the mousemove hot path.
 *
 * @param range       The selection range to extract (use state.get() if needed).
 * @param source      A TextLayoutSource (LayoutEngine satisfies this structurally).
 */
export function getSelectedText(
  range: SelectionRange,
  source: TextLayoutSource,
): string {
  const orderedIds = source.getOrderedTextNodeIds()
  const [start, end] = normalizeSelection(range, orderedIds)

  if (orderedIds.length === 0) return ''

  const startIdx = orderedIds.indexOf(start.nodeId)
  const endIdx = orderedIds.indexOf(end.nodeId)
  if (startIdx === -1 || endIdx === -1) return ''

  const parts: string[] = []

  for (let ni = startIdx; ni <= endIdx; ni++) {
    const nodeId = orderedIds[ni]!
    const tld = source.textLineMap.get(nodeId)
    if (!tld) continue

    const isFirst = ni === startIdx
    const isLast = ni === endIdx

    // For the first node, start from the start cursor's line.
    // For the last node, end at the end cursor's line.
    const lineStart = isFirst ? start.lineIndex : 0
    const lineEnd = isLast ? end.lineIndex : tld.lines.length - 1

    for (let li = lineStart; li <= lineEnd; li++) {
      const line = tld.lines[li]
      if (!line) continue

      // Add a newline before each new line except the very first chunk.
      if (parts.length > 0 && (li > lineStart || ni > startIdx)) {
        parts.push('\n')
      }

      const isFirstLine = isFirst && li === start.lineIndex
      const isLastLine = isLast && li === end.lineIndex

      if (!isFirstLine && !isLastLine) {
        // Middle line — take the full text.
        parts.push(line.text)
      } else {
        // Partial line — extract by segment / grapheme.
        const startCursor = isFirstLine ? start : null
        const endCursor = isLastLine ? end : null
        parts.push(extractLineText(tld, li, startCursor, endCursor))
      }
    }
  }

  return parts.join('')
}

/**
 * Extract text from a single LayoutLine, optionally trimming from a start
 * cursor and/or to an end cursor.
 *
 * Null cursor means "no trim on that side" (full line edge).
 *
 * Uses Intl.Segmenter to split segment text into grapheme clusters — this is
 * acceptable because getSelectedText() is not in the mousemove hot path.
 */
function extractLineText(
  tld: TextLineData,
  lineIndex: number,
  startCursor: SelectionCursor | null,
  endCursor: SelectionCursor | null,
): string {
  const line = tld.lines[lineIndex]
  if (!line) return ''

  const { prepared } = tld
  const kinds = prepared.kinds
  const segments = prepared.segments

  // Resolve effective segment/grapheme bounds for this line.
  const startSi = startCursor !== null ? startCursor.segmentIndex : line.start.segmentIndex
  const startGi = startCursor !== null ? startCursor.graphemeIndex : line.start.graphemeIndex
  const endSi = endCursor !== null ? endCursor.segmentIndex : line.end.segmentIndex
  const endGi = endCursor !== null ? endCursor.graphemeIndex : line.end.graphemeIndex

  // Reuse a shared segmenter for grapheme splitting (created once per call to
  // extractLineText; Intl.Segmenter has negligible construction cost).
  const segmenter = new Intl.Segmenter()

  let text = ''

  for (let si = startSi; si <= endSi; si++) {
    const kind = kinds[si]
    // Skip invisible / non-content segments.
    if (kind === 'soft-hyphen' || kind === 'hard-break') continue

    const segText = segments[si]!
    const isSingleBoundary = si === startSi && si === endSi
    const isStartSeg = si === startSi
    const isEndSeg = si === endSi

    if (!isStartSeg && !isEndSeg) {
      // Full middle segment.
      text += segText
      continue
    }

    // Partial segment: split into grapheme clusters.
    const graphemes = [...segmenter.segment(segText)].map(g => g.segment)

    // Determine the grapheme slice [gi0, gi1).
    const gi0 = isStartSeg ? startGi : 0

    // endGi is exclusive (cursor before that grapheme). 0 means end-of-segment.
    //
    // IMPORTANT: for non-breakable segments (breakablePrefixWidths[si] is null
    // or empty), graphemeIndex is a binary position marker: 0 = before the
    // whole segment, 1 = after the whole segment. It does NOT mean "1 grapheme
    // of content". Without this guard, a non-breakable word like "Architecture"
    // with endGi=1 would yield graphemes.slice(0, 1) = ["A"] instead of the
    // full word. Non-breakable segments always take graphemes.length.
    const pfxForSeg = prepared.breakablePrefixWidths[si]
    const isNonBreakable = !pfxForSeg || pfxForSeg.length === 0
    const gi1 = isEndSeg && endGi > 0 && !isNonBreakable ? endGi : graphemes.length

    // Validate and slice.
    const safeGi0 = Math.max(0, Math.min(gi0, graphemes.length))
    const safeGi1 = Math.max(safeGi0, Math.min(gi1, graphemes.length))

    if (isSingleBoundary) {
      text += graphemes.slice(safeGi0, safeGi1).join('')
    } else {
      text += graphemes.slice(safeGi0, safeGi1).join('')
    }
  }

  return text
}

// ─── Cursor conversion utilities ──────────────────────────────────────────────

/**
 * Convert a grapheme-counted character offset into a SelectionCursor.
 *
 * Used by LayoutEngine.setSelection() and the mobile long-press Proxy Caret
 * sync path (PRD §6.3, Step 5).
 *
 * The `charOffset` is counted in Pretext grapheme units — matching the same
 * model as SelectionCursor.graphemeIndex. Walk segments in line order until
 * the cumulative count reaches the target.
 */
export function charOffsetToCursor(
  prepared: import('@chenglou/pretext').PreparedTextWithSegments,
  charOffset: number,
  tld: TextLineData,
): SelectionCursor {
  let remaining = charOffset

  for (let li = 0; li < tld.lines.length; li++) {
    const line = tld.lines[li]!

    for (let si = line.start.segmentIndex; si <= line.end.segmentIndex; si++) {
      // Number of graphemes in this segment (on this line).
      const pfx = prepared.breakablePrefixWidths[si]
      const startGi = si === line.start.segmentIndex ? line.start.graphemeIndex : 0
      const endGi   = si === line.end.segmentIndex   ? line.end.graphemeIndex   : 0

      // The line.end cursor is exclusive: when endGi === 0, the segment at
      // line.end.segmentIndex is the first segment of the NEXT line and has
      // zero graphemes on this visual line. Counting it here would inflate
      // `remaining` so that charOffset values targeting later lines resolve
      // to the wrong (earlier) line.
      if (si === line.end.segmentIndex && endGi === 0) continue

      // For non-breakable segments (pfx null/empty), count actual JS string
      // characters so this matches charOffset values from String.indexOf().
      // Using pfx.length=0 as a proxy for 1 grapheme was wrong: a single
      // non-breakable segment like "Architecture" has 12 chars, not 1.
      const graphemeCount = pfx && pfx.length > 0
        ? (endGi > 0 ? endGi : pfx.length) - startGi
        : (prepared.segments[si]?.length ?? 1)

      if (remaining <= graphemeCount) {
        return segmentIndexToCursor(tld, li, si, startGi + remaining, prepared)
      }

      remaining -= graphemeCount
    }
  }

  // Offset exceeds text length — clamp to end of last line.
  const lastLi   = tld.lines.length - 1
  const lastLine  = tld.lines[lastLi]!
  const lastSi    = lastLine.end.segmentIndex
  const lastGi    = lastLine.end.graphemeIndex
  const pixelX    = lastLine.width

  return {
    nodeId: tld.nodeId,
    lineIndex: lastLi,
    segmentIndex: lastSi,
    graphemeIndex: lastGi,
    pixelX,
  }
}

/**
 * Convert a (lineIndex, segmentIndex, graphemeIndex) triple into a
 * SelectionCursor with a pre-computed pixelX.
 *
 * Called by charOffsetToCursor and the word-expansion logic in mouse.ts.
 * Pre-computes pixelX by walking segment widths from the line start to `si`,
 * then querying breakablePrefixWidths — zero measureText() calls.
 */
export function segmentIndexToCursor(
  tld: TextLineData,
  lineIndex: number,
  si: number,
  gi: number,
  prepared?: import('@chenglou/pretext').PreparedTextWithSegments,
): SelectionCursor {
  const p = prepared ?? tld.prepared
  const line = tld.lines[lineIndex]
  if (!line) {
    return { nodeId: tld.nodeId, lineIndex, segmentIndex: si, graphemeIndex: gi, pixelX: 0 }
  }

  // Accumulate pixel width from the start of the line to the target segment.
  let accX = 0
  for (let s = line.start.segmentIndex; s < si; s++) {
    const startGi = s === line.start.segmentIndex ? line.start.graphemeIndex : 0
    accX += segmentWidthOnLine(p, s, startGi, 0)
  }

  // Pixel X within segment `si` at grapheme `gi`.
  let pixelX = accX
  const pfx     = p.breakablePrefixWidths[si]
  const baseGi  = si === line.start.segmentIndex ? line.start.graphemeIndex : 0
  const base    = pfx && baseGi > 0 ? pfx[baseGi - 1]! : 0

  if (pfx && pfx.length > 0 && gi > 0) {
    pixelX = accX + (pfx[gi - 1] ?? pfx[pfx.length - 1]!) - base
  } else if ((!pfx || pfx.length === 0) && gi > 0) {
    pixelX = accX + (p.widths[si] ?? 0)
  }

  return { nodeId: tld.nodeId, lineIndex, segmentIndex: si, graphemeIndex: gi, pixelX }
}
