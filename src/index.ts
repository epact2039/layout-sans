// LayoutSans — index.ts
// Public API surface. Import from 'layout-sans'.

export { createLayout, LayoutEngine } from './engine.js'

export type {
  // Node types
  Node,
  FlexNode,
  BoxNode,
  TextNode,
  AbsoluteNode,
  GridNode,
  MagazineNode,
  // Output
  BoxRecord,
  // Options
  LayoutOptions,
} from './types.js'
