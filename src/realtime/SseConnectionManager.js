const realtimeHub = require('./RealtimeHub');

function writeSse(res, event) {
  res.write(`id: ${Date.now()}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function attachSseClient(res, companyId, channels, onClose) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  realtimeHub.incrementConnections();
  const unsubscribers = channels.map((channel) =>
    realtimeHub.subscribe(companyId, channel, (event) => writeSse(res, event))
  );

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribers.forEach((off) => off());
    realtimeHub.decrementConnections();
    onClose?.();
  };

  res.on('close', cleanup);
  return cleanup;
}

module.exports = { attachSseClient, writeSse };
