import { getCollection } from 'astro:content';

export const sections = ['Getting started', 'Build rules', 'Reference'] as const;
export const docHref = (id: string) => id === 'index' ? '/docs/' : `/docs/${id}/`;
export const getDocs = async () => (await getCollection('docs')).sort((a, b) => a.data.order - b.data.order);
