type Particle = {
  x: number; y: number; z: number;
  px: number; py: number; depth: number;
  radius: number; size: number; alpha: number; brightness: number;
  tone: number; spark: boolean;
  orbit: number;
};

let disposeHero: (() => void) | undefined;

function initializeHero() {
  disposeHero?.();
  disposeHero = undefined;
  const art = document.querySelector<HTMLElement>('[data-hero-art]');
  const canvas = art?.querySelector<HTMLCanvasElement>('[data-hero-canvas]');
  if (!art || !canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;

  const ctx = context;
  const controller = new AbortController();
  const { signal } = controller;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const styles = getComputedStyle(art);
  const colors = ['--accent', '--foreground', '--home-ice'].map(token => styles.getPropertyValue(token).trim());
  const sprites = colors.map(color => {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 40;
    const spriteContext = sprite.getContext('2d');
    if (spriteContext) {
      const glow = spriteContext.createRadialGradient(20, 20, 0, 20, 20, 20);
      glow.addColorStop(0, color);
      glow.addColorStop(.09, color);
      glow.addColorStop(.27, 'transparent');
      glow.addColorStop(1, 'transparent');
      spriteContext.fillStyle = glow;
      spriteContext.fillRect(0, 0, 40, 40);
    }
    return sprite;
  });

  let seed = 62173;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const particles: Particle[] = [];
  function addParticle(x: number, y: number, z: number, radius: number, tone: number, brightness: number, orbit = 0) {
    particles.push({ x, y, z, px: 0, py: 0, depth: 0, radius, size: 0, alpha: 0, tone, brightness, spark: random() > .975, orbit });
  }
  const compact = matchMedia('(max-width: 600px)').matches;
  const count = compact ? 2500 : 3900;
  // A folded toroidal cloud, crossed by two narrow orbital planes.
  for (let index = 0; index < count; index++) {
    const u = random() * Math.PI * 2;
    const v = random() * Math.PI * 2;
    const radius = 167 + 13 * Math.sin(3 * u);
    const tube = (34 + 19 * Math.sin(3 * u + .4) ** 2) * (.68 + random() * .32);
    const x = (radius + tube * Math.cos(v)) * Math.cos(u);
    const y = (radius + tube * Math.cos(v)) * Math.sin(u);
    const z = tube * Math.sin(v);
    const tiltedY = y * .65 - z * .76;
    const tiltedZ = y * .76 + z * .65;
    addParticle(x * .85 + tiltedY * .52, -x * .52 + tiltedY * .85, tiltedZ,
      .65 + random() * .9, random() > .84 ? 1 : random() > .83 ? 2 : 0, .65 + random() * .35);
  }
  const rings = [
    { tilt: .31, turn: -.6, radius: 241, tone: 1, speed: 4 },
    { tilt: 1.12, turn: .83, radius: 229, tone: 2, speed: -5 },
  ].map(ring => ({
    ...ring,
    sinTilt: Math.sin(ring.tilt),
    cosTilt: Math.cos(ring.tilt),
    sinTurn: Math.sin(ring.turn),
    cosTurn: Math.cos(ring.turn),
    sinX: 0,
    cosX: 1,
    sinY: 0,
    cosY: 1,
    sinZ: 0,
    cosZ: 1,
  }));
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex]!;
    const count = compact ? 360 : 560;
    for (let index = 0; index < count; index++) {
      const u = index / count * Math.PI * 2;
      const radius = ring.radius + (random() - .5) * 3;
      addParticle(radius * Math.cos(u), radius * Math.sin(u), 0,
        .55 + random() * .65, ring.tone, .55 + random() * .4, ringIndex + 1);
    }
  }
  for (let index = 0; index < 400; index++) {
    const u = random() * Math.PI * 2;
    const v = Math.acos(2 * random() - 1);
    const radius = 64 + random() * 3;
    addParticle(radius * Math.sin(v) * Math.cos(u), radius * Math.sin(v) * Math.sin(u), radius * Math.cos(v),
      .45 + random() * .45, index % 5 === 0 ? 1 : 0, .3 + random() * .4);
  }

  let width = 0;
  let height = 0;
  let scale = 1;
  let frame = 0;
  let previousTime = 0;
  let phase = .16;
  let visible = false;
  let failed = false;
  let pointerX = 0;
  let pointerY = 0;
  let targetX = 0;
  let targetY = 0;
  let pointerStrength = 0;
  let targetStrength = 0;
  let pointerActive = false;
  let bounds = canvas.getBoundingClientRect();

  function draw() {
    ctx.clearRect(0, 0, width, height);
    const motion = reducedMotion.matches ? 0 : 1;
    const ax = Math.sin(phase * .45) * .12 + pointerY * .12 * motion;
    const ay = phase + pointerX * .13 * motion;
    const az = Math.sin(phase * .32) * .07;
    const sinX = Math.sin(ax), cosX = Math.cos(ax);
    const sinY = Math.sin(ay), cosY = Math.cos(ay);
    const sinZ = Math.sin(az), cosZ = Math.cos(az);
    for (const ring of rings) {
      const angle = phase * ring.speed;
      const yAngle = angle * .72;
      const zAngle = angle * .41;
      ring.sinX = Math.sin(angle);
      ring.cosX = Math.cos(angle);
      ring.sinY = Math.sin(yAngle);
      ring.cosY = Math.cos(yAngle);
      ring.sinZ = Math.sin(zAngle);
      ring.cosZ = Math.cos(zAngle);
    }
    for (const particle of particles) {
      let sourceX = particle.x;
      let sourceY = particle.y;
      let sourceZ = particle.z;
      if (particle.orbit) {
        const ring = rings[particle.orbit - 1]!;
        const ringX = particle.x * ring.cosTurn - particle.y * ring.cosTilt * ring.sinTurn;
        const ringY = particle.x * ring.sinTurn + particle.y * ring.cosTilt * ring.cosTurn;
        const ringZ = particle.y * ring.sinTilt;
        const y = ringY * ring.cosX - ringZ * ring.sinX;
        const z = ringY * ring.sinX + ringZ * ring.cosX;
        const x = ringX * ring.cosY + z * ring.sinY;
        const depth = -ringX * ring.sinY + z * ring.cosY;
        sourceX = x * ring.cosZ - y * ring.sinZ;
        sourceY = x * ring.sinZ + y * ring.cosZ;
        sourceZ = depth;
      }
      const y = sourceY * cosX - sourceZ * sinX;
      const z = sourceY * sinX + sourceZ * cosX;
      const x = sourceX * cosY + z * sinY;
      particle.depth = -sourceX * sinY + z * cosY;
      const perspective = 760 / (760 - particle.depth);
      let px = (x * cosZ - y * sinZ) * perspective * scale + width / 2;
      let py = (x * sinZ + y * cosZ) * perspective * scale + height / 2;
      if (pointerStrength > 0 && motion) {
        const dx = px - (pointerX + 1) * width / 2;
        const dy = py - (pointerY + 1) * height / 2;
        const distance = Math.hypot(dx, dy);
        if (distance < 88) {
          const force = (1 - distance / 88) * 14 * pointerStrength;
          px += dx / (distance || 1) * force;
          py += dy / (distance || 1) * force;
        }
      }
      particle.px = px;
      particle.py = py;
      particle.size = Math.max(.45, particle.radius * perspective * scale);
      particle.alpha = Math.min(1, particle.brightness * (.57 + (particle.depth + 250) / 530));
    }
    ctx.globalCompositeOperation = 'screen';
    for (const particle of particles) {
      const size = particle.size * 12;
      ctx.globalAlpha = particle.alpha;
      ctx.drawImage(sprites[particle.tone]!, particle.px - size / 2, particle.py - size / 2, size, size);
      if (particle.spark && particle.depth > 0) {
        ctx.fillStyle = colors[particle.tone]!;
        ctx.globalAlpha = particle.alpha * .5;
        ctx.fillRect(particle.px - particle.size * 3, particle.py - .3, particle.size * 6, .6);
        ctx.fillRect(particle.px - .3, particle.py - particle.size * 3, .6, particle.size * 6);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    art!.removeAttribute('data-hero-motion');
  }

  function showFallback() {
    failed = true;
    stop();
    art!.removeAttribute('data-canvas-ready');
  }

  function schedule() {
    if (frame || !visible || document.hidden || reducedMotion.matches || failed) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(time: number) {
    frame = 0;
    if (!visible || document.hidden || reducedMotion.matches || failed) return;
    if (previousTime && time - previousTime < 30) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const elapsed = previousTime ? Math.min(time - previousTime, 60) : 16;
    previousTime = time;
    phase += elapsed * .000075;
    const blend = 1 - Math.exp(-elapsed / 110);
    pointerX += (targetX - pointerX) * blend;
    pointerY += (targetY - pointerY) * blend;
    pointerStrength += (targetStrength - pointerStrength) * blend;
    if (Math.abs(targetX - pointerX) < .001) pointerX = targetX;
    if (Math.abs(targetY - pointerY) < .001) pointerY = targetY;
    if (Math.abs(targetStrength - pointerStrength) < .001) pointerStrength = targetStrength;
    try { draw(); } catch { showFallback(); return; }
    schedule();
    if (!frame) previousTime = 0;
  }

  function synchronize() {
    stop();
    if (!visible || document.hidden) {
      pointerActive = false;
      targetX = targetY = targetStrength = 0;
    }
    art!.toggleAttribute('data-hero-motion', visible && !document.hidden && !reducedMotion.matches && !failed);
    schedule();
  }

  function resize() {
    bounds = canvas!.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    if (!width || !height) return;
    scale = Math.min(width / 545, height / 540);
    const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    canvas!.width = Math.round(width * ratio);
    canvas!.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    try {
      draw();
      art!.setAttribute('data-canvas-ready', '');
    } catch { showFallback(); }
  }

  const resizeObserver = new ResizeObserver(resize);
  const intersectionObserver = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (visible) bounds = canvas!.getBoundingClientRect();
    synchronize();
  }, { threshold: .05 });
  resizeObserver.observe(canvas);
  intersectionObserver.observe(canvas);
  canvas.addEventListener('pointermove', event => {
    if (reducedMotion.matches || !visible || document.hidden || failed || !width || !height) return;
    pointerActive = true;
    targetX = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / width * 2 - 1));
    targetY = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / height * 2 - 1));
    targetStrength = 1;
    schedule();
  }, { passive: true, signal });
  function releasePointer() {
    targetX = targetY = targetStrength = 0;
    pointerActive = false;
    schedule();
  }
  canvas.addEventListener('pointerleave', releasePointer, { signal });
  canvas.addEventListener('pointercancel', releasePointer, { signal });
  canvas.addEventListener('pointerup', event => { if (event.pointerType === 'touch') releasePointer(); }, { signal });
  reducedMotion.addEventListener('change', () => {
    targetX = targetY = targetStrength = 0;
    pointerX = pointerY = pointerStrength = 0;
    pointerActive = false;
    phase = .16;
    try { draw(); } catch { showFallback(); }
    synchronize();
  }, { signal });
  document.addEventListener('visibilitychange', synchronize, { signal });
  window.addEventListener('scroll', () => { if (pointerActive) bounds = canvas.getBoundingClientRect(); }, { passive: true, signal });
  canvas.addEventListener('contextlost', event => { event.preventDefault(); showFallback(); }, { signal });

  disposeHero = () => {
    stop();
    controller.abort();
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    art.removeAttribute('data-canvas-ready');
  };
  resize();
}

initializeHero();
document.addEventListener('astro:page-load', initializeHero);
document.addEventListener('astro:before-swap', () => disposeHero?.());
window.addEventListener('pagehide', () => disposeHero?.());
window.addEventListener('pageshow', event => { if (event.persisted) initializeHero(); });

export {};
