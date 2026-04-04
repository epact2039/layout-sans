// LayoutSans — mouse.ts (v0.2)
//
// Canvas mouse event handlers: mousedown, mousemove, mouseup, dblclick.
//
// Architecture constraints (PRD §4.2):
//   • All painting is deferred to the RAF loop — mousemove never calls ctx APIs.
//   • SpatialIndex.queryPoint() gives O(log n) hit-testing; no O(n) iteration.
//   • Sub-glyph cursor resolution uses pre-computed Pretext segment data — zero
//     measureText() calls in the mousemove hot path.
//   • RAF repaints are coalesced: multiple mousemove events within one frame
//     trigger a single requestAnimationFrame callback.
//
// Usage:
//   const detach = attachMouseHandlers({ canvas, engine, getScrollY, requestRepaint })
//   // later:
//   detach()

import type { TextLineData, SelectionCursor } from './types.js'
import type { LayoutEngine } from './engine.js'
import { resolvePixelToCursor, segmentIndexToCursor, segmentWidthOnLine } from './selection.js'

// ─── Public interface ─────────────────────────────────────────────────────────

export interface MouseHandlerOptions {
  /** The canvas element that receives mouse events. */
  canvas: HTMLCanvasElement
  /** The LayoutEngine instance (owns SelectionState and textLineMap). */
  engine: LayoutEngine
  /**
   * Returns the current vertical scroll offset in world-space pixels.
   * Called on every mouse event to convert viewport coords to world coords.
   */
  getScrollY: () => number
  /**
   * Returns the current horizontal content offset in CSS pixels.
   *
   * If the canvas uses `ctx.translate(ox, 0)` to center content horizontally,
   * pass `() => ox` here. The value is subtracted from the raw canvas-space X
   * coordinate in toWorldCoords(), converting it to world-space X that matches
   * the BoxRecord coordinate system.
   *
   * Default: `() => 0` (no horizontal offset — content starts at canvas edge).
   */
  getContentOffsetX?: () => number
  /**
   * Called whenever the selection changes and the canvas should be repainted.
   * Typically schedules a requestAnimationFrame if one isn't already pending.
   */
  requestRepaint: () => void
  /**
   * Optional: link click handler override.
   * Return false to prevent default navigation (window.open / location.href).
   */
  onLinkClick?: (href: string, target: string) => boolean
}

/**
 * Attach all mouse interaction handlers to the canvas.
 *
 * Returns a cleanup function — call it when the canvas is unmounted to remove
 * all event listeners and release internal state.
 */
export function attachMouseHandlers(opts: MouseHandlerOptions): () => void {
  const { canvas, engine, getScrollY, requestRepaint } = opts

  // ── Drag state ─────────────────────────────────────────────────────────────

  /** True between mousedown and mouseup when a drag gesture is active. */
  let dragging = false

  /**
   * Anchor cursor set on mousedown — held fixed while the user drags.
   * The focus cursor updates on every mousemove.
   */
  let anchorCursor: SelectionCursor | null = null

  /**
   * Pixel coordinates of the mousedown event (viewport space).
   * Used to detect whether a mouseup is a click (no drift) vs end of drag.
   */
  let downX = 0
  let downY = 0

  /** True when a RAF repaint has been requested but not yet rendered. */
  let rafPending = false

  // ── Coordinate conversion ──────────────────────────────────────────────────

  /**
   * Convert a mouse event's clientX/Y to world-space canvas coordinates.
   *
   * The canvas uses ctx.setTransform(dpr, 0, 0, dpr, 0, 0) in the existing
   * paint setup (see demo/hero.html). After this transform, all drawing
   * coordinates are in CSS pixels — the same units as getBoundingClientRect().
   * So we do NOT multiply by devicePixelRatio here; the scale is already baked
   * into the transform and matches the BoxRecord coordinate system.
   *
   * scrollY is added to convert from viewport-relative to world-relative Y.
   *
   * getContentOffsetX() is subtracted from X to account for ctx.translate(ox, 0)
   * horizontal centering. BoxRecords are in world space (x=0 at content start),
   * but raw mouse events are in canvas space (x=0 at the canvas left edge).
   * Without this subtraction, localX = worldX - record.x is inflated by ox,
   * causing sub-glyph resolution to place the cursor ox pixels too far right.
   * paintSelection then draws at (originX + pixelX) and the canvas translate
   * adds ox again, doubling the offset visually.
   */
  function toWorldCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect()
    const ox = opts.getContentOffsetX?.() ?? 0
    return {
      x: e.clientX - rect.left - ox,
      y: e.clientY - rect.top + getScrollY(),
    }
  }

  // ── Sub-glyph hit resolution ───────────────────────────────────────────────

  /**
   * Resolve a canvas-space world point to a SelectionCursor.
   *
   * 1. Query the spatial R-Tree for the text node under (x, y).
   * 2. Look up its TextLineData.
   * 3. Call resolvePixelToCursor() for sub-glyph precision.
   *
   * Returns null if no text node is under the point or the index isn't ready.
   * This is an async function because queryPoint() is async during index build.
   */
  async function hitToTextCursor(worldX: number, worldY: number): Promise<SelectionCursor | null> {
    // Query with maxResults=4 to handle stacked nodes (link wrapping text, etc.)
    const hits = await engine.queryPoint(worldX, worldY, 4)

    for (const nodeId of hits) {
      const tld = engine.textLineMap.get(nodeId)
      if (!tld) continue

      const localX = worldX - tld.originX
      const localY = worldY - tld.originY
      
      const cursor = resolvePixelToCursor(nodeId, localX, localY, tld)
      
      return cursor
    }

    return null
  }

  /**
   * Resolve a world point to a link BoxRecord, if any.
   * Used on mouseup to detect clicks that didn't drift (i.e. are navigation).
   */
  async function hitToLink(worldX: number, worldY: number): Promise<{ href: string; target: string } | null> {
    const hits = await engine.queryPoint(worldX, worldY, 4)
    const recordMap = new Map(engine.getAllRecords().map(r => [r.nodeId, r]))

    for (const nodeId of hits) {
      const record = recordMap.get(nodeId)
      if (record?.nodeType === 'link' && record.href) {
        return { href: record.href, target: record.target ?? '_self' }
      }
    }
    return null
  }

  // ── Schedule repaint (coalesced) ───────────────────────────────────────────

  function scheduleRepaint() {
    if (!rafPending) {
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        requestRepaint()
      })
    }
  }

  // ── mousedown ──────────────────────────────────────────────────────────────

  async function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return  // left button only

    const { x, y } = toWorldCoords(e)
    downX = e.clientX
    downY = e.clientY

    // Extend selection on Shift+click.
    if (e.shiftKey && anchorCursor) {
      const focus = await hitToTextCursor(x, y)
      if (focus) {
        engine.selection.set({ anchor: anchorCursor, focus })
        scheduleRepaint()
      }
      return
    }

    const cursor = await hitToTextCursor(x, y)
    if (cursor) {
      anchorCursor = cursor
      dragging = true
      engine.selection.set({ anchor: cursor, focus: cursor })
      canvas.style.cursor = 'text'
      scheduleRepaint()
    } else {
      // Clicked on empty space — clear selection.
      anchorCursor = null
      engine.clearSelection()
      canvas.style.cursor = 'default'
      scheduleRepaint()
    }
  }

  // ── mousemove ──────────────────────────────────────────────────────────────

  /**
   * Mousemove handler — the hot path.
   *
   * During drag: updates the focus cursor and schedules a coalesced RAF repaint.
   *   • ONE RAF per frame maximum, regardless of how many events fire.
   *   • The cursor resolution is async (awaits R-Tree query) but the RAF is
   *     scheduled immediately to avoid jank on the first response.
   *
   * During hover: updates the cursor style (text / pointer / default) based
   * on what node is under the pointer — no selection state changes.
   */
  async function onMouseMove(e: MouseEvent) {
    const { x, y } = toWorldCoords(e)

    if (dragging && anchorCursor) {
      const focus = await hitToTextCursor(x, y)
      if (focus) {
        engine.selection.set({ anchor: anchorCursor, focus })
        scheduleRepaint()
      }
      return
    }

    // Hover: update cursor style.
    const hits = engine.spatialIndex?.queryPoint(x, y, 4) ?? []
    const records = engine.getAllRecords()
    const recordMap = new Map(records.map(r => [r.nodeId, r]))

    let cursor = 'default'
    for (const nodeId of hits) {
      const record = recordMap.get(nodeId)
      if (record?.nodeType === 'link') { cursor = 'pointer'; break }
      if (record?.nodeType === 'text' || record?.nodeType === 'heading') { cursor = 'text'; break }
    }
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor
  }

  // ── mouseup ────────────────────────────────────────────────────────────────

  async function onMouseUp(e: MouseEvent) {
    if (!dragging) return

    dragging = false

    const driftX = Math.abs(e.clientX - downX)
    const driftY = Math.abs(e.clientY - downY)
    const isClick = driftX < 4 && driftY < 4

    if (isClick) {
      // Zero-drift mouseup = click. Check for link navigation.
      const { x, y } = toWorldCoords(e)
      const link = await hitToLink(x, y)

      if (link) {
        // Clear selection on link click.
        engine.clearSelection()
        anchorCursor = null
        scheduleRepaint()

        const prevented = opts.onLinkClick?.(link.href, link.target) === false
        if (!prevented) {
          if (link.target === '_blank') {
            window.open(link.href, '_blank', 'noopener,noreferrer')
          } else {
            window.location.href = link.href
          }
        }
        return
      }
    }

    // Non-click mouseup or no link: leave selection as-is.
    // The selection's anchor is kept so Shift+click can extend it later.
    scheduleRepaint()
  }

  // ── dblclick — word expansion ──────────────────────────────────────────────

  /**
   * On double-click, expand the selection to the word under the cursor.
   *
   * Word boundaries are detected by Pretext segment `kind`:
   *   'space' | 'zero-width-break' | 'hard-break' → boundary
   *
   * This uses the globally-indexed segment kinds array (spans all lines of
   * the node) so word expansion works across line-wrapped words correctly.
   */
  async function onDblClick(e: MouseEvent) {
    e.preventDefault()

    const { x, y } = toWorldCoords(e)
    const cursor = await hitToTextCursor(x, y)
    if (!cursor) return

    const tld = engine.textLineMap.get(cursor.nodeId)
    if (!tld) return

    const { anchor, focus } = expandToWordBoundaries(cursor, tld)
    anchorCursor = anchor
    engine.selection.set({ anchor, focus })
    scheduleRepaint()
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  // tabIndex enables keyboard events on the canvas (needed for Shift+Arrow, Ctrl+A).
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0')

  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseup',   onMouseUp)
  canvas.addEventListener('dblclick',  onDblClick)

  // Keyboard shortcuts.
  canvas.addEventListener('keydown', onKeyDown)

  // ── keydown ────────────────────────────────────────────────────────────────

  function onKeyDown(e: KeyboardEvent) {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
    const mod = isMac ? e.metaKey : e.ctrlKey

    // Ctrl/Cmd+A — select all.
    if (mod && e.key === 'a') {
      e.preventDefault()
      selectAll()
      scheduleRepaint()
      return
    }

    // Ctrl/Cmd+C — copy.
    if (mod && e.key === 'c') {
      // Don't preventDefault — let the browser fire the 'copy' event naturally.
      engine.copySelectedText()
      return
    }
  }

  /**
   * Select all text nodes in document order.
   * Sets anchor to the very start of the first node, focus to the end of the last.
   */
  function selectAll() {
    const orderedIds = engine.getOrderedTextNodeIds()
    if (orderedIds.length === 0) return

    const firstId = orderedIds[0]!
    const lastId  = orderedIds[orderedIds.length - 1]!
    const firstTld = engine.textLineMap.get(firstId)
    const lastTld  = engine.textLineMap.get(lastId)
    if (!firstTld || !lastTld) return

    const anchor = segmentIndexToCursor(firstTld, 0, firstTld.lines[0]!.start.segmentIndex, firstTld.lines[0]!.start.graphemeIndex)
    const lastLi  = lastTld.lines.length - 1
    const lastLine = lastTld.lines[lastLi]!
    const focus   = segmentIndexToCursor(lastTld, lastLi, lastLine.end.segmentIndex, lastLine.end.graphemeIndex)

    anchorCursor = anchor
    engine.selection.set({ anchor, focus })
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  return function detach() {
    canvas.removeEventListener('mousedown', onMouseDown)
    canvas.removeEventListener('mousemove', onMouseMove)
    canvas.removeEventListener('mouseup',   onMouseUp)
    canvas.removeEventListener('dblclick',  onDblClick)
    canvas.removeEventListener('keydown',   onKeyDown)
    dragging = false
    anchorCursor = null
  }
}

// ─── Word boundary expansion ──────────────────────────────────────────────────

/**
 * Given a SelectionCursor, expand to the word boundaries around it.
 *
 * Walks the `prepared.kinds` array (global segment index, spanning all lines)
 * backward/forward from the cursor's segmentIndex until a boundary segment is
 * found. This correctly handles words that wrap across line breaks.
 *
 * Boundary kinds: 'space', 'zero-width-break', 'hard-break'.
 * Any other kind ('normal', 'soft-hyphen', etc.) is part of the word.
 */
function expandToWordBoundaries(
  cursor: SelectionCursor,
  tld: TextLineData,
): { anchor: SelectionCursor; focus: SelectionCursor } {
  const { prepared, lines } = tld
  const kinds = prepared.kinds
  const n = kinds.length

  // ── Walk backward to find the word start segment ─────────────────────────

  let startSi = cursor.segmentIndex
  // First check if current segment is a boundary, if so move to previous word
  const currentKind = kinds[startSi]
  if (currentKind === 'space' || currentKind === 'zero-width-break' || currentKind === 'hard-break') {
    startSi--
  }
  // Walk backward until we hit a boundary
  while (startSi > 0) {
    const k = kinds[startSi - 1]
    if (k === 'space' || k === 'zero-width-break' || k === 'hard-break') break
    startSi--
  }

  // ── Walk forward to find the word end segment ─────────────────────────────

  let endSi = cursor.segmentIndex
  while (endSi < n - 1) {
    const k = kinds[endSi + 1]
    if (k === 'space' || k === 'zero-width-break' || k === 'hard-break') break
    endSi++
  }

  // ── Convert segment indices back to SelectionCursors ──────────────────────

  // Find which lines contain startSi and endSi.
  const startLi = findLineForSegment(lines, startSi)
  const endLi   = findLineForSegment(lines, endSi)

  // Word-start grapheme: first grapheme of startSi on its line.
  const startLineStart = lines[startLi]?.start
  const startGi = (startSi === startLineStart?.segmentIndex)
    ? startLineStart.graphemeIndex
    : 0

  // Word-end grapheme: last grapheme of endSi (all graphemes in segment).
  const endPfx = prepared.breakablePrefixWidths[endSi]
  const endGi  = endPfx && endPfx.length > 0 ? endPfx.length : 1

  const anchor = segmentIndexToCursor(tld, startLi, startSi, startGi)
  const focus  = segmentIndexToCursor(tld, endLi,   endSi,   endGi)

  return { anchor, focus }
}

/**
 * Binary search: find the index of the LayoutLine that contains segment `si`.
 *
 * IMPORTANT — LayoutLine.end is an EXCLUSIVE cursor (mirrors Pretext internals):
 *   • buildLineTextFromRange loops `i < endSegmentIndex`, meaning the loop body
 *     never touches endSegmentIndex itself.
 *   • endSegmentIndex content is included ONLY when endGraphemeIndex > 0.
 *   • When endGraphemeIndex === 0, segment endSegmentIndex is the FIRST segment
 *     of the NEXT line and must NOT be counted as belonging to this line.
 *
 * Consequence for the binary search: when `si === line.end.segmentIndex` we
 * must further check line.end.graphemeIndex:
 *   - graphemeIndex > 0  → the segment is split across the line boundary;
 *                          graphemes [0, graphemeIndex) are on this line → match.
 *   - graphemeIndex === 0 → segment si starts the next line → search higher.
 *
 * Without this check, a word whose first segment begins a new line (the common
 * case: endGraphemeIndex is almost always 0 at a clean word-break) would be
 * attributed to the preceding line. segmentIndexToCursor would then walk
 * segment widths from that wrong line's start, accumulating widths across a
 * line boundary and producing wildly inflated pixelX values.
 */
function findLineForSegment(
  lines: import('./types.js').TextLineData['lines'],
  si: number,
): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const line = lines[mid]!
    if (si < line.start.segmentIndex) {
      hi = mid - 1
    } else if (si > line.end.segmentIndex) {
      lo = mid + 1
    } else if (si === line.end.segmentIndex && line.end.graphemeIndex === 0) {
      // end cursor is exclusive and graphemeIndex=0 means no content from this
      // segment lives on this line — it is the start of the next line.
      lo = mid + 1
    } else {
      // si is within [start.segmentIndex, end.segmentIndex] and, if si equals
      // end.segmentIndex, graphemeIndex > 0 so some content is on this line.
      return mid
    }
  }
  // Clamp to last line as a safe fallback.
  return Math.max(0, lines.length - 1)
}
