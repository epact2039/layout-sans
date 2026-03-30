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
      // Shrink pass
      let totalShrinkWeight = 0
      for (const item of line.items) {
        if (!isNaN(item.mainSize)) totalShrinkWeight += item.flexShrink * item.mainSize
      }
      if (totalShrinkWeight > 0) {
        for (const item of line.items) {
          if (item.flexShrink > 0 && !isNaN(item.mainSize)) {
            const shrink = (item.flexShrink * item.mainSize / totalShrinkWeight) * Math.abs(freeSpace)
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
        if (alignItems === 'stretch') {
          item.crossSize = crossContainerSize - item.marginCross
        } else {
          // Content-sized cross axis — measure via ctx
          const measured = ctx.measureNode(item.child, item.id, isRow ? item.mainSize : innerWidth, isRow ? innerHeight : item.mainSize)
          item.crossSize = isRow ? measured.height : measured.width
        }
      }
      lineCrossMax = Math.max(lineCrossMax, item.crossSize + item.marginCross)
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

      // Recurse into the child solver
      const childRecords = ctx.solveNode(item.child, item.id, x, y, w, h)
      records.push(...childRecords)

      mainOffset += (isNaN(item.mainSize) ? 0 : item.mainSize) + mainGap + spacing + (item.marginMain - marginMainStart)
    }

    crossOffset += line.crossSize + crossGap
  }

  // Container self record
  const totalCross = lines.reduce((sum, l) => sum + l.crossSize, 0) + (lines.length - 1) * crossGap + (isRow ? padding.top + padding.bottom : padding.left + padding.right)
  const computedWidth = isRow ? containerWidth : totalCross
  const computedHeight = isRow ? totalCross : containerHeight

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
  const innerW = containerWidth - padding.left - padding.right

  // Validate all children are fixed-size boxes with no flex growth
  for (const child of children) {
    if (child.type !== 'box') return null
    if ((child.flex ?? 0) > 0) return null
    if (child.margin !== undefined || child.marginTop !== undefined || child.marginBottom !== undefined) return null
    if (child.width === undefined || child.height === undefined) return null
  }

  // Fast O(n) emit
  const records: BoxRecord[] = new Array(children.length)
  let y = padding.top

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const childId = `${nodeId}.${i}`
    const id = child.id ?? childId
    const w = child.width!
    const h = child.height!
    records[i] = { nodeId: id, x: padding.left, y, width: w, height: h }
    y += h + gap
  }

  // Remove the last gap, add bottom padding — y is now total content height
  const totalHeight = children.length > 0
    ? y - gap + padding.bottom
    : padding.top + padding.bottom

  return { records, totalHeight }
}
