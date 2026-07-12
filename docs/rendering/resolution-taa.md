# Resolution scaling & TAA

## Resolution scaling

The compute shader can render at a reduced resolution to decrease the number of rays cast per frame. A configurable `renderScale` factor (0.25-1.0, default 0.5) multiplies the canvas dimensions to produce a smaller compute output texture. The blit pass then upscales this to the full canvas using bilinear filtering.

```
Canvas: 1920 × 1080
renderScale: 0.5
Compute texture: 960 × 540  (75% fewer pixels)
Blit: bilinear upscale back to 1920 × 1080
```

The depth texture remains at full resolution for geometry overlays (wireframe, axis). The scaled dimensions are passed into the shader as `screenSize` so that ray generation and thread dispatch use the correct coordinate space.

## Temporal jitter and accumulation

Raymarching with fixed step offsets produces banding artifacts where iso-surfaces align with sample planes. Kiln addresses this in two stages:

**Stochastic jitter**: Each ray's starting offset is randomized per frame using the frame index as part of the seed:

```wgsl
let jitter = rand(rayToSeed(rayDir) + brickIter + uniforms.frameIndex);
t += jitter * stepSize;
```

This converts structured banding into high-frequency noise that varies every frame.

**Temporal accumulation**: A compute pass blends the current frame with a history buffer using an exponential moving average (EMA). Two ping-pong textures alternate as read and write targets to avoid read-write hazards:

```wgsl
let weight = 1.0 / (frameCount + 1);  // Progressive average
let blended = mix(history, current, weight);
```

On frame 0, `weight = 1.0` shows the raw noisy frame. By frame 10, each pixel averages 11 samples, substantially reducing noise. Accumulation caps at 64 frames to avoid diminishing returns.

The accumulation resets automatically when:
- The camera moves (detected by comparing the view-projection matrix between frames)
- Rendering parameters change (render mode, transfer function, window/level, ISO threshold)

This gives immediate visual feedback during interaction, with progressive refinement when the view is still.
