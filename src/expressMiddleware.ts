/**
 * Express middleware to capture server error (5xx) responses and submit the error message
 * to the Middle-Monitor Errors API (so "Contexte / Corrélation" shows the real cause).
 *
 * Usage:
 *   import { captureExceptionErrors } from '@middle-monitor/sdk/expressMiddleware';
 *   app.use(captureExceptionErrors());
 *
 * Requires: npm install express (peer dependency)
 */

import type { Request, Response, NextFunction } from 'express';
import { getGlobalClient } from './index';
import { getMessageFromExceptionBody } from './client';

const BODY_CAPTURE_LIMIT = 4096;

export function captureExceptionErrors() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const chunks: Buffer[] = [];
    let length = 0;
    const originalEnd = res.end;
    res.end = function (this: Response, chunk?: unknown, ...args: unknown[]): Response {
      if (res.statusCode >= 500 && chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const remain = BODY_CAPTURE_LIMIT - length;
        if (remain > 0) {
          chunks.push(buf.slice(0, remain));
          length += chunks[chunks.length - 1].length;
        }
      }
      return (originalEnd as Function).apply(this, [chunk, ...args]);
    };
    res.on('finish', () => {
      if (res.statusCode < 500) return;
      const client = getGlobalClient();
      if (!client) return;
      const body = chunks.length ? Buffer.concat(chunks) : Buffer.from('');
      const message = getMessageFromExceptionBody(body, res.statusCode);
      let requestBody: string | Buffer | undefined;
      if (req.body !== undefined) {
        const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        requestBody = raw.length > 2000 ? raw.slice(0, 2000) + '...' : raw;
      }
      client
        .submitApplicationError(
          'http',
          message,
          'handler',
          0,
          res.statusCode,
          req.method,
          req.originalUrl || req.url,
          requestBody
        )
        .catch(() => {});
    });
    next();
  };
}
