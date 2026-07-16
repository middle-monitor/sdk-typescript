import { InvalidConfigValueError } from './errors';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL',
  PANIC = 'PANIC',
}

export interface TracesSamplingConfig {
  // -1 = auto (100 % in dev, 20 % in prod); 0.0–1.0 for an explicit rate
  percentage: number;
  alwaysSampleErrors: boolean;
  alwaysSampleRoutes: string[];
  neverSampleRoutes: string[];
}

export interface LogsSamplingConfig {
  levels: LogLevel[];
  minHttpStatus: number;
  captureOnTraceError: boolean;
  alwaysCaptureRoutes: string[];
  neverCaptureRoutes: string[];
}

export interface SamplingConfig {
  traces: TracesSamplingConfig;
  logs: LogsSamplingConfig;
}

export interface Config {
  endpoint: string;
  // Derived from http:// scheme or localhost; disables TLS verification.
  insecure: boolean;
  service: string;
  token?: string;
  // Export protocol: 'http' (default) or 'grpc'
  protocol: string;
  sampling: SamplingConfig;
  // Timeout in milliseconds for OTLP exports (default: 5000)
  timeout: number;
}

export function defaultSamplingConfig(): SamplingConfig {
  const percentage = 0.1;
  return {
    traces: {
      percentage,
      alwaysSampleErrors: true,
      alwaysSampleRoutes: [],
      neverSampleRoutes: ['/health', '/metrics', '/ready', '/healthz', '/readyz'],
    },
    logs: {
      levels: [LogLevel.ERROR, LogLevel.FATAL, LogLevel.PANIC],
      minHttpStatus: 500,
      captureOnTraceError: true,
      alwaysCaptureRoutes: [],
      neverCaptureRoutes: ['/health', '/metrics', '/ready', '/healthz', '/readyz'],
    },
  };
}

export function newConfig(
  endpoint: string,
  service: string,
  token?: string,
): Config {
  const ep = (endpoint || 'https://api.middlemonitor.io').replace(/\/$/, '');
  return {
    endpoint: ep,
    insecure: ep.startsWith('http://'),
    service,
    token,
    protocol: 'http',
    sampling: defaultSamplingConfig(),
    timeout: 5000,
  };
}

export function configFromEnv(): Config {
  const endpoint =
    process.env.MIDDLE_MONITOR_API_URL ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    'https://api.middlemonitor.io';

  const service =
    process.env.MIDDLE_MONITOR_SERVICE ||
    process.env.OTEL_SERVICE_NAME ||
    'unknown';

  let token = process.env.MIDDLE_MONITOR_TOKEN;
  if (!token) {
    const headersStr = process.env.OTEL_EXPORTER_OTLP_HEADERS || '';
    if (headersStr.includes('=')) {
      for (const part of headersStr.split(',')) {
        const [k, v] = part.trim().split('=', 2);
        if (k?.toLowerCase() === 'authorization' && v) {
          token = v.replace(/^Bearer /, '');
          break;
        }
      }
    }
  }

  const protocol =
    process.env.MIDDLE_MONITOR_PROTOCOL ||
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL ||
    'http';

  const cfg = newConfig(endpoint, service, token);
  cfg.protocol = protocol;

  const tracesPctStr = process.env.MIDDLE_MONITOR_TRACES_SAMPLING;
  if (tracesPctStr !== undefined) {
    const pct = parseFloat(tracesPctStr);
    if (pct < -1 || pct > 1 || isNaN(pct)) {
      throw new InvalidConfigValueError(`MIDDLE_MONITOR_TRACES_SAMPLING must be between -1 and 1, got ${tracesPctStr}`);
    }
    cfg.sampling.traces.percentage = pct;
  }

  const logsLevelsStr = process.env.MIDDLE_MONITOR_LOGS_LEVELS;
  if (logsLevelsStr) {
    const levels: LogLevel[] = [];
    for (const lvl of logsLevelsStr.split(',')) {
      const upper = lvl.trim().toUpperCase() as LogLevel;
      if (!Object.values(LogLevel).includes(upper)) {
        throw new InvalidConfigValueError(`Invalid log level in MIDDLE_MONITOR_LOGS_LEVELS: ${lvl}`);
      }
      levels.push(upper);
    }
    if (levels.length > 0) {
      cfg.sampling.logs.levels = levels;
    }
  }

  const minStatusStr = process.env.MIDDLE_MONITOR_LOGS_MIN_HTTP_STATUS;
  if (minStatusStr) {
    cfg.sampling.logs.minHttpStatus = parseInt(minStatusStr, 10);
  }

  return cfg;
}

export function shouldSampleTrace(cfg: Config, route: string, hasError: boolean): boolean {
  const traces = cfg.sampling.traces;

  for (const pattern of traces.neverSampleRoutes) {
    if (matchesRoute(route, pattern)) {
      if (traces.alwaysSampleErrors && hasError) return true;
      return false;
    }
  }

  for (const pattern of traces.alwaysSampleRoutes) {
    if (matchesRoute(route, pattern)) return true;
  }

  if (traces.alwaysSampleErrors && hasError) return true;

  let pct = traces.percentage;
  if (pct < 0) {
    pct = defaultSamplingConfig().traces.percentage;
  }

  if (pct >= 1.0) return true;
  if (pct <= 0) return false;
  return Math.random() < pct;
}

export function shouldSampleLog(
  cfg: Config,
  route: string,
  level: LogLevel,
  httpStatus: number,
  traceHasError: boolean,
): boolean {
  const logs = cfg.sampling.logs;

  for (const pattern of logs.neverCaptureRoutes) {
    if (matchesRoute(route, pattern)) {
      if (logs.minHttpStatus > 0 && httpStatus >= logs.minHttpStatus) return true;
      return false;
    }
  }

  for (const pattern of logs.alwaysCaptureRoutes) {
    if (matchesRoute(route, pattern)) return true;
  }

  if (logs.minHttpStatus > 0 && httpStatus >= logs.minHttpStatus) return true;
  if (logs.levels.includes(level)) return true;
  if (logs.captureOnTraceError && traceHasError) return true;

  return false;
}

function matchesRoute(route: string, pattern: string): boolean {
  if (route === pattern) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return regex.test(route);
  }
  return false;
}
