<script setup lang="ts">
/**
 * Live KilnViewer embed for the landing hero — no UI chrome, camera
 * orbit/pan/zoom only (wired onto the canvas by the library's Camera class).
 * Ported from the old examples/site/hero-embed.ts. `kiln-render` is imported
 * dynamically inside onMounted so the module (WebGPU, browser globals) never
 * loads during VitePress SSR/SSG.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';

const canvas = ref<HTMLCanvasElement | null>(null);
// When the live renderer can't start (no WebGPU, or init error), we swap the
// canvas for a still poster + message rather than leaving a blank black box.
const failed = ref(false);
const noWebGPU = ref(false);
const poster = withBase('/gallery/chameleon.webp');
let viewer: { dispose(): void } | null = null;

onMounted(async () => {
  if (!canvas.value) return;
  // Cheap pre-check so we can show the "unsupported browser" wording without
  // waiting on the dynamic import + create() to reject.
  if (!('gpu' in navigator)) {
    noWebGPU.value = true;
    failed.value = true;
    return;
  }
  try {
    const { KilnViewer } = await import('kiln-render');
    viewer = await KilnViewer.create(
      canvas.value,
      'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit',
      {
        mode: 'dvr',
        windowCenter: 0.5,
        windowWidth: 1.0,
        tfPreset: 'coolwarm',
        tfPoints: [
          { x: 0.0, y: 0.0 },
          { x: 0.25, y: 0.0 },
          { x: 1.0, y: 1.0 },
        ],
        upAxis: '-y',
        cam: [0.07, 2.89, 1.328, -0.059, -0.008, -0.003],
        densityScale: 0.3,
        renderScale: 0.75,
      },
    );
  } catch (e) {
    console.error('[Kiln] hero embed failed to initialize:', e);
    // A rejection from create() when navigator.gpu exists is most often a
    // missing/blocklisted adapter — still a WebGPU-availability problem.
    noWebGPU.value = true;
    failed.value = true;
  }
});

onUnmounted(() => {
  viewer?.dispose();
  viewer = null;
});
</script>

<template>
  <div class="hero-canvas-wrap">
    <div class="hero-canvas-stage">
      <canvas ref="canvas" class="hero-canvas" :class="{ 'is-hidden': failed }"></canvas>
      <div v-if="failed" class="hero-canvas-fallback">
        <img :src="poster" alt="Chameleon CT volume rendered in Kiln" class="hero-canvas-poster" />
        <div class="hero-canvas-fallback-msg">
          <strong>Live preview unavailable</strong>
          <span v-if="noWebGPU">
            This browser doesn’t support WebGPU, so the interactive renderer can’t
            start. Try the latest Chrome, Edge, or Safari — see the
            <a :href="withBase('/guide/faq')">FAQ</a> for details.
          </span>
          <span v-else>
            The interactive renderer couldn’t start on this device. Everything else
            on this page works normally.
          </span>
        </div>
      </div>
    </div>
    <p class="hero-canvas-caption">
      {{ failed ? 'Still preview — Kiln rendering a 2.2\xa0GB CT volume' : 'Live — Kiln streaming a 2.2\xa0GB CT volume' }}
    </p>
  </div>
</template>

<style scoped>
.hero-canvas-wrap {
  width: 100%;
}
.hero-canvas-caption {
  margin: 10px auto 0;
  max-width: 440px;
  text-align: center;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.hero-canvas-stage {
  position: relative;
  /* Above the decorative .image-bg so the canvas receives pointer events
     across its whole surface (see custom.css). */
  z-index: 1;
  width: 100%;
  max-width: 440px;
  aspect-ratio: 1 / 1;
  margin: 0 auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-alt);
  touch-action: none;
}
.hero-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.hero-canvas.is-hidden {
  display: none;
}
.hero-canvas-fallback {
  position: absolute;
  inset: 0;
}
.hero-canvas-poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-canvas-fallback-msg {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 6px;
  padding: 16px;
  text-align: left;
  /* Legible over the poster regardless of the image's luminance. */
  background: linear-gradient(to top, rgba(0, 0, 0, 0.82) 0%, rgba(0, 0, 0, 0.4) 45%, rgba(0, 0, 0, 0) 75%);
  color: #fff;
  font-family: var(--vp-font-family-base);
  font-size: 13px;
  line-height: 1.45;
}
.hero-canvas-fallback-msg strong {
  font-size: 14px;
  font-weight: 600;
}
.hero-canvas-fallback-msg a {
  color: #fff;
  text-decoration: underline;
}
</style>
