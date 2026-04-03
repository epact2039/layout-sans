// LayoutSans — types.ts
// Every public type lives here. Solvers import from this file; nothing else does cross-imports.

import type { PreparedText, PreparedTextWithSegments, LayoutLine } from '@chenglou/pretext'

// ─── Output ──────────────────────────────────────────────────────────────────

/**
 * Final output record for a single node. Flat array of these from engine.compute().
 *
 * v0.2: Extended with nodeType, textContent, href/target/rel for the spatial
 * hit-test engine and interaction layer. These are always present — consumers
 * should gate on nodeType before reading the optional fields.
 */
export interface BoxRecord {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
  /** Discriminator — mirrors the originating Node's `type` field. */
  nodeType: Node['type']
  /**
   * Plain-text string for this node.
   * Populated for 'text' and 'heading' nodes; undefined for all others.
   */
  textContent?: string
  /** Link destination. Populated for 'link' nodes; undefined for all others. */
  href?: string
  /** Link target (`_blank`, `_self`, …). Populated for 'link' nodes. */
  target?: string
  /**
   * Link relation attribute, e.g. `'noopener noreferrer'`.
   * Populated for 'link' nodes; auto-defaulted to `'noopener noreferrer'` when
   * target is `'_blank'` if not explicitly provided.
   */
  rel?: string
}

// ─── TextLineData — stored alongside BoxRecord for TextNodes ─────────────────

/**
 * Sub-glyph layout data retained after compute() for use by the selection
 * engine's character-offset resolution procedure (PRD §3.3).
 *
 * Lives in `LayoutEngine.textLineMap: Map<string, TextLineData>` — one entry
 * per text/heading node. The `prepared` handle keeps the Pretext segment data
 * alive (breakableWidths, breakablePrefixWidths) so the hit-test hot path
 * never calls measureText().
 */
export interface TextLineData {
  nodeId: string
  /** Materialized lines from `layoutWithLines()`. Indexed by visual line number. */
  lines: LayoutLine[]
  /**
   * The Pretext segment handle (result of `prepareWithSegments()`).
   * Exposes `widths`, `breakableWidths`, `breakablePrefixWidths`, `segments`.
   * Kept alive here — do not let it be GC'd.
   */
  prepared: PreparedTextWithSegments
  /** Line height in px used during layout (matches the canvas paint value). */
  lineHeight: number
  /** Cached record.x — avoids a Map lookup in the mousemove hot path. */
  originX: number
  /** Cached record.y — avoids a Map lookup in the mousemove hot path. */
  originY: number
}

export interface SelectionCursor {
  nodeId: string
  lineIndex: number
  segmentIndex: number
  graphemeIndex: number
  pixelX: number
}

export interface SelectionRange {
  anchor: SelectionCursor
  focus: SelectionCursor
}

// ─── Shared base ─────────────────────────────────────────────────────────────

interface BaseNode {
  /** Optional stable id. Auto-assigned as tree path ('0', '0.1', '0.1.2') if omitted. */
  id?: string
  /** Fixed width in px. Required for root. Optional for children (can be flex-grown). */
  width?: number
  /** Fixed height in px. Required for root unless content-sized. Optional for children. */
  height?: number
  /** Minimum width constraint in px. */
  minWidth?: number
  /** Maximum width constraint in px. */
  maxWidth?: number
  /** Minimum height constraint in px. */
  minHeight?: number
  /** Maximum height constraint in px. */
  maxHeight?: number
  /** Uniform padding inside this box, in px. */
  padding?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  /** Outer margin, in px. */
  margin?: number
  marginTop?: number
  marginRight?: number
  marginBottom?: number
  marginLeft?: number
  /** Flex child: proportion of remaining space to grow into. */
  flex?: number
  /** Flex child: weight of space to give up when container overflows. Default 1. */
  flexShrink?: number
  /** Flex child: base size before grow/shrink is applied. */
  flexBasis?: number
}

// ─── Node variants ───────────────────────────────────────────────────────────

/** A flex container. Children are laid out in a row or column. */
export interface FlexNode extends BaseNode {
  type: 'flex'
  /** Main axis direction. Default: 'row'. */
  direction?: 'row' | 'column'
  /** Gap between children in px. */
  gap?: number
  /** Row gap (overrides gap for cross-axis direction). */
  rowGap?: number
  /** Column gap (overrides gap for main-axis direction). */
  columnGap?: number
  /** How children are distributed along the main axis. */
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly'
  /** How children are aligned along the cross axis. */
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  /** Self-alignment override (applied on the child, not parent). */
  alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'auto'
  /** Whether children wrap onto new lines. */
  wrap?: boolean
  children?: Node[]
}

/** A plain box with no children. Size comes from width/height or flex growth. */
export interface BoxNode extends BaseNode {
  type: 'box'
}

/** A text node measured via Pretext. */
export interface TextNode extends BaseNode {
  type: 'text'
  /** The string to measure and lay out. */
  content: string
  /**
   * A PreparedText handle from `@chenglou/pretext` (result of prepare()).
   * Provide this OR content+font — if both are given, preparedText wins.
   */
  preparedText?: PreparedText
  /** Font string as passed to Pretext's prepare(), e.g. '16px Inter'. */
  font?: string
  /** Line height in px. Default: fontSize * 1.4 (estimated from font string). */
  lineHeight?: number
}

/** An absolutely positioned box. Coordinates relative to nearest non-static ancestor. */
export interface AbsoluteNode extends BaseNode {
  type: 'absolute'
  top?: number
  right?: number
  bottom?: number
  left?: number
  children?: Node[]
}

/** A basic grid container (1D: rows OR columns for MVP). */
export interface GridNode extends BaseNode {
  type: 'grid'
  /** Number of equal-width columns. */
  columns?: number
  /** Number of equal-height rows. */
  rows?: number
  /** Gap between cells. */
  gap?: number
  rowGap?: number
  columnGap?: number
  children?: Node[]
}

/** A magazine-style multi-column text flow container. */
export interface MagazineNode extends BaseNode {
  type: 'magazine'
  /** Number of columns to flow text across. */
  columnCount: number
  /** Gap between columns in px. Default 16. */
  columnGap?: number
  /** Content to flow. Can be plain text or TextNodes. */
  children?: TextNode[]
  /** Convenience: single string content (creates one implicit TextNode). */
  content?: string
  /** Font for text measurement. */
  font?: string
  /** Line height in px. */
  lineHeight?: number
}

/**
 * A hyperlink wrapper node.
 *
 * Rendered as a box in the layout tree. The canvas interaction layer intercepts
 * clicks and calls `window.open(href, target)` or `window.location.assign(href)`.
 * The Shadow Semantic Tree renders this as an `<a>` element for keyboard
 * navigation and screen reader access.
 *
 * When `target` is `'_blank'` and `rel` is not provided, the engine automatically
 * sets `rel = 'noopener noreferrer'` on the emitted BoxRecord.
 */
export interface LinkNode extends BaseNode {
  type: 'link'
  /** Destination URL. */
  href: string
  /** Browsing context. Defaults to `'_self'` (same tab). */
  target?: '_blank' | '_self' | '_parent' | '_top'
  /**
   * Link relation. Pass `'noopener noreferrer'` when opening in a new tab.
   * Auto-defaulted if omitted and target is `'_blank'`.
   */
  rel?: string
  /** ARIA label override for screen readers (e.g. "View project on GitHub"). */
  aria?: { label?: string }
  /** Child nodes laid out inside this link's bounding box. */
  children?: Node[]
}

/**
 * A heading node rendered directly as text (h1–h6 semantic level).
 *
 * Measured via Pretext like TextNode. The level is surfaced in the Shadow
 * Semantic Tree as the correct `<h1>`–`<h6>` element and used by the
 * selection engine to annotate copied text.
 */
export interface HeadingNode extends BaseNode {
  type: 'heading'
  /** Semantic heading level — maps to `<h1>`–`<h6>` in the Shadow Semantic Tree. */
  level: 1 | 2 | 3 | 4 | 5 | 6
  /** The heading text. */
  content: string
  /** Font string as passed to Pretext's prepare(), e.g. '32px Inter Bold'. */
  font?: string
  /** Line height in px. Default: fontSize * 1.2. */
  lineHeight?: number
}

export type Node =
  | FlexNode
  | BoxNode
  | TextNode
  | AbsoluteNode
  | GridNode
  | MagazineNode
  | LinkNode
  | HeadingNode

// ─── Internal resolved node (after measurement pass) ─────────────────────────

export interface ResolvedNode {
  id: string
  node: Node
  resolvedWidth: number   // NaN = not yet known
  resolvedHeight: number  // NaN = not yet known
  children: ResolvedNode[]
  // absolute offset from parent origin (set in position pass)
  x: number
  y: number
}

// ─── Engine options ───────────────────────────────────────────────────────────

export interface LayoutOptions {
  /** Root width in px. Overrides node.width if provided. */
  width?: number
  /** Root height in px. Overrides node.height if provided. */
  height?: number
}
