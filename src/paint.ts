// LayoutSans — paint.ts (v0.2)
//
// Canvas 2D painting functions for the selection/search/focus interaction layer.
//
// Architecture constraints (PRD §4.3, §9.3):
//   • All pixel painting is done exclusively via the Canvas 2D API. Zero DOM.
//   • Called inside the existing RAF loop AFTER background + content painting,
//     BEFORE text glyphs — so glyphs render above selection highlights exactly
//     as browsers render ::selection.
//   • All paths are allocation-free in steady state (no new objects per frame).
//   • O(visible_selected_lines) — culled by viewport bounds.

import type { BoxRecord, TextLineData, SelectionRange, SelectionCursor } from './types.js'
import { normalizeSelection, segmentWidthOnLine } from './selection.js'

// ─── Selection color constants ────────────────────────────────────────────────

/** System-blue selection for light-mode backgrounds (matches macOS/Windows). */
const SELECTION_COLOR_LIGHT = 'rgba(0, 120, 215, 0.35)'

/** Lighter blue for dark-mode backgrounds (higher contrast on dark fills). */
const SELECTION_COLOR_DARK  = 'rgba(100, 155, 255, 0.38)'

/**
 * Detect dark mode once at module load time. Callers can override via the
 * `selectionColor` option in InteractionOptions.
 * Guarded for SSR environments where `window` is undefined.
 */
const prefersDark: boolean =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

const DEFAULT_SELECTION_COLOR = prefersDark ? SELECTION_COLOR_DARK : SELECTION_COLOR_LIGHT

// ─── paintSelection ───────────────────────────────────────────────────────────

/**
 * Paint the selection highlight rects for the current SelectionRange.
 *
 * Must be called AFTER painting the background and box fills, and BEFORE
 * painting text glyphs, so glyphs appear above the highlight.
 *
 * @param ctx               The canvas 2D rendering context.
 * @param sel               The current selection range (from SelectionState.get()).
 * @param recordMap         Map of nodeId → BoxRecord (from engine.getAllRecords()).
 * @param textLineMap       Map of nodeId → TextLineData (from engine.textLineMap).
 * @param orderedTextNodeIds  Document-order array of text/heading node ids.
 * @param scrollY           Current vertical scroll offset (world-space pixels).
 * @param viewportH         Canvas viewport height in CSS pixels (for culling).
 * @param selectionColor    Optional override for the highlight fill color.
 */
export function paintSelection(
  ctx: CanvasRenderingContext2D,
  sel: SelectionRange,
  recordMap: ReadonlyMap<string, BoxRecord>,
  textLineMap: ReadonlyMap<string, TextLineData>,
  orderedTextNodeIds: readonly string[],
  scrollY: number,
  viewportH: number,
  selectionColor = DEFAULT_SELECTION_COLOR,
): void {
  if (orderedTextNodeIds.length === 0) return

  // ── 1. Normalize: ensure start is document-earlier than end ───────────────

  const [start, end] = normalizeSelection(sel, orderedTextNodeIds)

  // Collapsed selection — nothing to paint.
  if (
    start.nodeId === end.nodeId &&
    start.lineIndex    === end.lineIndex &&
    start.segmentIndex === end.segmentIndex &&
    start.graphemeIndex === end.graphemeIndex
  ) return

  // ── 2. Find the document-order range of affected nodes ────────────────────

  const startIdx = orderedTextNodeIds.indexOf(start.nodeId)
  const endIdx   = orderedTextNodeIds.indexOf(end.nodeId)
  if (startIdx === -1 || endIdx === -1) return

  ctx.fillStyle = selectionColor

  // ── 3. Paint each node in the range ──────────────────────────────────────

  for (let ni = startIdx; ni <= endIdx; ni++) {
    const nodeId = orderedTextNodeIds[ni]!
    const record = recordMap.get(nodeId)
    const tld    = textLineMap.get(nodeId)
    if (!record || !tld || tld.lines.length === 0) continue

    const { lineHeight, originX, originY } = tld

    // Which lines within this node are selected?
    const isFirstNode = ni === startIdx
    const isLastNode  = ni === endIdx

    const lineStart = isFirstNode ? start.lineIndex : 0
    const lineEnd   = isLastNode  ? end.lineIndex   : tld.lines.length - 1

    for (let li = lineStart; li <= lineEnd; li++) {
      const line = tld.lines[li]
      if (!line) continue

      // Canvas Y for this line (viewport-space).
      const rectY = originY + li * lineHeight - scrollY

      // Viewport culling — skip lines that are entirely off-screen.
      if (rectY + lineHeight < 0) continue
      if (rectY > viewportH)     continue

      // ── Compute highlight X extent ────────────────────────────────────────

      const isFirstLine = isFirstNode && li === start.lineIndex
      const isLastLine  = isLastNode  && li === end.lineIndex

      // Left edge: start of line, or cursor pixelX within first selected line.
      const rectX = isFirstLine
        ? originX + start.pixelX
        : originX

      // Right edge: end of line, or cursor pixelX within last selected line.
      const rectEndX = isLastLine
        ? originX + end.pixelX
        : originX + line.width

      const rectW = rectEndX - rectX

      // Skip degenerate (zero-width) rects — can happen on collapsed same-line
      // selections that didn't normalise to equality above (floating-point edge).
      if (rectW <= 0) continue

      ctx.fillRect(rectX, rectY, rectW, lineHeight)
    }
  }
}

// ─── paintSearchHighlights ────────────────────────────────────────────────────

/** A resolved pixel-space rectangle for one search match. */
export interface SearchMatchRect {
  nodeId: string
  charStart: number
  charEnd: number
  /** Pixel rectangle in world space (scrollY not yet applied). */
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Paint search match highlights for all visible matches.
 *
 * Active match uses orange; all other matches use yellow.
 * Both colors use alpha so text glyphs remain readable.
 *
 * @param ctx             The canvas 2D rendering context.
 * @param matches         All search matches with their pixel rects.
 * @param activeIndex     Index of the currently focused match.
 * @param scrollY         Current vertical scroll offset.
 * @param viewportH       Canvas viewport height in CSS pixels (for culling).
 * @param inactiveColor   Override for non-active match color.
 * @param activeColor     Override for active match color.
 */
export function paintSearchHighlights(
  ctx: CanvasRenderingContext2D,
  matches: SearchMatchRect[],
  activeIndex: number,
  scrollY: number,
  viewportH: number,
  inactiveColor = 'rgba(255, 220, 0, 0.45)',
  activeColor   = 'rgba(255, 165, 0, 0.75)',
): void {
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    const canvasY = m.rect.y - scrollY

    // Viewport culling.
    if (canvasY + m.rect.height < 0) continue
    if (canvasY > viewportH)         continue

    ctx.fillStyle = i === activeIndex ? activeColor : inactiveColor
    ctx.fillRect(m.rect.x, canvasY, m.rect.width, m.rect.height)
  }
}

// ─── paintFocusRing ───────────────────────────────────────────────────────────

/**
 * Paint a 2px focus ring around a focused link's bounding box.
 *
 * Called by the RAF loop when a Shadow Semantic Tree `<a>` element holds
 * keyboard focus and fires the 'focus' event (PRD §7.2).
 *
 * @param ctx         The canvas 2D rendering context.
 * @param record      The BoxRecord for the focused link node.
 * @param scrollY     Current vertical scroll offset.
 * @param accentColor System accent color for the ring (default: Windows blue).
 */
export function paintFocusRing(
  ctx: CanvasRenderingContext2D,
  record: BoxRecord,
  scrollY: number,
  accentColor = '#0078d4',
): void {
  const RING_WIDTH  = 2
  const RING_OFFSET = 2  // px gap between content and ring

  ctx.save()
  ctx.strokeStyle = accentColor
  ctx.lineWidth   = RING_WIDTH
  // Rounded corners to match OS focus ring aesthetics.
  const x = record.x - RING_OFFSET
  const y = record.y - RING_OFFSET - scrollY
  const w = record.width  + RING_OFFSET * 2
  const h = record.height + RING_OFFSET * 2
  const r = 3  // corner radius

  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y,     x + w, y + r,     r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x,     y + h, x,     y + h - r, r)
  ctx.lineTo(x,     y + r)
  ctx.arcTo(x,     y,     x + r, y,         r)
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
}

// ─── charRangeToRect ─────────────────────────────────────────────────────────

/**
 * Convert a character offset range within a text node to a pixel rectangle.
 *
 * Used by the search engine to convert match positions into screen coordinates.
 * Zero measureText() calls — all geometry comes from TextLineData.
 *
 * @param nodeId      The text node's id.
 * @param charStart   Grapheme-counted start offset (inclusive).
 * @param charEnd     Grapheme-counted end offset (exclusive).
 * @param tld         TextLineData for the node.
 * @param record      BoxRecord for the node.
 * @returns           Pixel rect in world space, or null if offsets are invalid.
 */
export function charRangeToRect(
  nodeId: string,
  charStart: number,
  charEnd: number,
  tld: TextLineData,
  record: BoxRecord,
): { x: number; y: number; width: number; height: number } | null {
  const { prepared, lines, lineHeight } = tld

  // Walk segments in line order, counting graphemes, until we find start and end.
  let count = 0
  let startX: number | null = null
  let startY: number | null = null
  let endX: number   | null = null
  let endLineY: number | null = null

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    let lineX = 0  // accumulated pixel X within this line

    for (let si = line.start.segmentIndex; si <= line.end.segmentIndex; si++) {
      const pfx = prepared.breakablePrefixWidths[si]
      const startGi = si === line.start.segmentIndex ? line.start.graphemeIndex : 0
      const endGi   = si === line.end.segmentIndex   ? line.end.graphemeIndex   : 0
      const graphemesInSeg = pfx && pfx.length > 0
        ? (endGi > 0 ? endGi : pfx.length) - startGi
        : 1
      const segW = segmentWidthOnLine(prepared, si, startGi, endGi)

      for (let g = 0; g < graphemesInSeg; g++) {
        const absoluteCount = count + g

        if (absoluteCount === charStart) {
          // Pixel X of this grapheme within the line.
          let gx = lineX
          if (pfx && pfx.length > 0 && g > 0) {
            const base = startGi > 0 ? pfx[startGi - 1]! : 0
            gx = lineX + pfx[startGi + g - 1]! - base
          }
          startX = record.x + gx
          startY = record.y + li * lineHeight
        }

        if (absoluteCount === charEnd - 1) {
          // Pixel X of the right edge of this (last) grapheme.
          let gx = lineX + segW
          if (pfx && pfx.length > 0) {
            const base  = startGi > 0 ? pfx[startGi - 1]! : 0
            gx = lineX + pfx[startGi + g]! - base
          }
          endX     = record.x + gx
          endLineY = record.y + li * lineHeight
        }
      }

      lineX += segW
      count += graphemesInSeg
    }
  }

  if (startX === null || startY === null || endX === null) return null

  // Multi-line matches: return a rect covering just the first line for now.
  // The search highlight painter handles multi-line by building one rect
  // per match; for a proper multi-line highlight, callers can call this
  // function per line. The simple single-rect is sufficient for the MVP.
  return {
    x: startX,
    y: startY,
    width: endX - startX,
    height: lineHeight,
  }
}
