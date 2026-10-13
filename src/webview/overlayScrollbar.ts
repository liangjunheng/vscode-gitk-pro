export const OVERLAY_SCROLLBAR_STYLES = `
  .overlay-scroll-viewport { position: relative; min-width: 0; min-height: 0; }
  .overlay-scroll-viewport.overlay-scrollbar > .overlay-scroll-content { scrollbar-width: none; }
  .overlay-scroll-viewport.overlay-scrollbar > .overlay-scroll-content::-webkit-scrollbar { width: 0; height: 0; }
  .overlay-scroll-track { position: absolute; z-index: 9; opacity: 0; pointer-events: none; transition: opacity 140ms ease; touch-action: none; user-select: none; }
  .overlay-scroll-track.vertical { top: 2px; bottom: 2px; right: 0; width: 10px; }
  .overlay-scroll-track.horizontal { left: 2px; right: 2px; bottom: 0; height: 10px; }
  .overlay-scroll-viewport.both-scrollbars > .overlay-scroll-track.vertical { bottom: 10px; }
  .overlay-scroll-viewport.both-scrollbars > .overlay-scroll-track.horizontal { right: 10px; }
  .overlay-scroll-track[hidden] { display: none; }
  .overlay-scroll-viewport:hover > .overlay-scroll-track, .overlay-scroll-viewport.scrolling > .overlay-scroll-track, .overlay-scroll-track:focus, .overlay-scroll-track.dragging { opacity: 1; pointer-events: auto; }
  .overlay-scroll-thumb { position: absolute; top: 0; left: 0; border-radius: 3px; background: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, .45)); }
  .overlay-scroll-track.vertical > .overlay-scroll-thumb { left: auto; right: 1px; width: 6px; }
  .overlay-scroll-track.horizontal > .overlay-scroll-thumb { top: auto; bottom: 1px; height: 6px; }
  .overlay-scroll-track:hover > .overlay-scroll-thumb { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128, 128, 128, .7)); }
  .overlay-scroll-track.dragging > .overlay-scroll-thumb { background: var(--vscode-scrollbarSlider-activeBackground, rgba(128, 128, 128, .9)); }
  .overlay-scroll-track:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  @media (prefers-reduced-motion: reduce) { .overlay-scroll-track { transition: none; } }
  @media (forced-colors: active) { .overlay-scroll-thumb, .overlay-scroll-track:hover > .overlay-scroll-thumb, .overlay-scroll-track.dragging > .overlay-scroll-thumb { background: ButtonText; } }
`;

export const OVERLAY_SCROLLBAR_SCRIPT = String.raw`
  function installOverlayScrollbars(viewport, content, tracks) {
    let frame = 0, hideTimer;
    content.classList.add('overlay-scroll-content');
    if (!content.hasAttribute('tabindex')) content.tabIndex = -1;
    const axes = tracks.map(function(track) {
      const horizontal = track.getAttribute('aria-orientation') === 'horizontal';
      return { track: track, thumb: track.firstElementChild, horizontal: horizontal,
        position: horizontal ? 'scrollLeft' : 'scrollTop', viewportSize: horizontal ? 'clientWidth' : 'clientHeight', extent: horizontal ? 'scrollWidth' : 'scrollHeight', coordinate: horizontal ? 'clientX' : 'clientY', drag: null };
    });
    function geometry(axis) { const maximum = Math.max(0, content[axis.extent] - content[axis.viewportSize]); const length = axis.track[axis.viewportSize]; const thumb = Math.min(length, Math.max(24, length * content[axis.viewportSize] / Math.max(1, content[axis.extent]))); return { maximum: maximum, thumb: thumb, travel: Math.max(0, length - thumb) }; }
    function update() { frame = 0; axes.forEach(function(axis) { const overflow = content[axis.viewportSize] > 0 && content[axis.extent] > content[axis.viewportSize] + 1; if (!overflow && document.activeElement === axis.track) content.focus({ preventScroll: true }); axis.track.hidden = !overflow; }); viewport.classList.toggle('both-scrollbars', axes.length > 1 && axes.every(function(axis) { return !axis.track.hidden; })); axes.forEach(function(axis) { const size = geometry(axis); const position = Math.max(0, Math.min(size.maximum, content[axis.position])); axis.track.setAttribute('aria-valuemax', String(Math.round(size.maximum))); axis.track.setAttribute('aria-valuenow', String(Math.round(position))); axis.thumb.style[axis.horizontal ? 'width' : 'height'] = size.thumb + 'px'; axis.thumb.style.transform = (axis.horizontal ? 'translateX(' : 'translateY(') + (size.maximum ? size.travel * position / size.maximum : 0) + 'px)'; }); }
    function queueUpdate() { if (!frame) frame = requestAnimationFrame(update); }
    function show() { viewport.classList.add('scrolling'); clearTimeout(hideTimer); hideTimer = setTimeout(function() { viewport.classList.remove('scrolling'); }, 900); }
    content.addEventListener('scroll', function() { show(); queueUpdate(); }, { passive: true });
    new MutationObserver(queueUpdate).observe(content, { subtree: true, childList: true, attributes: true, characterData: true });
    if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(queueUpdate); observer.observe(content); Array.from(content.children).forEach(function(child) { observer.observe(child); }); }
    window.addEventListener('resize', queueUpdate); if (document.fonts) document.fonts.ready.then(queueUpdate);
    axes.forEach(function(axis) { axis.track.addEventListener('pointerdown', function(event) { if (event.button !== 0) return; event.preventDefault(); const size = geometry(axis); if (event.target !== axis.thumb && size.travel) { const bounds = axis.track.getBoundingClientRect(); const local = event[axis.coordinate] - (axis.horizontal ? bounds.left : bounds.top) - size.thumb / 2; content[axis.position] = Math.max(0, Math.min(1, local / size.travel)) * size.maximum; } axis.drag = { pointerId: event.pointerId, coordinate: event[axis.coordinate], offset: content[axis.position] }; axis.track.setPointerCapture(event.pointerId); axis.track.classList.add('dragging'); show(); queueUpdate(); }); axis.track.addEventListener('pointermove', function(event) { if (!axis.drag || axis.drag.pointerId !== event.pointerId) return; const size = geometry(axis); if (size.travel) content[axis.position] = axis.drag.offset + (event[axis.coordinate] - axis.drag.coordinate) * size.maximum / size.travel; queueUpdate(); }); function stop(event) { if (!axis.drag || axis.drag.pointerId !== event.pointerId) return; axis.drag = null; axis.track.classList.remove('dragging'); if (axis.track.hasPointerCapture(event.pointerId)) axis.track.releasePointerCapture(event.pointerId); show(); } ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function(name) { axis.track.addEventListener(name, stop); }); axis.track.addEventListener('wheel', function(event) { const multiplier = event.deltaMode === 1 ? 25 : event.deltaMode === 2 ? content[axis.viewportSize] : 1; if (axis.horizontal) content.scrollLeft += (event.deltaX || event.deltaY) * multiplier; else { content.scrollTop += event.deltaY * multiplier; content.scrollLeft += event.deltaX * multiplier; } event.preventDefault(); show(); queueUpdate(); }, { passive: false }); axis.track.addEventListener('keydown', function(event) { const size = geometry(axis), page = content[axis.viewportSize] * .9, backward = axis.horizontal ? 'ArrowLeft' : 'ArrowUp', forward = axis.horizontal ? 'ArrowRight' : 'ArrowDown'; if (event.key === 'Home') content[axis.position] = 0; else if (event.key === 'End') content[axis.position] = size.maximum; else if (event.key === backward) content[axis.position] -= 25; else if (event.key === forward) content[axis.position] += 25; else if (event.key === 'PageUp') content[axis.position] -= page; else if (event.key === 'PageDown') content[axis.position] += page; else return; event.preventDefault(); show(); queueUpdate(); }); });
    viewport.classList.add('overlay-scrollbar'); queueUpdate();
  }
`;
