import express, { type ErrorRequestHandler } from 'express';
import type { AppConfig } from './config';
import { compileProxyTrust } from './ip';
import { SlidingWindowLimiter } from './limiter/sliding-window';
import { rateLimitMiddleware } from './middleware/rate-limit';

const JSON_LIMIT_BYTES = 16 * 1024;

export function createApp(config: AppConfig, now?: () => number) {
  const app = express();
  const limiter = new SlidingWindowLimiter({
    windowMs: config.windowMs,
    maxRequests: config.maxRequests,
    maxTrackedClients: config.maxTrackedClients,
    ...(now === undefined ? {} : { now }),
  });

  app.disable('x-powered-by');
  app.disable('etag');
  app.set(
    'trust proxy',
    config.trustedProxyCidrs.length === 0 ? false : compileProxyTrust(config.trustedProxyCidrs),
  );

  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ip-sliding-window-limiter' });
  });

  app.use('/api', rateLimitMiddleware(limiter));
  app.use('/api', express.json({ limit: JSON_LIMIT_BYTES, strict: true, inflate: false }));

  app.get('/api/demo', (_req, res) => {
    res.json({ message: 'Request accepted', ip: res.locals.clientIp });
  });

  app.post('/api/echo', (req, res) => {
    res.json({ message: 'Payload accepted', data: req.body ?? null });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(new Error('HTTP response failed after headers were sent'));
      return;
    }
    const type = error instanceof Error && 'type' in error ? error.type : undefined;
    switch (type) {
      case 'entity.too.large':
        res
          .status(413)
          .json({ error: 'PAYLOAD_TOO_LARGE', message: 'JSON payload exceeds 16 KiB' });
        break;
      case 'entity.parse.failed':
        res.status(400).json({ error: 'INVALID_JSON', message: 'Malformed JSON request body' });
        break;
      case 'request.aborted':
      case 'request.size.invalid':
        res.status(400).json({ error: 'INVALID_REQUEST_BODY', message: 'Invalid request body' });
        break;
      case 'charset.unsupported':
      case 'encoding.unsupported':
        res.status(415).json({
          error: 'UNSUPPORTED_BODY_ENCODING',
          message: 'Unsupported JSON charset or content encoding',
        });
        break;
      default:
        console.error('Unhandled request error');
        res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
  };
  app.use(errorHandler);

  return { app, limiter };
}
