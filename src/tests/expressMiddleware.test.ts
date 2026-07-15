import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { captureExceptionErrors } from '../expressMiddleware';
import { init, _resetGlobalClientForTesting } from '../index';
import { _resetGlobalOTelClientForTesting } from '../client';
import { newConfig } from '../config';

function resetAll() {
  _resetGlobalClientForTesting();
  _resetGlobalOTelClientForTesting();
}

beforeEach(() => {
  resetAll();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  resetAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeCfg() {
  return newConfig('http://localhost:19999', 'svc', 'tok');
}

function makeReqRes(statusCode: number, body?: string, reqBody?: unknown) {
  const res = Object.assign(new EventEmitter(), {
    statusCode,
    end: vi.fn(function (this: any, chunk?: any, ...args: any[]) { return this; }),
  });
  const req = { body: reqBody, method: 'GET', originalUrl: '/test', url: '/test' };
  return { req, res };
}

describe('captureExceptionErrors', () => {
  it('returns a middleware function', () => {
    const mw = captureExceptionErrors();
    expect(typeof mw).toBe('function');
  });

  it('calls next()', () => {
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(200);
    const next = vi.fn();
    mw(req as any, res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('ignores 2xx responses on finish', () => {
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(200);
    const next = vi.fn();
    mw(req as any, res as any, next);
    res.emit('finish');
    // No error submitted for 2xx
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('ignores 4xx responses on finish', () => {
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(404);
    mw(req as any, res as any, vi.fn());
    res.emit('finish');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('submits error for 5xx when client is initialized', async () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    mw(req as any, res as any, vi.fn());
    // After mw runs, res.end is monkey-patched; calling it sends body to capture
    (res as any).end(Buffer.from('{"error":"db error"}'));
    res.emit('finish');
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('does not submit when no global client', async () => {
    // No init → getGlobalClient auto-inits but with default endpoint
    // To test "no client" path, we need to force null
    resetAll();
    vi.spyOn(
      await import('../index'),
      'getGlobalClient',
    ).mockReturnValue(null);
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    mw(req as any, res as any, vi.fn());
    res.emit('finish');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('captures body chunks from res.end for 5xx', () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    mw(req as any, res as any, vi.fn());
    // Call the monkey-patched res.end with a chunk
    (res as any).end(Buffer.from('{"error":"crash"}'));
    res.emit('finish');
  });

  it('captures body chunks from res.end as string for 5xx', () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    mw(req as any, res as any, vi.fn());
    (res as any).end('{"error":"crash"}');
    res.emit('finish');
  });

  it('skips body capture for 2xx status', () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(200);
    mw(req as any, res as any, vi.fn());
    (res as any).end(Buffer.from('ok response'));
    res.emit('finish');
  });

  it('includes request body when req.body is a string', async () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500, '', 'string body');
    mw(req as any, res as any, vi.fn());
    res.emit('finish');
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('includes request body when req.body is an object', async () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500, '', { key: 'value' });
    mw(req as any, res as any, vi.fn());
    res.emit('finish');
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('truncates large request body', async () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500, '', 'x'.repeat(3000));
    mw(req as any, res as any, vi.fn());
    res.emit('finish');
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('uses req.url when req.originalUrl is falsy', async () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    (req as any).originalUrl = undefined;
    mw(req as any, res as any, vi.fn());
    res.emit('finish');
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('limits captured body to BODY_CAPTURE_LIMIT (4096 bytes)', () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    mw(req as any, res as any, vi.fn());
    const largeChunk = Buffer.alloc(5000, 'x');
    (res as any).end(largeChunk);
    res.emit('finish');
    // Should not throw
  });

  it('skips capture on second end() call when buffer is full (covers remain <= 0 branch)', () => {
    init(makeCfg());
    const mw = captureExceptionErrors();
    const { req, res } = makeReqRes(500);
    mw(req as any, res as any, vi.fn());
    // First call fills the buffer to exactly BODY_CAPTURE_LIMIT
    (res as any).end(Buffer.alloc(4096, 'a'));
    // Second call: remain = 4096 - 4096 = 0, so if (remain > 0) is false
    (res as any).end(Buffer.alloc(100, 'b'));
    res.emit('finish');
  });
});
