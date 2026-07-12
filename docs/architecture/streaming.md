# Streaming manager

The **StreamingManager** (`src/streaming/streaming-manager.ts`) implements a **resident set manager** that decides which bricks should occupy the atlas based on camera position, viewing frustum, and screen-space error (SSE) based LOD selection.

## Desired set computation

Each frame (throttled to every N frames while camera moves), the manager performs:

1. **Octree Traversal**: Starting from the coarsest LOD, recursively descend based on screen-space error
2. **Frustum Culling**: Reject bricks whose AABBs lie entirely outside the view frustum
3. **SSE-based LOD Selection**: At each node, compute screen-space error to decide whether to split

```typescript
const traverse = (bx, by, bz, lod) => {
  const aabb = getBrickAABB(bx, by, bz, lod);

  // Frustum cull
  if (!isAABBInFrustum(aabb, frustumPlanes)) return;

  // Screen-space error LOD decision
  const dist = distance(cameraPos, aabbCenter(aabb));
  const lodScale = Math.pow(2, lod);  // Voxel size multiplier
  const voxelWorldSize = lodScale * voxelSpacing;
  const projectedError = (voxelWorldSize / dist) * projectionFactor;
  const shouldSplit = lod > 0 && projectedError > sseThreshold;

  if (shouldSplit && finerLodExists(lod - 1)) {
    // Recurse to 8 children at finer LOD
    for (child of getChildren(bx, by, bz, lod)) {
      traverse(child.x, child.y, child.z, lod - 1);
    }
  } else {
    // This brick is desired
    desiredSet.add({ lod, bx, by, bz, distance: dist });
  }
};
```

**Screen-Space Error (SSE)** measures how many pixels a voxel projects to on screen. When the projected error exceeds a threshold (default: 8.0 pixels), the brick splits to a finer LOD. A hysteresis band (splitting only above the threshold, collapsing only below 0.7× it) prevents LOD oscillation during gestures. This approach adapts automatically to:
- Screen resolution (higher res = more splits for same view)
- Field of view (narrower FOV = more detail at same distance)
- Anisotropic voxel spacing (non-uniform datasets)

## Priority queue and request management

After computing the desired set, the manager:

1. **Cancels stale requests**: In-flight fetches for bricks no longer in desired set are aborted via `AbortController`
2. **Touches loaded bricks**: Updates LRU timestamps for bricks that remain desired
3. **Queues missing bricks**: Sorts by distance, closest first (prioritizes visible regions)
4. **Rate limits requests**: Caps concurrent requests (8 single-channel, 12 multichannel) to avoid network saturation. Stale requests wait a 200 ms grace period before cancellation so brief LOD oscillation doesn't thrash fetches

```
Desired Set: [A, B, C, D, E, F, G, H]  (sorted by distance)
Currently Loaded: [A, B, X, Y, Z]
In-Flight: [C]
                     │
                     ▼
Actions:
  - Touch A, B (update LRU)
  - Cancel X, Y, Z if in-flight (no longer needed)
  - Keep C in-flight (still desired)
  - Queue D, E, F, G, H (limited to max concurrent: 8 single / 12 multichannel)
```

## LRU eviction

When the atlas is full, the **AtlasAllocator** (`src/streaming/atlas-allocator.ts`) evicts the **least recently used** brick:

```typescript
allocate(frame: number): AllocationResult {
  // Try free list first
  if (freeList.length > 0) {
    return { slot: freeList.pop(), evicted: null };
  }

  // Find LRU victim
  let victim = -1, oldestFrame = Infinity;
  for (slot of usedSlots) {
    if (lastUsedFrame[slot] < oldestFrame) {
      oldestFrame = lastUsedFrame[slot];
      victim = slot;
    }
  }

  // Evict and return
  const evicted = slotMetadata[victim];
  indirectionTable.clear(evicted.bx, evicted.by, evicted.bz, evicted.lod);
  return { slot: victim, evicted };
}
```

**Pinned bricks** (the coarsest LOD) are never evicted, ensuring a complete fallback representation always exists. Slots touched within the last 30 frames are also protected, so a freshly loaded brick can't be evicted by the next allocation in the same burst (thrash guard).
