// LayoutSans — measure.ts (v0.2)
// Integrates with @chenglou/pretext to size text nodes.
// Falls back gracefully when Pretext is not available (e.g. in pure-math scenarios).
// v0.2 adds measureTextWithLines / measureTextWithLinesSync which build a
// TextLineData object (PreparedTextWithSegments + LayoutLine[]) so the selection
// engine can do sub-glyph cursor resolution with zero measureText() calls in the
// mousemove hot path (PRD §3.3).

import type { TextNode, TextLineData } from './types.js'

// Dynamic import so the library doesn't hard-error when Pretext is absent.
let pretextModule: typeof import('@chenglou/pretext') | null = null

async function getPretextModule(): Promise<typeof import('@chenglou/pretext') | null> {
  if (pretextModule !== null) return pretextModule
  try {
    pretextModule = await import('@chenglou/pretext')
    return pretextModule
  } catch {
    return null
  }
}

/**
 * Estimate font size from a CSS font string like '16px Inter' or '1rem Arial'.
 * Used to derive a default lineHeight when none is supplied.
 */
export function estimateFontSize(font: string): number {
  // Match leading number with optional unit: '16px', '1.5rem', '24'
  const match = /(\d+(?:\.\d+)?)(px|rem|em|pt)?/.exec(font)
  if (!match) return 16
  const value = parseFloat(match[1]!)
  const unit = match[2] ?? 'px'
  if (unit === 'rem' || unit === 'em') return value * 16
  if (unit === 'pt') return value * 1.333
  return value
}

export interface MeasureTextResult {
  width: number
  height: number
}

/**
 * Measure a text node's intrinsic size using Pretext.
 * maxWidth constrains line wrapping. Returns { width, height }.
 */
export async function measureText(
  node: TextNode,
  maxWidth: number,
): Promise<MeasureTextResult> {
  const lineHeight = node.lineHeight ?? estimateFontSize(node.font ?? '16px sans-serif') * 1.4

  // Caller already has a PreparedText handle (pre-prepared by user)
  if (node.preparedText) {
    const pretext = await getPretextModule()
    if (pretext) {
      const result = pretext.layout(node.preparedText, maxWidth, lineHeight)
      return { width: maxWidth, height: result.height }
    }
    // Graceful fallback: can't measure without pretext
    return { width: maxWidth, height: lineHeight }
  }

  if (!node.font) {
    // No font, no preparedText: estimate from character count
    const charsPerLine = Math.floor(maxWidth / (estimateFontSize('16px') * 0.55))
    const lines = Math.ceil((node.content?.length ?? 0) / Math.max(charsPerLine, 1))
    return { width: maxWidth, height: Math.max(lines, 1) * lineHeight }
  }

  const pretext = await getPretextModule()
  if (!pretext) {
    // Pretext not installed — rough fallback via average char width
    const fontSize = estimateFontSize(node.font)
    const avgCharWidth = fontSize * 0.55
    const charsPerLine = Math.floor(maxWidth / avgCharWidth)
    const lines = Math.ceil((node.content?.length ?? 0) / Math.max(charsPerLine, 1))
    return { width: maxWidth, height: Math.max(lines, 1) * lineHeight }
  }

  const prepared = pretext.prepare(node.content ?? '', node.font)
  const result = pretext.layout(prepared, maxWidth, lineHeight)
  return { width: maxWidth, height: result.height }
}

/**
 * Synchronous version for environments where Pretext has already been loaded.
 * Uses the node's preparedText handle if available.
 * Fallbacks were implemented as of previous versions, no need to implement fallbacks for pretext module as this is a main dependency for v2.0 to work.
 */
export function measureTextSync(
  node: TextNode,
  maxWidth: number,
  pretext: typeof import('@chenglou/pretext') | null,
): MeasureTextResult {
  const lineHeight = node.lineHeight ?? estimateFontSize(node.font ?? '16px sans-serif') * 1.4

  if (node.preparedText && pretext) {
    const result = pretext.layout(node.preparedText, maxWidth, lineHeight)
    return { width: maxWidth, height: result.height }
  }

  if (node.font && pretext) {
    const prepared = pretext.prepare(node.content ?? '', node.font)
    const result = pretext.layout(prepared, maxWidth, lineHeight)
    return { width: maxWidth, height: result.height }
  }

  // Fallback: character-count heuristic
  const fontSize = estimateFontSize(node.font ?? '16px sans-serif')
  const avgCharWidth = fontSize * 0.55
  const charsPerLine = Math.floor(maxWidth / Math.max(avgCharWidth, 1))
  const lines = Math.ceil((node.content?.length ?? 0) / Math.max(charsPerLine, 1))
  return { width: maxWidth, height: Math.max(lines, 1) * lineHeight }
}

// ─── TextLineData measurement ─────────────────────────────────────────────────

/**
 * Result of measureTextWithLines / measureTextWithLinesSync.
 *
 * Carries both the box geometry and the fully-prepared per-line segment data
 * needed by the selection engine's sub-glyph cursor resolver (PRD §3.3).
 * The `textLineData` object is ready to store in LayoutEngine.textLineMap.
 */
export interface MeasureTextWithLinesResult {
  width: number
  height: number
  textLineData: TextLineData
}

/**
 * Synchronous variant of measureTextWithLines.
 *
 * Returns null when Pretext is unavailable — callers should fall back to
 * measureTextSync() and skip inserting a TextLineData entry for this node.
 *
 * Calls prepareWithSegments() so the returned PreparedTextWithSegments handle
 * exposes breakablePrefixWidths[]. The selection engine binary-searches those
 * arrays during mousemove without ever calling CanvasRenderingContext2D.measureText().
 *
 * Duck-type reuse: if node.preparedText is already a PreparedTextWithSegments
 * at runtime (has a `segments` array property), it is cast and reused directly,
 * avoiding a redundant measurement pass. This is always safe because
 * PreparedTextWithSegments is a strict superset of PreparedText.
 *
 * @param node      Text or heading node being measured.
 * @param maxWidth  Available width for line-wrapping, in px.
 * @param pretext   Pre-loaded Pretext module (supplied via engine.usePretext()).
 * @param nodeId    Resolved stable id for the node (node.id ?? tree-path id).
 * @param originX   Canvas-space X of the node's top-left corner (record.x).
 * @param originY   Canvas-space Y of the node's top-left corner (record.y).
 */
export function measureTextWithLinesSync(
  node: TextNode,
  maxWidth: number,
  pretext: typeof import('@chenglou/pretext') | null,
  nodeId: string,
  originX: number,
  originY: number,
): MeasureTextWithLinesResult | null {
  if (!pretext) return null

  const lineHeight = node.lineHeight ?? estimateFontSize(node.font ?? '16px sans-serif') * 1.4

  // Prefer the caller-supplied handle when it already carries segment data.
  // PreparedTextWithSegments is a structural superset of PreparedText — if the
  // `segments` array is present the cast is safe.
  let prepared: import('@chenglou/pretext').PreparedTextWithSegments | null = null

  if (node.preparedText) {
    const candidate = node.preparedText as unknown as Record<string, unknown>
    if (Array.isArray(candidate['segments'])) {
      prepared = node.preparedText as unknown as import('@chenglou/pretext').PreparedTextWithSegments
    }
  }

  if (prepared === null) {
    // Re-prepare with segment data. Pretext caches per-segment canvas measurements
    // internally by (segmentText, font), so the extra call is cheap when the
    // text/font pair has already been seen by prepare() during measureTextSync().
    const font = node.font ?? '16px sans-serif'
    const content = node.content ?? ''
    prepared = pretext.prepareWithSegments(content, font)
  }

  const linesResult = pretext.layoutWithLines(prepared, maxWidth, lineHeight)

  const textLineData: TextLineData = {
    nodeId,
    lines: linesResult.lines,
    prepared,
    lineHeight,
    font: node.font ?? '16px sans-serif',
    originX,
    originY,
  }

  return {
    width: maxWidth,
    height: linesResult.height,
    textLineData,
  }
}

/**
 * Async variant for environments where Pretext has not been pre-loaded.
 * Dynamically imports the module, then delegates to measureTextWithLinesSync.
 * Returns null when Pretext cannot be loaded.
 *
 * @param node      Text or heading node being measured.
 * @param maxWidth  Available width for line-wrapping, in px.
 * @param nodeId    Resolved stable id for the node.
 * @param originX   Canvas-space X of the node's top-left corner.
 * @param originY   Canvas-space Y of the node's top-left corner.
 */
export async function measureTextWithLines(
  node: TextNode,
  maxWidth: number,
  nodeId: string,
  originX: number,
  originY: number,
): Promise<MeasureTextWithLinesResult | null> {
  const pretext = await getPretextModule()
  if (!pretext) return null
  return measureTextWithLinesSync(node, maxWidth, pretext, nodeId, originX, originY)
}
