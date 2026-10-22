import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL,
  trailingSlash: 'always',
  markdown: {
    shikiConfig: { theme: 'material-theme-palenight', wrap: false },
  },
});
