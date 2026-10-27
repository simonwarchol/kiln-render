/**
 * Atlas Allocator - manages free/used brick slots in the atlas texture.
 * Uses LRU eviction when full, tracking brick metadata for indirection cleanup.
 */

import { GRID_SIZE } from "../core/config.js";

// Slots touched within this many frames are protected from eviction.
// Prevents thrash when atlas is under pressure — a freshly loaded brick
// can't be immediately evicted by the next allocation in the same burst.
const MIN_EVICTION_AGE = 30;

export interface AtlasSlot {
  x: number;
  y: number;
  z: number;
}

export interface BrickMetadata {
  lod: number;
  bx: number;
  by: number;
  bz: number;
  key: string; // For quick lookup in loadedBricks map
}

export interface AllocationResult {
  slot: AtlasSlot;
  slotIndex: number;
  evicted: BrickMetadata | null;
}

export class AtlasAllocator {
  /** Slots that are never evicted (the base LOD), 1 = pinned */
  private readonly pinned: Uint8Array;

  /** Unallocated slots; allocation pops from the end */
  private freeList: number[] = [];

  /** LRU tracking: frame number when each slot was last used */
  private readonly lastUsedFrame: Uint32Array;

  /** Brick held by each slot (for eviction / indirection cleanup) */
  private readonly slotMetadata: (BrickMetadata | null)[];

  // Atlas grid dimension (slots per axis); may be smaller than the default
  // GRID_SIZE when the atlas was shrunk to fit a VRAM budget.
  private readonly gridSize: number;

  // Total slots available (gridSize³)
  readonly totalSlots: number;

  constructor(gridSize: number = GRID_SIZE) {
    this.gridSize = gridSize;
    this.totalSlots = gridSize * gridSize * gridSize;
    this.pinned = new Uint8Array(this.totalSlots);
    this.lastUsedFrame = new Uint32Array(this.totalSlots);
    this.slotMetadata = new Array(this.totalSlots).fill(null);
    this.reset();
  }

  /**
   * Touch a slot to mark it as recently used
   * Call this for every brick in the current desired set
   */
  touch(slotIndex: number, frame: number): void {
    this.lastUsedFrame[slotIndex] = frame;
  }

  /**
   * Set metadata for a slot (call after loading a brick)
   */
  setMetadata(slotIndex: number, meta: BrickMetadata): void {
    this.slotMetadata[slotIndex] = meta;
  }

  /**
   * Pin a slot so it will never be evicted
   */
  pin(slotIndex: number): void {
    this.pinned[slotIndex] = 1;
  }

  // cheap pre-dispatch check for the streaming manager's backpressure.
  // `keepKeys` is the current desired set: bricks not in it can be evicted
  // immediately even if they were touched this frame.
  hasEvictableSlot(
    currentFrame: number,
    keepKeys?: ReadonlySet<string>,
  ): boolean {
    if (this.freeList.length > 0) return true;
    return this.findLRUSlot(currentFrame, keepKeys) !== -1;
  }

  /** Allocate a slot, evicting the LRU slot if the atlas is full. */
  allocate(
    frame: number = 0,
    keepKeys?: ReadonlySet<string>,
  ): AllocationResult | null {
    // Try free list first
    const free = this.freeList.pop();
    if (free !== undefined) {
      this.lastUsedFrame[free] = frame;
      return { slot: this.indexToSlot(free), slotIndex: free, evicted: null };
    }

    // Atlas is full - find LRU slot to evict
    const victim = this.findLRUSlot(frame, keepKeys);
    if (victim === -1) {
      // nothing evictable right now (all pinned or recently touched)
      // bricks stay desired and retry
      return null;
    }

    const evicted = this.slotMetadata[victim] ?? null;

    // Update tracking for the reused slot
    this.lastUsedFrame[victim] = frame;
    this.slotMetadata[victim] = null;

    return {
      slot: this.indexToSlot(victim),
      slotIndex: victim,
      evicted,
    };
  }

  /**
   * Find an eviction victim (the atlas is full: every slot is allocated).
   * Bricks still in `keepKeys` are protected for MIN_EVICTION_AGE frames;
   * bricks that left the desired set are eligible immediately so closer
   * missing bricks can load.
   */
  private findLRUSlot(
    currentFrame: number,
    keepKeys?: ReadonlySet<string>,
  ): number {
    let droppedOldest = Infinity;
    let droppedIdx = -1;
    let keptOldest = Infinity;
    let keptIdx = -1;

    for (let i = 0; i < this.totalSlots; i++) {
      if (this.pinned[i]) continue;

      const frameNum = this.lastUsedFrame[i] ?? 0;
      const kept = keepKeys
        ? keepKeys.has(this.slotMetadata[i]?.key ?? "")
        : true;

      if (!kept) {
        if (frameNum < droppedOldest) {
          droppedOldest = frameNum;
          droppedIdx = i;
        }
        continue;
      }

      if (currentFrame - frameNum < MIN_EVICTION_AGE) continue;
      if (frameNum < keptOldest) {
        keptOldest = frameNum;
        keptIdx = i;
      }
    }

    return droppedIdx !== -1 ? droppedIdx : keptIdx;
  }

  /**
   * Get number of free slots remaining
   */
  get freeCount(): number {
    return this.freeList.length;
  }

  /**
   * Get number of used slots
   */
  get usedCount(): number {
    return this.totalSlots - this.freeList.length;
  }

  /**
   * Reset allocator (free all slots)
   */
  reset(): void {
    this.pinned.fill(0);
    this.lastUsedFrame.fill(0);
    this.slotMetadata.fill(null);
    this.freeList = [];
    for (let i = this.totalSlots - 1; i >= 0; i--) {
      this.freeList.push(i);
    }
  }

  /** Flat slot index → atlas grid coordinates */
  private indexToSlot(idx: number): AtlasSlot {
    const x = idx % this.gridSize;
    const y = Math.floor(idx / this.gridSize) % this.gridSize;
    const z = Math.floor(idx / (this.gridSize * this.gridSize));
    return { x, y, z };
  }
}
