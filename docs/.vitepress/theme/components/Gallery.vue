<script setup lang="ts">
import { withBase } from 'vitepress';
import { gallery } from '../gallery-data';

// Thumbnails live in docs/public/gallery/ and are referenced as relative paths
// ('gallery/x.jpeg'); withBase() prepends the deploy base so they resolve under
// /kiln-render/. Full http(s) URLs (if any) are passed through untouched.
function thumbSrc(src: string): string {
  return /^https?:\/\//.test(src) ? src : withBase(src);
}

// The thumbnail+title block is the clickable demo link. target="_blank" opens
// the demo app (a separate build under app/) in a new tab; the target also makes
// VitePress's SPA router do a real navigation instead of a route lookup (which
// would 404 on it). The source link is a separate external anchor, so it can't
// be nested inside the demo link.
</script>

<template>
  <div class="gallery-grid">
    <div v-for="item in gallery" :key="item.title" class="gallery-item">
      <a class="gallery-open" :href="item.href" target="_blank" rel="noopener">
        <div class="gallery-thumb">
          <img v-if="item.thumb" :src="thumbSrc(item.thumb)" :alt="item.alt || item.title" loading="lazy" />
          <span v-else class="gallery-placeholder">{{ item.placeholder }}</span>
        </div>
        <h3 class="gallery-title">{{ item.title }}</h3>
        <div class="gallery-meta">{{ item.meta }}</div>
      </a>
      <p v-if="item.description" class="gallery-desc">{{ item.description }}</p>
      <a
        v-if="item.source"
        class="gallery-source"
        :href="item.source.url"
        target="_blank"
        rel="noreferrer"
      >{{ item.source.label }} ↗</a>
    </div>
  </div>
</template>

<style scoped>
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 40px 32px;
  margin: 32px 0;
}
@media (max-width: 640px) {
  .gallery-grid { grid-template-columns: 1fr; }
}

.gallery-item {
  display: flex;
  flex-direction: column;
}

.gallery-open {
  display: block;
  text-decoration: none;
  color: inherit;
  font-weight: inherit;
}

.gallery-thumb {
  aspect-ratio: 16 / 10;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
  transition: border-color 0.15s;
}
.gallery-open:hover .gallery-thumb {
  border-color: var(--vp-c-brand-1);
}
.gallery-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.gallery-placeholder {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--vp-c-text-3);
  letter-spacing: 0.04em;
}

.gallery-title {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 0 0 3px;
  border: none;
  padding: 0;
  letter-spacing: -0.01em;
}
.gallery-open:hover .gallery-title {
  color: var(--vp-c-brand-1);
}
.gallery-meta {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-3);
}

.gallery-desc {
  margin: 10px 0 0;
  font-size: 0.92rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.gallery-source {
  margin-top: 8px;
  font-size: 0.82rem;
  color: var(--vp-c-text-3);
  text-decoration: none;
}
.gallery-source:hover {
  color: var(--vp-c-brand-1);
}
</style>
