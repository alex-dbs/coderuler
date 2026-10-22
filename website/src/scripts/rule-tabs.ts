export {};

for (const root of document.querySelectorAll<HTMLElement>('[data-rule-tabs]')) {
  const tablist = root.querySelector<HTMLElement>('[data-rule-tablist]')!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-rule-tab]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[data-rule-panel]')];

  function setTabStop(index: number) {
    tabs.forEach((tab, tabIndex) => {
      tab.tabIndex = tabIndex === index ? 0 : -1;
    });
  }

  function selectTab(index: number) {
    setTabStop(index);
    tabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      panels[tabIndex].hidden = !selected;
      panels[tabIndex].inert = !selected;
    });
  }

  tabs.forEach((tab, index) => {
    const panel = panels[index];
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;

    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', event => {
      let nextIndex: number;
      switch (event.key) {
        case 'ArrowRight':
          nextIndex = (index + 1) % tabs.length;
          break;
        case 'ArrowLeft':
          nextIndex = (index - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      setTabStop(nextIndex);
      tabs[nextIndex].focus();
    });
  });

  selectTab(0);
  tablist.hidden = false;
}
