import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import { useData } from 'vitepress';
import Gallery from './components/Gallery.vue';
import KilnLanding from './components/KilnLanding.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout: () => {
    const { frontmatter } = useData();
    // The home page uses a bespoke minimal layout (no nav/sidebar chrome);
    // every other page uses the default theme.
    if (frontmatter.value.layout === 'landing') {
      return h(KilnLanding);
    }
    return h(DefaultTheme.Layout);
  },
  enhanceApp({ app, router }) {
    // Used in gallery.md.
    app.component('Gallery', Gallery);

    if (typeof window !== 'undefined') {
      router.onAfterRouteChanged = (to) => {
        (window as any).goatcounter?.count?.({ path: new URL(to, location.href).pathname });
      };
    }
  },
};
