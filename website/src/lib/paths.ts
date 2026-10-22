import type { HastPluginDefinition } from 'satteri';

export function withBase(path: string, base: string) {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  const prefix = base.replace(/\/$/, '');
  if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}#`)) return path;
  return `${prefix}${path}`;
}

export const sitePath = (path: string) => withBase(path, import.meta.env.BASE_URL);

export function markdownBaseUrls(base: string): HastPluginDefinition {
  return {
    name: 'base-urls',
    element: {
      filter: ['a', 'img'],
      visit(node, context) {
        const key = node.tagName === 'a' ? 'href' : 'src';
        const path = node.properties[key];
        if (typeof path !== 'string') return;
        const url = withBase(path, base);
        if (url !== path) context.setProperty(node, key, url);
      },
    },
  };
}
