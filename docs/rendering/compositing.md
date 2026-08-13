# Compositing modes

| Mode | Algorithm | Use Case |
|------|-----------|----------|
| **DVR** | Front-to-back alpha compositing with transfer function | General visualization |
| **MIP** | Maximum intensity along ray | Angiography, vessel detection |
| **ISO** | First surface at threshold + Phong shading | Surface extraction |
| **LOD** | Color-coded by resolution level | Debug LOD distribution |
| **Slice** | Three orthogonal planes sampling the atlas directly | Anatomical navigation |

DVR compositing uses the optical model with extinction:

```wgsl
fn composeSample(density, stepSize, color, alpha) {
    let tfColor = textureSample(transferFunction, density);
    let extinction = tfColor.a * stepSize * volumeScale;
    let sampleAlpha = 1.0 - exp(-extinction);

    // Front-to-back blending
    *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
    *alpha += sampleAlpha * (1.0 - *alpha);
}
```

## Multichannel compositing

For multichannel datasets (up to 6 channels), the rendering pipeline switches from transfer-function-based compositing to **additive per-channel blending**. Each channel is sampled from its own atlas texture, windowed independently, and coloured with a user-defined colour. The weighted contributions are summed:

```wgsl
// Per-channel: sample atlas, apply windowing, weight by channel colour
for (var ch = 0u; ch < numChannels; ch++) {
    let density = sampleAtlas(atlasTextures[ch], ...);
    let windowed = applyWindow(density, channelCenter[ch], channelWidth[ch]);
    channelColor += channelColors[ch].rgb * windowed * channelColors[ch].a;
    maxDensity = max(maxDensity, windowed);
}

// Composite the additive result into the ray
composeSampleAdditive(channelColor, maxDensity, ...);
```

The `composeSampleAdditive` function normalises the summed colour by the maximum density to avoid over-brightening, then applies front-to-back compositing (DVR) or tracks per-channel maximums (MIP).

Transfer functions are not used in multichannel mode. See [Multichannel](/rendering/multichannel) for per-mode behaviour and API details.
