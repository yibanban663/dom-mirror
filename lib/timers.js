'use strict';

function createTimers() {
  const timers = new Set();
  let closed = false;
  function clear(timer) {
    global.clearTimeout(timer);
    global.clearInterval(timer);
    timers.delete(timer);
  }
  return {
    setTimeout(callback, delay, ...args) {
      if (closed) return;
      const timer = global.setTimeout(() => {
        timers.delete(timer);
        callback(...args);
      }, delay);
      timers.add(timer);
      return timer;
    },
    setInterval(callback, delay, ...args) {
      if (closed) return;
      const timer = global.setInterval(callback, delay, ...args);
      timers.add(timer);
      return timer;
    },
    clearTimeout: clear,
    clearInterval: clear,
    clear() {
      closed = true;
      for (const timer of timers) clear(timer);
    },
  };
}

module.exports = { createTimers };
