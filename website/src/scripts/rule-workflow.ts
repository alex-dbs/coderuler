export {};

type Mode = 'ai' | 'regex' | 'code';
type Example = Record<'label' | 'instruction' | 'file' | 'excluded' | 'outside' | 'source' | 'context' | 'kept' | 'dropped', string> & { fileContext?: string; pattern?: string };
let disposeWorkflow = () => {};

function mountWorkflow() {
  disposeWorkflow();
  const disposers = [...document.querySelectorAll<HTMLElement>('[data-rule-workflow]')].map(root => {
    const controller = new AbortController();
    const { signal } = controller;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const examples = JSON.parse(root.dataset.flowExamples ?? '{}') as Record<Mode, Example>;
    const nodes = [...root.querySelectorAll<HTMLElement>('[data-flow-node]')];
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-flow-mode]')];
    const stepButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-flow-step]')];
    const panels = [...root.querySelectorAll<HTMLElement>('[data-flow-example]')];
    const replay = root.querySelector<HTMLButtonElement>('[data-flow-replay]');
    const pair = root.querySelector<HTMLElement>('[data-flow-pair]');
    const announcement = root.querySelector<HTMLElement>('[data-flow-announcement]');
    const get = (selector: string) => root.querySelector<HTMLElement>(selector);
    let timers: number[] = [];
    let animations: Animation[] = [];
    let travelers: HTMLElement[] = [];
    let autoplayAvailable = root.dataset.flowPlayed !== 'true';
    let pending: 'all' | number | null = null;
    let visible = false;
    let running = false;
    let paused = false;
    let interactionPaused = false;
    let elapsed = 0;
    let startedAt = 0;
    let nextEvent = 0;
    let events: { at: number; run: () => void }[] = [];
    let currentStage = Math.max(0, Math.min(3, Number(root.dataset.flowStage) || 0));
    let selected = (buttons.find(button => button.getAttribute('aria-pressed') === 'true')?.dataset.flowMode ?? 'ai') as Mode;

    function clearTimers() {
      timers.forEach(timer => window.clearTimeout(timer));
      timers = [];
    }

    function finish() {
      clearTimers();
      animations.forEach(animation => animation.cancel());
      animations = [];
      travelers.forEach(traveler => traveler.remove());
      travelers = [];
      root.dataset.flowRunning = 'false';
      running = false;
      paused = false;
    }

    function complete() {
      clearTimers();
      root.dataset.flowRunning = 'false';
      running = false;
      paused = false;
    }

    function stop() {
      pending = null;
      autoplayAvailable = false;
      finish();
    }

    function animate(element: HTMLElement | null, frames: Keyframe[], duration: number, delay = 0) {
      if (!element || reducedMotion.matches || typeof element.animate !== 'function') return;
      const animation = element.animate(frames, { duration, delay, easing: 'cubic-bezier(.22,.68,.2,1)', fill: 'both' });
      animations.push(animation);
      return animation;
    }

    function travel(origin: DOMRect | undefined, to: HTMLElement | null, duration: number, label = examples[selected].context, arrived = () => {}) {
      if (!origin || !to || !origin.width || !origin.height || typeof to.animate !== 'function') { arrived(); return; }
      const bounds = root.getBoundingClientRect();
      const target = to.getBoundingClientRect();
      const traveler = document.createElement('span');
      traveler.className = 'workflow-traveler';
      traveler.setAttribute('aria-hidden', 'true');
      traveler.textContent = label;
      traveler.style.left = `${origin.left - bounds.left}px`;
      traveler.style.top = `${origin.top - bounds.top}px`;
      root.append(traveler);
      travelers.push(traveler);
      const x = target.left - origin.left;
      const y = target.top - origin.top;
      const animation = animate(traveler, [
        { transform: 'translate(0, 0) scale(.9)', opacity: 0 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: .15 },
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1, offset: .85 },
        { transform: `translate(${x}px, ${y}px) scale(.9)`, opacity: 0 },
      ], duration);
      animation?.finished.then(() => { traveler.remove(); arrived(); }, () => {});
    }

    function highlightSource(scroll = true) {
      const panel = panels.find(panel => panel.dataset.flowExample === selected);
      const lines = [...panel?.querySelectorAll<HTMLElement>('[data-flow-code-stage]') ?? []];
      lines.forEach(line => line.toggleAttribute('data-flow-highlighted', Number(line.dataset.flowCodeStage) === currentStage));
      if (!scroll) return;
      const active = lines.filter(line => Number(line.dataset.flowCodeStage) === currentStage);
      const pre = panel?.querySelector<HTMLPreElement>('pre');
      if (!pre || !active.length) return;
      const bounds = pre.getBoundingClientRect();
      const onscreen = bounds.bottom > 80 && bounds.top < window.innerHeight - 16;
      const top = onscreen ? Math.max(bounds.top, 80) : bounds.top;
      const bottom = onscreen ? Math.min(bounds.bottom, window.innerHeight - 16) : bounds.bottom;
      const first = active[0].getBoundingClientRect();
      const last = active[active.length - 1].getBoundingClientRect();
      if (first.top < top + 16 || last.bottom > bottom - 16) {
        const blockHeight = last.bottom - first.top;
        const inset = blockHeight < bottom - top - 32 ? (bottom - top - blockHeight) / 2 : 16;
        pre.scrollTo({ top: pre.scrollTop + first.top - top - inset, behavior: 'instant' });
      }
    }

    function text(selector: string, value: string) {
      const element = get(selector);
      if (element) element.textContent = value;
    }

    function phase(value: string) {
      const evaluator = get('.workflow-evaluator');
      if (evaluator) evaluator.dataset.flowCheckPhase = value;
    }
    function showModel(motion = true) {
      const model = get('[data-flow-model]');
      if (!model) return;
      model.dataset.flowVisible = '';
      model.removeAttribute('aria-hidden');
      if (motion) animate(model, [{ transform: 'scale(.96)', opacity: .4 }, { transform: 'scale(1)', opacity: 1 }], 650);
    }

    function lineCount() {
      const source = examples.code.source;
      return source ? source.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
    }

    function resetCheck() {
      root.dataset.flowVerdict = 'pending';
      const outcome = get('[data-flow-outcome]');
      if (outcome) { outcome.dataset.flowVerdict = 'pending'; outcome.setAttribute('aria-hidden', 'true'); }
      phase('ready');
      const model = get('[data-flow-model]');
      if (model) {
        model.removeAttribute('data-flow-visible');
        model.setAttribute('aria-hidden', 'true');
      }
      const evaluator = get('.workflow-evaluator');
      if (evaluator) evaluator.scrollTop = 0;
      if (announcement) announcement.textContent = '';
      text('[data-flow-line-count]', '0');
      text('[data-flow-code-comparison]', 'lineCount > 80');
      text('[data-flow-regex-comparison]', `pattern.test("${examples.regex.context}")`);
      root.querySelectorAll('[data-flow-url-part], [data-flow-count-line]').forEach(element => element.removeAttribute('data-flow-scanned'));
    }

    function scanLine(count: number, motion = true) {
      text('[data-flow-line-count]', String(count));
      root.querySelectorAll('[data-flow-count-line]').forEach((line, index) => line.toggleAttribute('data-flow-scanned', index < count));
      const line = root.querySelectorAll<HTMLElement>('[data-flow-count-line]')[count - 1];
      if (motion) animate(line ?? null, [{ backgroundColor: 'var(--accent)', opacity: .4 }, { backgroundColor: 'transparent', opacity: 1 }], 450);
    }

    function comparison() {
      phase('comparison');
      if (selected === 'regex') {
        const matches = new RegExp(examples.regex.pattern!).test(examples.regex.context);
        text('[data-flow-regex-comparison]', `pattern.test("${examples.regex.context}") → ${matches}`);
      } else if (selected === 'code') {
        text('[data-flow-line-count]', String(lineCount()));
        text('[data-flow-code-comparison]', `${lineCount()} > 80 → ${lineCount() > 80}`);
      }
    }

    function verdict(motion = true) {
      const passes = selected === 'regex'
        ? new RegExp(examples.regex.pattern!).test(examples.regex.context)
        : selected === 'code' && lineCount() <= 80;
      const value = passes ? 'pass' : 'violation';
      root.dataset.flowVerdict = value;
      const outcome = get('[data-flow-outcome]');
      if (outcome) { outcome.dataset.flowVerdict = value; outcome.removeAttribute('aria-hidden'); }
      text('[data-flow-verdict-icon]', passes ? '✓' : '!');
      text('[data-flow-verdict-label]', passes ? 'Pass' : 'Violation');
      text('[data-flow-decision]', passes ? 'pass()' : 'violation(…)');
      text('[data-flow-verdict-message]', selected === 'ai'
        ? 'Check each pointer for nil before dereferencing it.'
        : selected === 'regex' ? 'The retained URL matches the service URL pattern.'
        : `${lineCount()} lines ${passes ? 'is within' : 'exceeds'} the 80-line limit.`);
      phase('complete');
      if (motion) animate(outcome, [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], 400);
      const evaluator = get('.workflow-evaluator');
      if (evaluator) evaluator.scrollTop = evaluator.scrollHeight;
      if (announcement) announcement.textContent = `${examples[selected].label}: ${passes ? 'Pass' : 'Violation'}. ${get('[data-flow-verdict-message]')?.textContent}`;
    }

    function finalCheck() {
      if (selected === 'code') scanLine(lineCount(), false);
      if (selected === 'regex') root.querySelectorAll('[data-flow-url-part]').forEach(part => part.setAttribute('data-flow-scanned', ''));
      if (selected === 'ai') showModel(false);
      comparison();
      verdict(false);
    }

    function checkEvents(offset: number) {
      const event = (at: number, run: () => void) => ({ at: offset + at, run });
      const steps = selected === 'ai' ? [
        event(400, () => {
          phase('request');
          travel(get('[data-flow-ai-request]')?.getBoundingClientRect(), get('[data-flow-model]'), 900, `${examples.ai.context} + containing file + rule instruction`, () => {
            if (currentStage === 3) showModel();
          });
        }),
      ] : selected === 'regex'
        ? [...root.querySelectorAll<HTMLElement>('[data-flow-url-part]')].map((part, index) => event(400 + index * 550, () => {
          phase('matching');
          part.setAttribute('data-flow-scanned', '');
          animate(part, [{ transform: 'translateY(-8px)', opacity: .25 }, { transform: 'translateY(0)', opacity: 1 }], 450);
        }))
        : Array.from({ length: lineCount() }, (_, index) => event(400 + index * 550, () => {
          phase('counting');
          scanLine(index + 1);
        }));
      return [...steps, event(2100, () => comparison()), event(2800, () => verdict()), event(3900, complete)];
    }

    function stage(index: number, motion = true, showResult = !motion) {
      const prior = index === 2 && currentStage === 1 ? get('[data-flow-extract]') : null;
      const origin = prior?.getBoundingClientRect();
      currentStage = index;
      root.dataset.flowStage = String(index);
      resetCheck();
      nodes.forEach((node, nodeIndex) => {
        node.toggleAttribute('data-flow-active', nodeIndex === index);
        node.hidden = nodeIndex !== index;
      });
      stepButtons.forEach((button, buttonIndex) => button.setAttribute('aria-pressed', String(buttonIndex === index)));
      highlightSource();
      if (!motion || reducedMotion.matches) { if (index === 3 && showResult) finalCheck(); return; }
      if (index === 0) {
        animate(get('[data-flow-admitted]'), [
          { transform: 'translateX(-80px)', opacity: 0 },
          { transform: 'translateX(-16px)', opacity: 1, offset: .5 },
          { transform: 'translateX(0)', opacity: 1 },
        ], 850);
        animate(get('[data-flow-excluded]'), [
          { transform: 'translateX(-80px)', opacity: 0 },
          { transform: 'translate(0, 0)', opacity: 1, offset: .45 },
          { transform: 'translate(22px, 22px) rotate(7deg)', opacity: .3 },
        ], 1000);
      }
      if (index === 1) {
        animate(get('[data-flow-outside]'), [{ opacity: 1 }, { opacity: .3 }], 450);
        const extract = get('[data-flow-extract]');
        const hidden = animate(extract, [{ opacity: 0 }, { opacity: 0 }], 1800);
        const selection = animate(get('[data-flow-selected]'), [
          { clipPath: 'inset(0 100% 0 0)', backgroundColor: 'transparent' },
          { clipPath: 'inset(0 0 0 0)', backgroundColor: 'var(--surface)' },
        ], 500);
        selection?.finished.then(() => {
          if (currentStage !== 1) return;
          travel(get('[data-flow-selected]')?.getBoundingClientRect(), extract, 950, examples[selected].context, () => {
            if (currentStage !== 1) return;
            hidden?.cancel();
            animate(extract, [{ opacity: 0 }, { opacity: 1 }], 200);
          });
        }, () => {});
      }
      if (index === 2) {
        const kept = get('[data-flow-kept]');
        if (origin?.width) {
          const hidden = animate(kept, [{ opacity: 0 }, { opacity: 0 }], 1800);
          travel(origin, kept, 750, examples[selected].context, () => {
            if (currentStage !== 2) return;
            hidden?.cancel();
            animate(kept, [{ opacity: 0 }, { opacity: 1 }], 200);
          });
        } else {
          animate(kept, [{ opacity: 0 }, { opacity: 1 }], 400);
        }
        animate(get('[data-flow-dropped]'), [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: 'translateY(45px) scale(.85)', opacity: .15 },
        ], 850);
      }
    }

    function schedule() {
      startedAt = performance.now();
      for (let index = nextEvent; index < events.length; index++) {
        timers.push(window.setTimeout(() => {
          nextEvent = index + 1;
          events[index].run();
        }, Math.max(0, events[index].at - elapsed)));
      }
    }

    function pause() {
      if (!running || paused) return;
      elapsed += performance.now() - startedAt;
      clearTimers();
      animations.forEach(animation => { if (animation.playState === 'running') animation.pause(); });
      paused = true;
      root.dataset.flowRunning = 'paused';
    }

    function resume() {
      if (!running || !paused || !visible || document.hidden || reducedMotion.matches || interactionPaused) return;
      paused = false;
      root.dataset.flowRunning = 'true';
      animations.forEach(animation => { if (animation.playState === 'paused') animation.play(); });
      schedule();
    }

    function play(request: 'all' | number) {
      finish();
      pending = null;
      autoplayAvailable = false;
      root.dataset.flowPlayed = 'true';
      if (reducedMotion.matches) { stage(request === 'all' ? 0 : request, false); return; }
      if (document.hidden || !visible || interactionPaused) { pending = request; return; }
      running = true;
      elapsed = 0;
      nextEvent = 0;
      events = request === 'all'
        ? [0, 1, 2, 3].map(index => ({ at: index * 1800, run: () => stage(index) }))
        : [{ at: 0, run: () => stage(request) }];
      if (request === 'all' || request === 3) events.push(...checkEvents(request === 'all' ? 5400 : 0));
      else events.push({ at: 1800, run: complete });
      root.dataset.flowRunning = 'true';
      schedule();
    }

    function syncMode() {
      const example = examples[selected];
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.flowMode === selected)));
      panels.forEach(panel => { panel.hidden = panel.dataset.flowExample !== selected; });
      const instruction = get('[data-flow-instruction]');
      if (instruction) instruction.textContent = example.instruction;
      root.querySelectorAll<HTMLElement>('[data-flow-evaluator]').forEach(element => { element.hidden = element.dataset.flowEvaluator !== selected; });
      text('[data-flow-pattern]', `/${examples.regex.pattern}/`);
      root.querySelectorAll<HTMLElement>('[data-flow-text]').forEach(element => {
        element.textContent = example[element.dataset.flowText as keyof Example] ?? '';
      });
      stage(currentStage, false);
    }

    function intersects(element: Element | null | undefined) {
      if (!element) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 80 && bounds.top < window.innerHeight - 16;
    }

    function refreshVisibility() {
      const panel = panels.find(panel => panel.dataset.flowExample === selected);
      visible = intersects(panel?.querySelector('pre')) && intersects(nodes[currentStage]?.querySelector('.workflow-sample'));
      if (!visible) { pause(); return; }
      if (document.hidden || reducedMotion.matches) return;
      if (pending !== null && !interactionPaused) play(pending);
      else if (paused) resume();
      else if (autoplayAvailable && !root.contains(document.activeElement)) play('all');
    }

    function pauseForReading() {
      pending = null;
      autoplayAvailable = false;
      interactionPaused = true;
      pause();
    }


    function replayAll() {
      stop();
      interactionPaused = false;
      stage(0, false);
      pending = 'all';
      pair?.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
      refreshVisibility();
      if (reducedMotion.matches) play('all');
    }
    root.addEventListener('focusin', pauseForReading, { signal });
    root.addEventListener('pointerdown', pauseForReading, { signal });
    buttons.forEach(button => button.addEventListener('click', () => {
      stop();
      selected = button.dataset.flowMode as Mode;
      currentStage = 0;
      syncMode();
      replayAll();
      if (announcement) announcement.textContent = `${examples[selected].label} selected. ${reducedMotion.matches ? 'Step 1 selected.' : 'Replaying all four rule steps.'}`;
    }, { signal }));
    stepButtons.forEach((button, index) => button.addEventListener('click', () => {
      stop();
      interactionPaused = false;
      stage(index, false, reducedMotion.matches);
      refreshVisibility();
      play(index);
      if (announcement) announcement.textContent = `Step ${index + 1}: ${button.textContent?.trim()}. Corresponding rule lines highlighted.`;
    }, { signal }));
    replay?.addEventListener('click', () => {
      replayAll();
      if (announcement) announcement.textContent = reducedMotion.matches ? 'Step 1 selected. Choose another step to inspect its rule lines.' : 'Replaying all four rule steps.';
    }, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else refreshVisibility(); }, { signal });
    reducedMotion.addEventListener('change', () => { stop(); stage(currentStage, false); }, { signal });
    let viewportWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth !== viewportWidth) {
        viewportWidth = window.innerWidth;
        finish();
        highlightSource();
        if (currentStage === 3) finalCheck();
      }
      refreshVisibility();
    }, { signal, passive: true });

    root.dataset.flowEnhanced = 'true';
    syncMode();
    root.querySelectorAll<HTMLElement>('[data-flow-modes], [data-flow-step-controls], [data-flow-replay]').forEach(element => { element.hidden = false; });
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(refreshVisibility, { threshold: [0, .1, .5, 1], rootMargin: '-80px 0px -16px 0px' }) : null;
    if (observer) {
      panels.forEach(panel => {
        const pre = panel.querySelector('pre');
        if (pre) observer.observe(pre);
      });
      nodes.forEach(node => {
        const sample = node.querySelector('.workflow-sample');
        if (sample) observer.observe(sample);
      });
    }
    refreshVisibility();

    return () => {
      finish();
      observer?.disconnect();
      controller.abort();
    };
  });
  disposeWorkflow = () => disposers.forEach(dispose => dispose());
}

function installLifecycle() {
  const lifecycle = new AbortController();
  document.addEventListener('astro:page-load', mountWorkflow, { signal: lifecycle.signal });
  document.addEventListener('astro:before-swap', () => disposeWorkflow(), { signal: lifecycle.signal });
  window.addEventListener('pagehide', () => {
    disposeWorkflow();
    lifecycle.abort();
    window.addEventListener('pageshow', installLifecycle, { once: true });
  }, { once: true });
  mountWorkflow();
}
installLifecycle();
