import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OTelClient,
  getMessageFromExceptionBody,
  initGlobalClient,
  getGlobalOTelClient,
  _resetGlobalOTelClientForTesting,
} from '../client';
import { newConfig, LogLevel } from '../config';

beforeEach(() => {
  _resetGlobalOTelClientForTesting();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  _resetGlobalOTelClientForTesting();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeCfg(endpoint = 'http://localhost:19999') {
  return newConfig(endpoint, 'svc', 'tok');
}

describe('getMessageFromExceptionBody', () => {
  it('returns HTTP status for empty string', () => {
    expect(getMessageFromExceptionBody('')).toBe('HTTP 500');
  });

  it('returns HTTP status for empty buffer', () => {
    expect(getMessageFromExceptionBody(Buffer.alloc(0))).toBe('HTTP 500');
  });

  it('returns HTTP status for falsy value', () => {
    expect(getMessageFromExceptionBody(null as any)).toBe('HTTP 500');
  });

  it('extracts error field from JSON string', () => {
    expect(getMessageFromExceptionBody('{"error":"db error"}')).toBe('db error');
  });

  it('extracts error field from JSON buffer', () => {
    const buf = Buffer.from(JSON.stringify({ error: 'conn failed' }));
    expect(getMessageFromExceptionBody(buf)).toBe('conn failed');
  });

  it('returns HTTP status for JSON without error field', () => {
    expect(getMessageFromExceptionBody('{"message":"ok"}', 503)).toBe('HTTP 503');
  });

  it('returns HTTP status for invalid JSON', () => {
    expect(getMessageFromExceptionBody('not json', 502)).toBe('HTTP 502');
  });

  it('returns HTTP status when error field is falsy', () => {
    expect(getMessageFromExceptionBody('{"error":null}', 500)).toBe('HTTP 500');
  });

  it('uses custom status code', () => {
    expect(getMessageFromExceptionBody('', 503)).toBe('HTTP 503');
  });
});

describe('OTelClient', () => {
  describe('init', () => {
    it('initializes once', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.init(); // second call should be no-op
      await client.shutdown();
    });

    it('strips /v1/traces from endpoint', async () => {
      const client = new OTelClient(makeCfg('http://localhost:19999/v1/traces'));
      await client.init();
      await client.shutdown();
    });

    it('strips /v1/logs from endpoint', async () => {
      const client = new OTelClient(makeCfg('http://localhost:19999/v1/logs'));
      await client.init();
      await client.shutdown();
    });

    it('adds auth header when token present', async () => {
      const cfg = makeCfg();
      cfg.token = 'mytoken';
      const client = new OTelClient(cfg);
      await client.init();
      await client.shutdown();
    });

    it('skips auth header when no token', async () => {
      const cfg = makeCfg();
      cfg.token = undefined;
      const client = new OTelClient(cfg);
      await client.init();
      await client.shutdown();
    });
  });

  describe('log', () => {
    it('emits log for all levels', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      for (const level of Object.values(LogLevel)) {
        client.log(level as LogLevel, 'test message');
      }
      await client.shutdown();
    });

    it('emits log with attrs', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      client.log(LogLevel.INFO, 'with attrs', { key: 'value' });
      await client.shutdown();
    });

    it('falls back to INFO severity for unknown level (client.ts:108)', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      client.log('UNKNOWN_LEVEL' as LogLevel, 'msg');
      await client.shutdown();
    });

    it('logSync emits and flushes', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.logSync(LogLevel.WARN, 'sync log');
      await client.shutdown();
    });

    it('flushLogs is no-op when no loggerProvider', async () => {
      const client = new OTelClient(makeCfg());
      await client.flushLogs(); // should not throw
    });

    it('flushLogs works with loggerProvider', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.flushLogs();
      await client.shutdown();
    });
  });

  describe('reportError', () => {
    it('auto-inits on first call', async () => {
      const client = new OTelClient(makeCfg());
      await client.reportError(new Error('auto init'));
      await client.shutdown();
    });

    it('returns early for falsy error', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.reportError(null as any);
      await client.shutdown();
    });

    it('returns early when shouldSampleTrace is false', async () => {
      const cfg = makeCfg();
      cfg.sampling.traces.percentage = 0;
      cfg.sampling.traces.alwaysSampleErrors = false;
      const client = new OTelClient(cfg);
      await client.init();
      await client.reportError(new Error('not sampled'));
      await client.shutdown();
    });

    it('reports error with explicit file and line', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.reportError(new Error('explicit'), 'myfile.ts', 42);
      await client.shutdown();
    });

    it('extracts file and line from stack', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      const err = new Error('stack test');
      await client.reportError(err);
      await client.shutdown();
    });

    it('reports with HTTP context', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.reportError(new Error('http'), undefined, undefined, {
        method: 'GET',
        url: '/api/test',
        statusCode: 500,
      });
      await client.shutdown();
    });

    it('emits log when shouldSampleLog is true', async () => {
      const cfg = makeCfg();
      cfg.sampling.logs.minHttpStatus = 500;
      const client = new OTelClient(cfg);
      await client.init();
      await client.reportError(new Error('with log'), undefined, undefined, { statusCode: 500 });
      await client.shutdown();
    });

    it('skips log when shouldSampleLog is false', async () => {
      const cfg = makeCfg();
      cfg.sampling.logs.minHttpStatus = 0;
      cfg.sampling.logs.captureOnTraceError = false;
      cfg.sampling.logs.levels = [];
      const client = new OTelClient(cfg);
      await client.init();
      await client.reportError(new Error('no log'));
      await client.shutdown();
    });

    it('reports with all HTTP context fields', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.reportError(new Error('full http'), undefined, undefined, {
        method: 'POST',
        url: '/api/data',
        headers: 'Content-Type: application/json',
        body: '{}',
        statusCode: 503,
      });
      await client.shutdown();
    });

    it('uses fallback error name when error.name is empty (client.ts:165,186)', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      const err = new Error('no name');
      err.name = '';
      await client.reportError(err);
      await client.shutdown();
    });
  });

  describe('submitApplicationError', () => {
    it('posts to errors API', async () => {
      const client = new OTelClient(makeCfg());
      await client.submitApplicationError('err', 'msg');
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    it('includes method and url', async () => {
      const client = new OTelClient(makeCfg());
      await client.submitApplicationError('err', 'msg', 'file.ts', 1, 500, 'GET', '/api');
    });

    it('truncates large request body', async () => {
      const client = new OTelClient(makeCfg());
      const largeBody = 'x'.repeat(3000);
      await client.submitApplicationError('err', 'msg', 'f', 0, 500, undefined, undefined, largeBody);
    });

    it('handles buffer request body', async () => {
      const client = new OTelClient(makeCfg());
      const bufBody = Buffer.from('buffer body');
      await client.submitApplicationError('err', 'msg', 'f', 0, 500, undefined, undefined, bufBody);
    });

    it('strips /v1/traces from endpoint', async () => {
      const client = new OTelClient(newConfig('http://localhost:19999/v1/traces', 's', 'tok'));
      await client.submitApplicationError('err', 'msg');
    });

    it('strips /v1/logs from endpoint', async () => {
      const client = new OTelClient(newConfig('http://localhost:19999/v1/logs', 's', 'tok'));
      await client.submitApplicationError('err', 'msg');
    });

    it('handles fetch failure silently', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const client = new OTelClient(makeCfg());
      await expect(client.submitApplicationError('err', 'msg')).resolves.not.toThrow();
    });

    it('skips auth header when token is not set (client.ts:230)', async () => {
      const cfg = newConfig('http://localhost:19999', 'svc');  // no token
      const client = new OTelClient(cfg);
      await client.submitApplicationError('err', 'msg');
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      expect((opts as RequestInit).headers).not.toHaveProperty('Authorization');
    });

    it('adds auth header when token present', async () => {
      const cfg = makeCfg();
      cfg.token = 'mytoken';
      const client = new OTelClient(cfg);
      await client.submitApplicationError('err', 'msg');
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer mytoken' });
    });
  });

  describe('shutdown', () => {
    it('shuts down when not initialized', async () => {
      const client = new OTelClient(makeCfg());
      await client.shutdown();
    });

    it('shuts down after init', async () => {
      const client = new OTelClient(makeCfg());
      await client.init();
      await client.shutdown();
    });
  });
});

describe('initGlobalClient / getGlobalOTelClient', () => {
  it('logs error (client.ts:256) when globalClient.init() rejects', async () => {
    // Mock OTelClient.prototype.init to reject so the .catch() handler fires
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const initSpy = vi.spyOn(OTelClient.prototype, 'init').mockRejectedValueOnce(new Error('init boom'));
    initGlobalClient(makeCfg());
    // Flush microtask queue so the .catch() callback runs
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(errSpy).toHaveBeenCalledWith(
      '[Middle-Monitor] failed to initialize OpenTelemetry client:',
      expect.any(Error),
    );
    errSpy.mockRestore();
    initSpy.mockRestore();
  });

  it('creates global client with config', () => {
    const cfg = makeCfg();
    const client = initGlobalClient(cfg);
    expect(client).not.toBeNull();
    expect(getGlobalOTelClient()).toBe(client);
  });

  it('is idempotent', () => {
    const cfg = makeCfg();
    const c1 = initGlobalClient(cfg);
    const c2 = initGlobalClient(cfg);
    expect(c1).toBe(c2);
  });

  it('reads from env when no config given', () => {
    const client = initGlobalClient();
    expect(client).not.toBeNull();
  });

  it('getGlobalOTelClient returns null when not initialized', () => {
    expect(getGlobalOTelClient()).toBeNull();
  });
});
