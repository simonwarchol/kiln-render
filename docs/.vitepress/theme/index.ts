import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import HeroCanvas from './components/HeroCanvas.vue';
import Gallery from './components/Gallery.vue';
import HomeSections from './components/HomeSections.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      // Live WebGPU embed as the hero image.
      'home-hero-image': () => h(HeroCanvas),
      // Meta strip under the hero actions.
      'home-hero-actions-after': () =>
        h('div', { class: 'kiln-hero-meta' }, [
          h('span', [h('b', 'Apache-2.0')]),
          h('span', ['OME-Zarr ', h('b', '& sharded binary')]),
          h('span', ['uint8 / uint16 / ', h('b', 'float32')]),
          h('span', 'v0.4.0'),
          // Third-party trust signal — a verifiable listing, not an endorsement
          // claim. "Listed in", linked to the registry so anyone can check.
          h('span', [
            h(
              'a',
              {
                class: 'kiln-registry-link',
                href: 'https://ngff.openmicroscopy.org/tools/',
                target: '_blank',
                rel: 'noreferrer',
              },
              'Listed in the OME-NGFF tools registry',
            ),
          ]),
        ]),
    });
  },
  enhanceApp({ app, router }) {
    // Used in home/gallery markdown.
    app.component('Gallery', Gallery);
    app.component('HomeSections', HomeSections);

    if (typeof window !== 'undefined') {
      router.onAfterRouteChanged = (to) => {
        (window as any).goatcounter?.count?.({ path: new URL(to, location.href).pathname });
      };
    }
  },
};
