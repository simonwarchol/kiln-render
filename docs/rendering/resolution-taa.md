# Resolution & TAA

## Resolution

A settled view renders at full canvas resolution. While the camera moves (and for a short moment after), or while bricks are still streaming in, the viewer switches to **draft frames**: the compute shader renders at half resolution with a 2× ray step, and accumulation stops after 4 frames. A zoomed-in multichannel frame can cost hundreds of milliseconds of GPU time at full quality, and streaming keeps restarting accumulation anyway; once the view settles, rendering returns to full resolution.

The blit pass scales the compute output to the canvas (linear filtering). The depth texture stays at canvas size for geometry overlays (wireframe, axis). The render size is passed into the shader as `screenSize` so ray generation and thread dispatch use the correct coordinate space.

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

On frame 0, `weight = 1.0` shows the raw noisy frame. By frame 10, each pixel averages 11 samples, substantially reducing noise. A settled image accumulates 16 frames (draft frames 4); beyond that the returns diminish.

The accumulation resets automatically when:
- The camera moves (detected by comparing the view-projection matrix between frames)
- Rendering parameters change (render mode, transfer function, window/level, ISO threshold)

This gives immediate visual feedback during interaction, with progressive refinement when the view is still.
