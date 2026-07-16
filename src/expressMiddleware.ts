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
import {
  context as otelContext,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';
import { getGlobalClient } from './index';
import { getMessageFromExceptionBody } from './client';
import { shouldSampleTrace } from './config';

const BODY_CAPTURE_LIMIT = 4096;

/**
 * Full Express instrumentation, mirroring the Go SDK's Echo/Gin/HTTP middlewares:
 * one span per request (W3C trace context extracted from headers, active context
 * propagated to handlers), error status on 4xx/5xx, an error span for 5xx on
 * never-sampled routes, plus the 5xx submission of captureExceptionErrors.
 *
 * Usage:
 *   import { expressMiddleware } from '@middle-monitor/sdk/expressMiddleware';
 *   app.use(expressMiddleware());
 *
 * Supersedes captureExceptionErrors(); use one or the other, not both.
 */
export function expressMiddleware() {
  const capture = captureExceptionErrors();
  return (req: Request, res: Response, next: NextFunction): void => {
    const client = getGlobalClient();
    if (!client) {
      next();
      return;
    }
    const cfg = client.config;

    // Express resolves the route template after routing; the raw path is the route.
    const route = req.path || req.url || '/';
    const method = req.method;
    const url = req.originalUrl || req.url;

    const tracer = trace.getTracer('middle-monitor-sdk');
    const parentCtx = propagation.extract(otelContext.active(), req.headers);
    const sampled = shouldSampleTrace(cfg, route, false);

    let span: Span | undefined;
    if (sampled) {
      span = tracer.startSpan(
        `${method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes: { 'http.method': method, 'http.route': route, 'http.url': url },
        },
        parentCtx,
      );
    }

    res.on('finish', () => {
      const status = res.statusCode;
      const hasError = status >= 400;
      const isServerError = status >= 500;
      if (span) {
        span.setAttributes({ 'http.status_code': status, error: hasError });
        span.setStatus(
          hasError
            ? { code: SpanStatusCode.ERROR, message: `HTTP ${status}` }
            : { code: SpanStatusCode.OK },
        );
        span.end();
      } else if (isServerError && shouldSampleTrace(cfg, route, true)) {
        // Never-sampled route (e.g. /health) that failed: still export an error span
        const errorSpan = tracer.startSpan(
          `${method} ${route}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'http.method': method,
              'http.route': route,
              'http.url': url,
              'http.status_code': status,
              error: true,
            },
          },
          parentCtx,
        );
        errorSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
        errorSpan.end();
      }
    });

    if (span) {
      otelContext.with(trace.setSpan(parentCtx, span), () => capture(req, res, next));
    } else {
      capture(req, res, next);
    }
  };
}

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
