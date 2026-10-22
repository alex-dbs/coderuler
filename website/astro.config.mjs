import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import { markdownBaseUrls } from './src/lib/paths.ts';

const base = '/rulekeeper';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://alex-dbs.github.io',
  base,
  trailingSlash: 'always',
  markdown: {
    processor: satteri({ hastPlugins: [markdownBaseUrls(base)] }),
    shikiConfig: { theme: 'material-theme-palenight', wrap: false },
  },
});
