// LayoutSans — measure.ts
// Integrates with @chenglou/pretext to size text nodes.
// Falls back gracefully when Pretext is not available (e.g. in pure-math scenarios).

import type { TextNode } from './types.js'

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
