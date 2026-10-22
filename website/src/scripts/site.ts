export {};

interface SearchEntry {
  title: string;
  description: string;
  section: string;
  href: string;
  text: string;
}

const dialog = document.querySelector<HTMLDialogElement>('#docs-search')!;
const input = document.querySelector<HTMLInputElement>('#search-input')!;
const results = document.querySelector<HTMLUListElement>('#search-results')!;
const status = document.querySelector<HTMLParagraphElement>('#search-status')!;
let index: Promise<SearchEntry[]> | undefined;
let opener: HTMLElement | null = null;

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function openSearch(trigger: HTMLElement | null) {
  if (dialog.open) return;
  opener = trigger;
  dialog.showModal();
  input.focus();
}

function resultLink(entry: SearchEntry, terms: string[]) {
  const link = document.createElement('a');
  link.href = entry.href;
  const section = document.createElement('span');
  section.className = 'search-result-section';
  section.textContent = entry.section;
  const title = document.createElement('span');
  title.className = 'search-result-title';
  title.textContent = entry.title;
  const snippet = document.createElement('span');
  snippet.className = 'search-result-snippet';
  const firstMatch = entry.text.toLowerCase().indexOf(terms[0]);
  const start = Math.max(0, firstMatch - 48);
  snippet.textContent = firstMatch < 0 ? entry.description : `${start ? '…' : ''}${entry.text.slice(start, start + 160)}${entry.text.length > start + 160 ? '…' : ''}`;
  link.append(section, title, snippet);
  const item = document.createElement('li');
  item.append(link);
  return item;
}

async function search() {
  const query = normalize(input.value);
  results.replaceChildren();
  if (!query) {
    status.textContent = 'Type to search the documentation.';
    return;
  }
  status.textContent = 'Searching…';
  try {
    index ??= fetch('/search-index.json').then(response => {
      if (!response.ok) throw new Error('Search index unavailable');
      return response.json() as Promise<SearchEntry[]>;
    });
    const entries = await index;
    if (normalize(input.value) !== query) return;
    const terms = query.split(/\s+/);
    const matches = entries.map(entry => {
      const title = normalize(entry.title);
      const text = normalize(`${entry.title} ${entry.description} ${entry.text}`);
      const score = terms.every(term => text.includes(term))
        ? terms.reduce((total, term) => total + (title.includes(term) ? 10 : 1), 0)
        : 0;
      return { entry, score };
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score);
    results.replaceChildren(...matches.map(({ entry }) => resultLink(entry, terms)));
    status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'page' : 'pages'} found.` : 'No pages found. Try “scopes”, “AI”, or “check”.';
  } catch {
    status.textContent = 'Search is unavailable. Browse the documentation from the Docs link.';
  }
}

for (const trigger of document.querySelectorAll<HTMLButtonElement>('[data-search-open]')) {
  trigger.hidden = false;
  trigger.addEventListener('click', () => openSearch(trigger));
}
input.addEventListener('input', search);
dialog.addEventListener('close', () => opener?.focus());
dialog.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  dialog.close();
});
dialog.addEventListener('click', event => {
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (dialog.open) dialog.close();
    else openSearch(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-rule-copy]')) {
  button.hidden = false;
}

for (const pre of document.querySelectorAll<HTMLPreElement>('pre:has(code)')) {
  pre.tabIndex = 0;
  if (!pre.hasAttribute('aria-label')) pre.setAttribute('aria-label', 'Code example');
  if (pre.hasAttribute('data-copy-disabled')) continue;
  const code = pre.querySelector('code')!;
  const block = document.createElement('div');
  block.className = 'code-block';
  pre.before(block);
  block.append(pre);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.dataset.copy = code.textContent ?? '';
  button.innerHTML = '<svg class="copy-symbol" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 7h9v10H7zM4 13H2V2h10v2" /></svg><svg class="copy-success" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 10 4 4 8-9" /></svg><span class="sr-only" data-copy-label>Copy</span>';
  button.setAttribute('aria-label', 'Copy code example');
  block.append(button);
}

const copyStatus = document.querySelector<HTMLElement>('#copy-status')!;
const pendingCopies = new WeakMap<HTMLElement, number>();
document.addEventListener('click', async event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-copy]') : null;
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? '');
    const label = button.querySelector<HTMLElement>('[data-copy-label]') ?? button;
    const original = label.dataset.originalLabel ?? label.textContent ?? 'Copy';
    label.dataset.originalLabel = original;
    label.textContent = 'Copied';
    button.dataset.copied = 'true';
    copyStatus.textContent = 'Code copied to clipboard.';
    clearTimeout(pendingCopies.get(button));
    pendingCopies.set(button, window.setTimeout(() => {
      label.textContent = original;
      delete button.dataset.copied;
      copyStatus.textContent = '';
    }, 1800));
  } catch {
    copyStatus.textContent = 'Copy failed. Select the code and copy it manually.';
  }
});

const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc-link]')];
if (tocLinks.length) {
  const headings = tocLinks.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1)))).filter((heading): heading is HTMLElement => Boolean(heading));
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of tocLinks) {
        if (decodeURIComponent(link.hash.slice(1)) === entry.target.id) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
  }, { rootMargin: '-5% 0px -70% 0px' });
  headings.forEach(heading => observer.observe(heading));
}
