import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LogLevel,
  defaultSamplingConfig,
  newConfig,
  configFromEnv,
  shouldSampleTrace,
  shouldSampleLog,
} from '../config';

describe('LogLevel', () => {
  it('has correct values', () => {
    expect(LogLevel.DEBUG).toBe('DEBUG');
    expect(LogLevel.INFO).toBe('INFO');
    expect(LogLevel.WARN).toBe('WARN');
    expect(LogLevel.ERROR).toBe('ERROR');
    expect(LogLevel.FATAL).toBe('FATAL');
    expect(LogLevel.PANIC).toBe('PANIC');
  });
});

describe('defaultSamplingConfig', () => {
  it('returns the default 10% trace sampling', () => {
    expect(defaultSamplingConfig().traces.percentage).toBe(0.1);
  });
  it('includes default never-sample routes', () => {
    const cfg = defaultSamplingConfig();
    expect(cfg.traces.neverSampleRoutes).toContain('/health');
    expect(cfg.logs.neverCaptureRoutes).toContain('/metrics');
  });
});

describe('newConfig', () => {
  it('creates config with all fields', () => {
    const cfg = newConfig('http://host:8080', 'svc', 'tok');
    expect(cfg.endpoint).toBe('http://host:8080');
    expect(cfg.service).toBe('svc');
    expect(cfg.token).toBe('tok');
    expect(cfg.insecure).toBe(true);
    expect(cfg.protocol).toBe('http');
    expect(cfg.timeout).toBe(5000);
  });

  it('strips trailing slash', () => {
    const cfg = newConfig('http://host:8080/', 'svc');
    expect(cfg.endpoint).toBe('http://host:8080');
  });

  it('defaults to api.middlemonitor.io for empty endpoint', () => {
    const cfg = newConfig('', 'svc');
    expect(cfg.endpoint).toBe('https://api.middlemonitor.io');
  });

  it('sets insecure=false for https', () => {
    const cfg = newConfig('https://host:4318', 'svc');
    expect(cfg.insecure).toBe(false);
  });
});

describe('configFromEnv', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    delete process.env.MIDDLE_MONITOR_API_URL;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.MIDDLE_MONITOR_SERVICE;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.MIDDLE_MONITOR_TOKEN;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.MIDDLE_MONITOR_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    delete process.env.MIDDLE_MONITOR_TRACES_SAMPLING;
    delete process.env.MIDDLE_MONITOR_LOGS_LEVELS;
    delete process.env.MIDDLE_MONITOR_LOGS_MIN_HTTP_STATUS;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('returns defaults when no env vars set', () => {
    const cfg = configFromEnv();
    expect(cfg.endpoint).toBe('https://api.middlemonitor.io');
    expect(cfg.service).toBe('unknown');
  });

  it('reads MIDDLE_MONITOR_API_URL', () => {
    process.env.MIDDLE_MONITOR_API_URL = 'http://custom:9090';
    expect(configFromEnv().endpoint).toBe('http://custom:9090');
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    expect(configFromEnv().endpoint).toBe('http://otel:4318');
  });

  it('reads service from OTEL_SERVICE_NAME', () => {
    process.env.OTEL_SERVICE_NAME = 'my-svc';
    expect(configFromEnv().service).toBe('my-svc');
  });

  it('reads token from MIDDLE_MONITOR_TOKEN', () => {
    process.env.MIDDLE_MONITOR_TOKEN = 'mytoken';
    expect(configFromEnv().token).toBe('mytoken');
  });

  it('extracts token from OTEL_EXPORTER_OTLP_HEADERS', () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer secret123,x-other=val';
    expect(configFromEnv().token).toBe('secret123');
  });

  it('ignores OTLP headers without authorization key', () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-other=val';
    expect(configFromEnv().token).toBeUndefined();
  });

  it('ignores OTLP headers without = sign', () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'noequals';
    expect(configFromEnv().token).toBeUndefined();
  });

  it('reads protocol from OTEL_EXPORTER_OTLP_PROTOCOL', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    expect(configFromEnv().protocol).toBe('grpc');
  });

  it('reads traces sampling', () => {
    process.env.MIDDLE_MONITOR_TRACES_SAMPLING = '0.5';
    expect(configFromEnv().sampling.traces.percentage).toBe(0.5);
  });

  it('throws on invalid traces sampling', () => {
    process.env.MIDDLE_MONITOR_TRACES_SAMPLING = '2.0';
    expect(() => configFromEnv()).toThrow('MIDDLE_MONITOR_TRACES_SAMPLING');
  });

  it('throws on NaN traces sampling', () => {
    process.env.MIDDLE_MONITOR_TRACES_SAMPLING = 'notanumber';
    expect(() => configFromEnv()).toThrow();
  });

  it('reads logs levels', () => {
    process.env.MIDDLE_MONITOR_LOGS_LEVELS = 'DEBUG,WARN';
    const cfg = configFromEnv();
    expect(cfg.sampling.logs.levels).toContain(LogLevel.DEBUG);
    expect(cfg.sampling.logs.levels).toContain(LogLevel.WARN);
  });

  it('throws on invalid log level', () => {
    process.env.MIDDLE_MONITOR_LOGS_LEVELS = 'INVALID';
    expect(() => configFromEnv()).toThrow('Invalid log level');
  });

  it('reads min http status', () => {
    process.env.MIDDLE_MONITOR_LOGS_MIN_HTTP_STATUS = '400';
    expect(configFromEnv().sampling.logs.minHttpStatus).toBe(400);
  });
});

describe('shouldSampleTrace', () => {
  const makeCfg = (overrides: Partial<ReturnType<typeof newConfig>['sampling']['traces']> = {}) => {
    const cfg = newConfig('http://h', 'svc');
    Object.assign(cfg.sampling.traces, overrides);
    return cfg;
  };

  it('returns false for never-sample route without error', () => {
    const cfg = makeCfg({ neverSampleRoutes: ['/health'] });
    expect(shouldSampleTrace(cfg, '/health', false)).toBe(false);
  });

  it('returns true for never-sample route with error and alwaysSampleErrors', () => {
    const cfg = makeCfg({ neverSampleRoutes: ['/health'], alwaysSampleErrors: true });
    expect(shouldSampleTrace(cfg, '/health', true)).toBe(true);
  });

  it('returns false for never-sample route with error but alwaysSampleErrors=false', () => {
    const cfg = makeCfg({ neverSampleRoutes: ['/health'], alwaysSampleErrors: false });
    expect(shouldSampleTrace(cfg, '/health', true)).toBe(false);
  });

  it('returns true for always-sample route', () => {
    const cfg = makeCfg({ alwaysSampleRoutes: ['/admin'], percentage: 0 });
    expect(shouldSampleTrace(cfg, '/admin', false)).toBe(true);
  });

  it('returns true when alwaysSampleErrors and hasError', () => {
    const cfg = makeCfg({ percentage: 0, alwaysSampleErrors: true });
    expect(shouldSampleTrace(cfg, '/api', true)).toBe(true);
  });

  it('returns true when percentage >= 1', () => {
    const cfg = makeCfg({ percentage: 1.0 });
    expect(shouldSampleTrace(cfg, '/api', false)).toBe(true);
  });

  it('returns false when percentage <= 0 and no error', () => {
    const cfg = makeCfg({ percentage: 0, alwaysSampleErrors: false });
    expect(shouldSampleTrace(cfg, '/api', false)).toBe(false);
  });

  it('resolves auto (-1) percentage and always samples errors', () => {
    const cfg = newConfig('http://h', 'svc');
    cfg.sampling.traces.percentage = -1;
    // Auto resolves to the default percentage; errors are always sampled.
    expect(shouldSampleTrace(cfg, '/api', true)).toBe(true);
  });

  it('samples randomly when 0 < percentage < 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const cfg = makeCfg({ percentage: 0.5, alwaysSampleErrors: false });
    expect(shouldSampleTrace(cfg, '/api', false)).toBe(true);
    vi.restoreAllMocks();
  });

  it('drops randomly when 0 < percentage < 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const cfg = makeCfg({ percentage: 0.5, alwaysSampleErrors: false });
    expect(shouldSampleTrace(cfg, '/api', false)).toBe(false);
    vi.restoreAllMocks();
  });

  it('matches wildcard routes', () => {
    const cfg = makeCfg({ neverSampleRoutes: ['/api/users/*'] });
    expect(shouldSampleTrace(cfg, '/api/users/123', false)).toBe(false);
  });

  it('skips always-sample route when route does not match (covers false branch in alwaysSampleRoutes loop)', () => {
    // alwaysSampleRoutes has a pattern that does NOT match the route → loop exits without returning true
    const cfg = makeCfg({ alwaysSampleRoutes: ['/admin'], percentage: 0, alwaysSampleErrors: false, neverSampleRoutes: [] });
    expect(shouldSampleTrace(cfg, '/other', false)).toBe(false);
  });
});

describe('shouldSampleLog', () => {
  const makeCfg = (overrides: Partial<ReturnType<typeof newConfig>['sampling']['logs']> = {}) => {
    const cfg = newConfig('http://h', 'svc');
    Object.assign(cfg.sampling.logs, overrides);
    return cfg;
  };

  it('returns false for never-capture route below status', () => {
    const cfg = makeCfg({ neverCaptureRoutes: ['/health'], minHttpStatus: 500 });
    expect(shouldSampleLog(cfg, '/health', LogLevel.INFO, 200, false)).toBe(false);
  });

  it('returns true for never-capture route above status', () => {
    const cfg = makeCfg({ neverCaptureRoutes: ['/health'], minHttpStatus: 500 });
    expect(shouldSampleLog(cfg, '/health', LogLevel.INFO, 500, false)).toBe(true);
  });

  it('returns false for never-capture route when minHttpStatus=0', () => {
    const cfg = makeCfg({ neverCaptureRoutes: ['/health'], minHttpStatus: 0 });
    expect(shouldSampleLog(cfg, '/health', LogLevel.ERROR, 500, false)).toBe(false);
  });

  it('returns true for always-capture route', () => {
    const cfg = makeCfg({ alwaysCaptureRoutes: ['/api'], minHttpStatus: 500 });
    expect(shouldSampleLog(cfg, '/api', LogLevel.DEBUG, 200, false)).toBe(true);
  });

  it('returns true when minHttpStatus hit', () => {
    const cfg = makeCfg({ minHttpStatus: 500 });
    expect(shouldSampleLog(cfg, '/api', LogLevel.DEBUG, 500, false)).toBe(true);
  });

  it('returns true when level matches', () => {
    const cfg = makeCfg({ levels: [LogLevel.ERROR], minHttpStatus: 500 });
    expect(shouldSampleLog(cfg, '/api', LogLevel.ERROR, 200, false)).toBe(true);
  });

  it('returns true when captureOnTraceError', () => {
    const cfg = makeCfg({ captureOnTraceError: true, minHttpStatus: 500 });
    expect(shouldSampleLog(cfg, '/api', LogLevel.DEBUG, 200, true)).toBe(true);
  });

  it('returns false when nothing matches', () => {
    const cfg = makeCfg({
      levels: [LogLevel.ERROR],
      minHttpStatus: 500,
      captureOnTraceError: false,
    });
    expect(shouldSampleLog(cfg, '/api', LogLevel.INFO, 200, false)).toBe(false);
  });

  it('skips always-capture route when route does not match (covers false branch in alwaysCaptureRoutes loop)', () => {
    // alwaysCaptureRoutes has a pattern that does NOT match the route
    const cfg = makeCfg({
      alwaysCaptureRoutes: ['/admin'],
      neverCaptureRoutes: [],
      minHttpStatus: 500,
      captureOnTraceError: false,
      levels: [],
    });
    expect(shouldSampleLog(cfg, '/other', LogLevel.DEBUG, 200, false)).toBe(false);
  });
});
