import { getDocs, docHref } from '../lib/docs';

export async function GET() {
  const entries = await getDocs();
  return Response.json(entries.map(entry => ({
    title: entry.data.title,
    description: entry.data.description,
    section: entry.data.section,
    href: docHref(entry.id),
    text: (entry.body ?? '').replace(/```[^\n]*\n/g, '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim(),
  })));
}
