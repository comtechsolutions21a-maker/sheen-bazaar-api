// Express 4 doesn't catch errors thrown inside `async` route handlers. When one
// happens (e.g. someone opens /orders/not-a-real-id), Node treats it as an
// unhandled rejection and SHUTS DOWN the whole server. This patch makes every
// async handler pass its error to the normal error handler instead, so one bad
// request can only fail that one request. (Same idea as the
// "express-async-errors" package, without adding a dependency.)
let Layer = null;
try { Layer = require('express/lib/router/layer'); } catch { /* Express 5 already handles async errors */ }

if (Layer && !Layer.prototype.__sbAsyncPatched) {
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return original.call(this, req, res, next); // error middleware
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__sbAsyncPatched = true;
}

// Last line of defence: log instead of crashing if anything else slips through
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason?.message || reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err?.message || err));
