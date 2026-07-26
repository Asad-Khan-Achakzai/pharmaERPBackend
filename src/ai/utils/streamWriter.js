function flushResponse(res) {
  if (typeof res.flush === 'function') {
    res.flush();
    return;
  }
  if (res.socket && !res.socket.destroyed) {
    if (typeof res.socket.uncork === 'function') res.socket.uncork();
    if (typeof res.socket.flush === 'function') res.socket.flush();
  }
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  flushResponse(res);
}

function initSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  else if (res.socket && typeof res.socket.uncork === 'function') res.socket.uncork();
}

module.exports = { writeSse, initSse };
