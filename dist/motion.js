'use strict';
const SoundAtlasMotion = (() => {
  function timelineAt(value, slots = 48) {
    const position = Math.max(0, Math.min(slots - 1, Number.isFinite(Number(value)) ? Number(value) : 0));
    const slot = Math.min(slots - 1, Math.floor(position + 1e-7));
    const minutes = Math.floor(position * 30 + 1e-6);
    return { position, slot, label: String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0') };
  }
  function createFrameQueue(callback, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
    let ticket = null;
    return {
      request() { if (ticket === null) ticket = request(() => { ticket = null; callback(); }); },
      flush() { if (ticket !== null) { cancel(ticket); ticket = null; callback(); } },
      cancel() { if (ticket !== null) cancel(ticket); ticket = null; },
    };
  }
  return { timelineAt, createFrameQueue };
})();
