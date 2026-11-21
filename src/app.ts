import { isUtf8 } from 'node:buffer';
import { parse as parseContentType } from 'content-type';
import express, { type ErrorRequestHandler, type Response } from 'express';
import readBody from 'raw-body';
import type { AppConfig } from './config';
import { compileProxyTrust } from './ip';
import { SlidingWindowLimiter } from './limiter/sliding-window';
import { rateLimitMiddleware } from './middleware/rate-limit';

const JSON_LIMIT_BYTES = 16 * 1024;
const utf8 = new TextDecoder();

function isJsonContainer(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
}

function payloadTooLarge(res: Response): void {
  res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'JSON payload exceeds 16 KiB' });
}

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

  app.get('/api/demo', (_req, res) => {
    res.json({ message: 'Request accepted', ip: res.locals.clientIp });
  });

  app.post('/api/echo', async (req, res) => {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length === 0 && req.headers['transfer-encoding'] === undefined) {
      res.json({ message: 'Payload accepted', data: null });
      return;
    }
    if (length > JSON_LIMIT_BYTES) {
      res.set('Connection', 'close');
      payloadTooLarge(res);
      return;
    }

    const contentType = parseContentType(req.headers['content-type'] ?? '');
    if (contentType.type !== 'application/json') {
      res.set('Connection', 'close').status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json',
      });
      return;
    }

    const charset = contentType.parameters.charset?.toLowerCase() ?? 'utf-8';
    const encoding = req.headers['content-encoding']?.toLowerCase() ?? 'identity';
    if ((charset !== 'utf-8' && charset !== 'utf8') || encoding !== 'identity') {
      if (encoding !== 'identity') res.set('Accept-Encoding', 'identity');
      res.set('Connection', 'close').status(415).json({
        error: 'UNSUPPORTED_BODY_ENCODING',
        message: 'JSON must be uncompressed UTF-8',
      });
      return;
    }

    if (res.locals.expectContinue === true) res.writeContinue();
    const bytes = await readBody(req, {
      length: req.headers['content-length'] ?? null,
      limit: JSON_LIMIT_BYTES,
    });
    if (bytes.length === 0) {
      res.json({ message: 'Payload accepted', data: null });
      return;
    }
    const text = isUtf8(bytes) ? utf8.decode(bytes) : '';
    if (!isJsonContainer(text)) {
      res
        .status(400)
        .json({ error: 'INVALID_JSON', message: 'Expected a UTF-8 JSON object or array' });
      return;
    }

    // Embed the validated JSON value without rounding numbers or reserializing deeply nested data.
    res.type('application/json').send(`{"message":"Payload accepted","data":${text}}`);
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
        res.set('Connection', 'close');
        payloadTooLarge(res);
        break;
      case 'request.aborted':
      case 'request.size.invalid':
        res.status(400).json({ error: 'INVALID_REQUEST_BODY', message: 'Invalid request body' });
        break;
      default:
        console.error('Unhandled request error');
        res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
  };
  app.use(errorHandler);

  return { app, limiter };
}
