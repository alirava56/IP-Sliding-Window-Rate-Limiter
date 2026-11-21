import { createServer } from 'node:http';
import { createApp } from './app';
import { loadConfig, type AppConfig } from './config';

const SHUTDOWN_GRACE_MS = 10_000;
const MAX_SWEEP_INTERVAL_MS = 60_000;

export function startServer(
  config: AppConfig,
  { host, shutdownGraceMs = SHUTDOWN_GRACE_MS }: { host?: string; shutdownGraceMs?: number } = {},
) {
  const { app, limiter } = createApp(config);
  let stopping: Promise<void> | undefined;
  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 30_000, connectionsCheckingInterval: 1000 },
    (request, response) => {
      response.once('finish', () => {
        if (stopping !== undefined) {
          // By the next turn, Node has marked the finished connection idle.
          setImmediate(() => server.closeIdleConnections()).unref();
        }
      });
      app(request, response);
    },
  );
  server.listen({ port: config.port, host });
  const sweep = setInterval(
    () => limiter.sweep(),
    Math.min(config.windowMs, MAX_SWEEP_INTERVAL_MS),
  );
  sweep.unref();
  server.once('close', () => clearInterval(sweep));

  function shutdown(): Promise<void> {
    stopping ??= new Promise((resolve, reject) => {
      clearInterval(sweep);
      let forced = false;
      const deadline = setTimeout(() => {
        forced = true;
        server.closeAllConnections();
      }, shutdownGraceMs);
      deadline.unref();

      server.close((error) => {
        clearTimeout(deadline);
        if (error) reject(error);
        else if (forced)
          reject(new Error('Grace period expired. Remaining HTTP connections were closed'));
        else resolve();
      });
    });
    return stopping;
  }

  return { server, limiter, shutdown };
}

function main(): void {
  try {
    const config = loadConfig();
    const { server, shutdown } = startServer(config);
    let stopping = false;

    function stop() {
      if (stopping) return;
      stopping = true;
      shutdown().catch((error: unknown) => {
        console.error('Server shutdown failed', error);
        process.exitCode = 1;
      });
    }

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    server.once('close', () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    });
    server.once('error', (error) => {
      console.error('HTTP server error', error.message);
      process.exitCode = 1;
      stop();
    });
    server.once('listening', () => {
      console.log(
        `Listening on port ${config.port}. Quota: ${config.maxRequests} requests per ${config.windowMs} ms per IP.`,
      );
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Server startup failed');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
