// LayoutSans — flex.ts
// Pure TypeScript flexbox solver. Implements the subset of CSS Flexbox needed
// for UI layout: row/column, flex-grow, flex-shrink, gap, align, justify, wrap.
//
// Algorithm (3 passes):
//   1. Measure — resolve fixed sizes, collect flex-grow totals
//   2. Distribute — divide remaining space among flex children
//   3. Position — assign x/y offsets based on alignment

import type { FlexNode, BoxRecord, Node } from './types.js'
import { resolveNodeSize, clampSize, getPaddingBox, type SolverContext } from './utils.js'

export interface FlexResult {
  records: BoxRecord[]
  /** Computed container width (useful when container is content-sized). */
  width: number
  /** Computed container height. */
  height: number
}

export function solveFlex(
  node: FlexNode,
  nodeId: string,
  containerWidth: number,
  containerHeight: number,
  ctx: SolverContext,
): FlexResult {
  const direction = node.direction ?? 'row'
  const isRow = direction === 'row'
  const wrap = node.wrap ?? false

  // ── Padding ───────────────────────────────────────────────────────────────
  const padding = getPaddingBox(node)
  const innerWidth = containerWidth - padding.left - padding.right
  const innerHeight = containerHeight - padding.top - padding.bottom

  // ── Gap ───────────────────────────────────────────────────────────────────
  const mainGap = isRow ? (node.columnGap ?? node.gap ?? 0) : (node.rowGap ?? node.gap ?? 0)
  const crossGap = isRow ? (node.rowGap ?? node.gap ?? 0) : (node.columnGap ?? node.gap ?? 0)

  const children = node.children ?? []

  // ── Pass 1: resolve fixed sizes ───────────────────────────────────────────
  interface ChildLayout {
    child: Node
    id: string
    mainSize: number   // NaN = flex-grow pending
    crossSize: number  // NaN = stretch pending
    flexGrow: number
    flexShrink: number
    flexBasis: number  // NaN = auto
    marginMain: number
    marginCross: number
  }

  const layouts: ChildLayout[] = children.map((child, i) => {
    const childId = `${nodeId}.${i}`
    const childW = resolveNodeSize(child, 'width', innerWidth)
    const childH = resolveNodeSize(child, 'height', innerHeight)

    const marginMain = isRow
      ? ((child.marginLeft ?? child.margin ?? 0) + (child.marginRight ?? child.margin ?? 0))
      : ((child.marginTop ?? child.margin ?? 0) + (child.marginBottom ?? child.margin ?? 0))

    const marginCross = isRow
      ? ((child.marginTop ?? child.margin ?? 0) + (child.marginBottom ?? child.margin ?? 0))
      : ((child.marginLeft ?? child.margin ?? 0) + (child.marginRight ?? child.margin ?? 0))

    const flexBasis = child.flexBasis ?? NaN
    const mainFixed = isRow ? childW : childH
    const crossFixed = isRow ? childH : childW

    // Main size: flexBasis > fixed dimension > NaN (grows)
    let mainSize: number
    if (!isNaN(flexBasis)) {
      mainSize = flexBasis
    } else if (!isNaN(mainFixed)) {
      mainSize = mainFixed
    } else if ((child.flex ?? 0) > 0) {
      mainSize = NaN // will be filled in pass 2
    } else {
      // Content-sized — we'll measure in ctx
      mainSize = isRow ? (childW ?? 0) : (childH ?? 0)
    }

    return {
      child,
      id: childId,
      mainSize,
      crossSize: crossFixed,
      flexGrow: child.flex ?? 0,
      flexShrink: child.flexShrink ?? 1,
      flexBasis,
      marginMain,
      marginCross,
    }
  })

  // ── Wrap: split children into lines ──────────────────────────────────────
  interface FlexLine {
    items: ChildLayout[]
    totalFixed: number
    totalFlexGrow: number
    crossSize: number
  }

  function buildLines(): FlexLine[] {
    const mainContainerSize = isRow ? innerWidth : innerHeight
    const lines: FlexLine[] = []
    let currentLine: ChildLayout[] = []
    let currentFixed = 0
    let currentGaps = 0
    let flexTotal = 0

    for (let i = 0; i < layouts.length; i++) {
      const item = layouts[i]!
      const itemMain = isNaN(item.mainSize) ? 0 : item.mainSize
      const gapAdd = currentLine.length > 0 ? mainGap : 0

      if (wrap && currentLine.length > 0 && currentFixed + gapAdd + itemMain + item.marginMain > mainContainerSize) {
        lines.push({ items: currentLine, totalFixed: currentFixed, totalFlexGrow: flexTotal, crossSize: 0 })
        currentLine = []
        currentFixed = 0
        currentGaps = 0
        flexTotal = 0
      }

      currentLine.push(item)
      currentFixed += itemMain + item.marginMain + (currentLine.length > 1 ? mainGap : 0)
      flexTotal += item.flexGrow
    }

    if (currentLine.length > 0) {
      lines.push({ items: currentLine, totalFixed: currentFixed, totalFlexGrow: flexTotal, crossSize: 0 })
    }

    return lines
  }

  const lines = buildLines()

  // ── Pass 2: distribute flex space within each line ────────────────────────
  const mainContainerSize = isRow ? innerWidth : innerHeight

  for (const line of lines) {
    const gapTotal = (line.items.length - 1) * mainGap
    let fixedTotal = 0
    for (const item of line.items) {
      fixedTotal += isNaN(item.mainSize) ? 0 : (item.mainSize + item.marginMain)
    }
    const freeSpace = mainContainerSize - fixedTotal - gapTotal
    const totalGrow = line.totalFlexGrow

    if (totalGrow > 0 && freeSpace > 0) {
      for (const item of line.items) {
        if (item.flexGrow > 0) {
          item.mainSize = (item.flexGrow / totalGrow) * freeSpace
          item.mainSize = clampSize(item.mainSize, isRow ? item.child.minWidth : item.child.minHeight, isRow ? item.child.maxWidth : item.child.maxHeight)
        }
      }
    } else if (totalGrow === 0 && freeSpace < 0) {
      // Shrink pass — Algo #6 fix: use flexBasis (not mainSize) per CSS spec
      let totalShrinkWeight = 0
      for (const item of line.items) {
        if (!isNaN(item.mainSize)) {
          const basis = isNaN(item.flexBasis) ? item.mainSize : item.flexBasis
          totalShrinkWeight += item.flexShrink * basis
        }
      }
      if (totalShrinkWeight > 0) {
        for (const item of line.items) {
          if (item.flexShrink > 0 && !isNaN(item.mainSize)) {
            const basis = isNaN(item.flexBasis) ? item.mainSize : item.flexBasis
            const shrink = (item.flexShrink * basis / totalShrinkWeight) * Math.abs(freeSpace)
            item.mainSize = Math.max(0, item.mainSize - shrink)
          }
        }
      }
    }

    // Resolve cross sizes — stretch to fill or use fixed
    const crossContainerSize = isRow ? innerHeight : innerWidth
    let lineCrossMax = 0
    const alignItems = node.alignItems ?? 'stretch'

    for (const item of line.items) {
      if (isNaN(item.crossSize)) {
        if (alignItems === 'stretch' && isFinite(crossContainerSize)) {
          // Stretch only when the container cross size is known and finite.
          // When containerHeight is NaN (content-sized row inside a column),
          // stretch would propagate NaN — fall through to measurement instead.
          item.crossSize = crossContainerSize - item.marginCross
        } else {
          // Content-sized cross axis, or container size unknown — measure via ctx.
          const mw = isRow ? (isFinite(item.mainSize) ? item.mainSize : innerWidth) : innerWidth
          const mh = isRow ? (isFinite(innerHeight) ? innerHeight : 0) : (isFinite(item.mainSize) ? item.mainSize : 0)
          const measured = ctx.measureNode(item.child, item.id, mw, mh)
          item.crossSize = isRow ? measured.height : measured.width
        }
      }
      // Guard NaN from bubbling into lineCrossMax.
      const safeCross = isFinite(item.crossSize) ? item.crossSize : 0
      lineCrossMax = Math.max(lineCrossMax, safeCross + item.marginCross)
    }
    line.crossSize = lineCrossMax
  }

  // ── Pass 3: position children ─────────────────────────────────────────────
  const records: BoxRecord[] = []

  // Justify-content: compute initial main offset and per-item spacing
  function computeJustify(line: FlexLine): { start: number; spacing: number } {
    const gapTotal = (line.items.length - 1) * mainGap
    let usedMain = gapTotal
    for (const item of line.items) {
      usedMain += (isNaN(item.mainSize) ? 0 : item.mainSize) + item.marginMain
    }
    const free = mainContainerSize - usedMain
    const justify = node.justifyContent ?? 'flex-start'
    const n = line.items.length

    switch (justify) {
      case 'center':       return { start: free / 2, spacing: 0 }
      case 'flex-end':     return { start: free, spacing: 0 }
      case 'space-between': return { start: 0, spacing: n > 1 ? free / (n - 1) : 0 }
      case 'space-around':  return { start: free / (2 * n), spacing: free / n }
      case 'space-evenly':  return { start: free / (n + 1), spacing: free / (n + 1) }
      default:             return { start: 0, spacing: 0 }  // flex-start
    }
  }

  // Cross-axis start for align-items
  function computeAlignCross(item: ChildLayout, lineCrossSize: number): number {
    const alignSelf = (item.child as FlexNode).alignSelf
    const align = alignSelf && alignSelf !== 'auto' ? alignSelf : (node.alignItems ?? 'stretch')
    const free = lineCrossSize - item.crossSize - item.marginCross
    switch (align) {
      case 'center':    return free / 2
      case 'flex-end':  return free
      default:          return 0  // flex-start / stretch
    }
  }

  let crossOffset = isRow ? padding.top : padding.left

  // Track the furthest main-axis edge reached across all items and lines.
  // Used to compute the actual column container height when no explicit height
  // was provided (containerHeight=0 or NaN for content-sized column containers).
  let maxMainReach = isRow ? padding.left : padding.top

  for (const line of lines) {
    const { start, spacing } = computeJustify(line)
    let mainOffset = (isRow ? padding.left : padding.top) + start

    for (const item of line.items) {
      const marginMainStart = isRow ? (item.child.marginLeft ?? item.child.margin ?? 0) : (item.child.marginTop ?? item.child.margin ?? 0)
      const marginCrossStart = isRow ? (item.child.marginTop ?? item.child.margin ?? 0) : (item.child.marginLeft ?? item.child.margin ?? 0)

      mainOffset += marginMainStart

      const crossPos = crossOffset + marginCrossStart + computeAlignCross(item, line.crossSize)

      const x = isRow ? mainOffset : crossPos
      const y = isRow ? crossPos : mainOffset
      const w = isRow ? item.mainSize : item.crossSize
      const h = isRow ? item.crossSize : item.mainSize

      // Recurse into the child solver — use loop not spread (Bug #2: spread crashes at ~65k args)
      const childRecords = ctx.solveNode(item.child, item.id, x, y, w, h)
      for (let ci = 0; ci < childRecords.length; ci++) records.push(childRecords[ci]!)

      // Use the actual rendered main-axis size from the child's container record
      // instead of item.mainSize, because content-sized children (text, heading,
      // nested flex without explicit height) have mainSize=NaN but a real rendered
      // size returned in childRecords[0].
      const renderedMain = childRecords.length > 0
        ? (isRow ? childRecords[0]!.width : childRecords[0]!.height)
        : null
      const safeMain = (renderedMain !== null && isFinite(renderedMain))
        ? renderedMain
        : (isFinite(item.mainSize) ? item.mainSize : 0)

      maxMainReach = Math.max(maxMainReach, mainOffset + safeMain)
      mainOffset += safeMain + mainGap + spacing + (item.marginMain - marginMainStart)
    }

    crossOffset += (isFinite(line.crossSize) ? line.crossSize : 0) + crossGap
  }

  // Container self record
  const totalCross = lines.reduce((sum, l) => sum + (isFinite(l.crossSize) ? l.crossSize : 0), 0)
    + (lines.length - 1) * crossGap
    + (isRow ? padding.top + padding.bottom : padding.left + padding.right)
  const computedWidth = isRow ? containerWidth : totalCross
  // For columns: derive height from the actual content extent tracked above.
  // This handles the common case where the root column flex has no explicit height
  // (containerHeight=0) — the computed height is the sum of all rendered children.
  // For rows: height = totalCross (max child height + vertical padding).
  const columnHeight = isFinite(maxMainReach) ? maxMainReach + padding.bottom : containerHeight
  const computedHeight = isRow ? totalCross : columnHeight

  return { records, width: computedWidth, height: computedHeight }
}

// ── Fast path: fixed-size column of box nodes (virtual list hot case) ─────────
// Detects when all children are plain 'box' nodes with explicit width+height,
// no flex-grow, no margins, and no wrapping — skips the full 3-pass algorithm
// and emits records in a single O(n) loop with zero intermediate objects.
export function solveFlexColumn(
  node: FlexNode,
  nodeId: string,
  containerWidth: number,
  ctx: SolverContext,
): { records: BoxRecord[]; totalHeight: number } | null {
  if ((node.direction ?? 'row') !== 'column') return null
  if (node.wrap) return null
  if (node.justifyContent && node.justifyContent !== 'flex-start') return null

  const children = node.children ?? []
  const gap = node.gap ?? node.rowGap ?? 0
  const padding = getPaddingBox(node)

  for (const child of children) {
    if (child.type !== 'box') return null
    if ((child.flex ?? 0) > 0) return null
    if (child.margin !== undefined || child.marginTop !== undefined || child.marginBottom !== undefined) return null
    if (child.width === undefined || child.height === undefined) return null
  }

  const records: BoxRecord[] = new Array(children.length)
  let y = padding.top

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const id = child.id ?? `${nodeId}.${i}`
    records[i] = { nodeId: id, x: padding.left, y, width: child.width!, height: child.height!, nodeType: 'box' }
    y += child.height! + gap
  }

  const totalHeight = children.length > 0
    ? y - gap + padding.bottom
    : padding.top + padding.bottom

  return { records, totalHeight }
}

// ── Fast path: fixed-size row of box nodes (Perf #4 — symmetric to column) ────
// Handles nav bars, toolbars, card rows — the most common horizontal pattern.
export function solveFlexRow(
  node: FlexNode,
  nodeId: string,
  containerHeight: number,
  ctx: SolverContext,
): { records: BoxRecord[]; totalWidth: number } | null {
  if ((node.direction ?? 'row') !== 'row') return null
  if (node.wrap) return null
  if (node.justifyContent && node.justifyContent !== 'flex-start') return null

  const children = node.children ?? []
  const gap = node.gap ?? node.columnGap ?? 0
  const padding = getPaddingBox(node)

  for (const child of children) {
    if (child.type !== 'box') return null
    if ((child.flex ?? 0) > 0) return null
    if (child.margin !== undefined || child.marginLeft !== undefined || child.marginRight !== undefined) return null
    if (child.width === undefined || child.height === undefined) return null
  }

  const records: BoxRecord[] = new Array(children.length)
  let x = padding.left

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const id = child.id ?? `${nodeId}.${i}`
    records[i] = { nodeId: id, x, y: padding.top, width: child.width!, height: child.height!, nodeType: 'box' }
    x += child.width! + gap
  }

  const totalWidth = children.length > 0
    ? x - gap + padding.right
    : padding.left + padding.right

  return { records, totalWidth }
}

// ── Lightweight size measurement — no record allocation (Perf #3) ─────────────
// Called by engine.ts measureNode when a flex container is a cross-axis child.
// Runs passes 1 + 2 only (measure + distribute), skips the positioning pass,
// avoiding O(n²) re-layout when containers are nested inside aligned flex rows.
export function measureFlexSize(
  node: FlexNode,
  containerWidth: number,
  containerHeight: number,
  ctx: SolverContext,
): { width: number; height: number } {
  const direction = node.direction ?? 'row'
  const isRow = direction === 'row'
  const padding = getPaddingBox(node)
  const innerWidth = containerWidth - padding.left - padding.right
  const innerHeight = containerHeight - padding.top - padding.bottom
  const mainGap = isRow ? (node.columnGap ?? node.gap ?? 0) : (node.rowGap ?? node.gap ?? 0)
  const crossGap = isRow ? (node.rowGap ?? node.gap ?? 0) : (node.columnGap ?? node.gap ?? 0)
  const children = node.children ?? []
  const mainContainerSize = isRow ? innerWidth : innerHeight

  let totalMainSize = 0   // accumulated main-axis content size across all lines
  let totalCrossSize = 0  // accumulated cross-axis size across all lines
  let lineCount = 0
  let lineFlex = 0
  let lineMain = 0
  let lineCross = 0
  let lineItemCount = 0

  function closeLine(): void {
    const gapTotal = (lineItemCount - 1) * mainGap
    const freeSpace = mainContainerSize - lineMain - gapTotal
    // flex-grow items consume the remaining free space on the main axis
    if (lineFlex > 0 && freeSpace > 0) lineMain = mainContainerSize - gapTotal
    totalMainSize += lineMain + gapTotal
    totalCrossSize += lineCross
    lineCount++
    lineFlex = 0; lineMain = 0; lineCross = 0; lineItemCount = 0
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const measureId = `measure.${i}`
    const flex = child.flex ?? 0
    const mainFixed = isRow ? (child.width ?? NaN) : (child.height ?? NaN)
    const crossFixed = isRow ? (child.height ?? NaN) : (child.width ?? NaN)
    const mainSize = flex > 0 ? NaN : (!isNaN(mainFixed) ? mainFixed : 0)
    const crossSize = isNaN(crossFixed)
      ? ctx.measureNode(
          child,
          measureId,
          isRow ? (isNaN(mainSize) ? innerWidth : mainSize) : innerWidth,
          isRow ? innerHeight : (isNaN(mainSize) ? innerHeight : mainSize),
        )[isRow ? 'height' : 'width']
      : crossFixed

    if (node.wrap && lineItemCount > 0 && lineMain + (isNaN(mainSize) ? 0 : mainSize) > mainContainerSize) {
      closeLine()
    }

    lineMain += isNaN(mainSize) ? 0 : mainSize
    lineCross = Math.max(lineCross, crossSize)
    lineFlex += flex
    lineItemCount++
  }

  if (lineItemCount > 0) closeLine()

  // cross axis: sum of all line cross-sizes + cross gaps + cross padding
  const crossPad = isRow ? padding.top + padding.bottom : padding.left + padding.right
  const crossTotal = totalCrossSize + (lineCount - 1) * crossGap + crossPad

  // main axis: for content-sized containers use computed total; for fixed use node.width/height
  const mainPad = isRow ? padding.left + padding.right : padding.top + padding.bottom
  const computedMain = totalMainSize + mainPad

  return {
    // row  → width is fixed at containerWidth; height grows from children (cross)
    // col  → width grows from children (cross); height is computed from main axis
    width:  isRow ? (node.width ?? containerWidth) : crossTotal,
    height: isRow ? crossTotal : (node.height ?? computedMain),
  }
}
