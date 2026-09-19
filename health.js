import { createServer } from 'node:http';

// Render's free plan only offers Web Services, which must bind a port and
// answer HTTP health checks — this bot has no other reason to speak HTTP.
// The same endpoint doubles as the target for an external uptime pinger
// (e.g. UptimeRobot) so the free instance never actually goes to sleep.
export function startHealthServer(client) {
  const port = process.env.PORT || 3000;

  const server = createServer((req, res) => {
    const ready = client.isReady();
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: ready ? 'ok' : 'starting',
      bot: client.user?.tag ?? null,
      uptimeSec: Math.round(process.uptime()),
    }));
  });

  server.listen(port, () => console.log(`✅ Health server listening on :${port} (for Render + uptime pinger)`));
  return server;
}
