import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { NodeSDK } from '@opentelemetry/sdk-node';
// -proto exporters: the backend OTLP endpoints only accept application/x-protobuf
// (backend/api/otlp_handlers.go rejects JSON with 415), matching the Go/Python/Rust SDKs.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { logs as logsApi, SeverityNumber } from '@opentelemetry/api-logs';

import {
  Config,
  LogLevel,
  configFromEnv,
  shouldSampleTrace,
  shouldSampleLog,
} from './config';

let globalClient: OTelClient | null = null;

export function getMessageFromExceptionBody(body: string | Buffer, statusCode = 500): string {
  if (!body || (Buffer.isBuffer(body) && body.length === 0)) {
    return `HTTP ${statusCode}`;
  }
  try {
    const raw = typeof body === 'string' ? body : body.toString('utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.error) {
      return String(data.error);
    }
  } catch {
    // ignore parse errors
  }
  return `HTTP ${statusCode}`;
}

export class OTelClient {
  private config: Config;
  private sdk: NodeSDK | null = null;
  private loggerProvider: LoggerProvider | null = null;
  private tracer = trace.getTracer('middle-monitor-sdk');
  private logger = logsApi.getLogger('middle-monitor-sdk');
  private initialized = false;

  constructor(config: Config) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: this.config.service,
    });

    let endpoint = this.config.endpoint.replace(/\/$/, '');
    if (endpoint.endsWith('/v1/traces')) endpoint = endpoint.slice(0, -'/v1/traces'.length);
    else if (endpoint.endsWith('/v1/logs')) endpoint = endpoint.slice(0, -'/v1/logs'.length);

    const headers: Record<string, string> = {};
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    const traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
      timeoutMillis: this.config.timeout,
    });

    const logExporter = new OTLPLogExporter({
      url: `${endpoint}/v1/logs`,
      headers,
      timeoutMillis: this.config.timeout,
    });

    this.loggerProvider = new LoggerProvider({ resource });
    this.loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
    logsApi.setGlobalLoggerProvider(this.loggerProvider);
    this.logger = this.loggerProvider.getLogger('middle-monitor-sdk');

    // AlwaysOnSampler: sampling decisions are made in shouldSampleTrace() before span creation.
    this.sdk = new NodeSDK({
      resource,
      traceExporter,
      sampler: new AlwaysOnSampler(),
    });

    this.sdk.start();
    this.tracer = trace.getTracer('middle-monitor-sdk');
    this.initialized = true;
  }

  log(level: LogLevel, message: string, attrs?: Record<string, string>): void {
    const severityMap: Record<LogLevel, SeverityNumber> = {
      [LogLevel.DEBUG]: SeverityNumber.DEBUG,
      [LogLevel.INFO]: SeverityNumber.INFO,
      [LogLevel.WARN]: SeverityNumber.WARN,
      [LogLevel.ERROR]: SeverityNumber.ERROR,
      [LogLevel.FATAL]: SeverityNumber.FATAL,
      [LogLevel.PANIC]: SeverityNumber.FATAL,
    };
    this.logger.emit({
      severityNumber: severityMap[level] ?? SeverityNumber.INFO,
      severityText: level,
      body: message,
      attributes: {
        'service.name': this.config.service,
        ...attrs,
      },
    });
  }

  async logSync(level: LogLevel, message: string, attrs?: Record<string, string>): Promise<void> {
    this.log(level, message, attrs);
    await this.flushLogs();
  }

  async flushLogs(timeoutMs = 5000): Promise<void> {
    if (this.loggerProvider) {
      await this.loggerProvider.forceFlush();
    }
  }

  async reportError(
    error: Error,
    file?: string,
    line?: number,
    httpContext?: {
      method?: string;
      url?: string;
      headers?: string;
      body?: string;
      statusCode?: number;
    },
  ): Promise<void> {
    if (!this.initialized) await this.init();
    if (!error) return;

    let errorFile = file;
    let errorLine = line;
    if (!errorFile || !errorLine) {
      const match = error.stack?.match(/at .+ \((.+):(\d+):\d+\)/);
      if (match) {
        errorFile = errorFile || match[1];
        errorLine = errorLine || parseInt(match[2], 10);
      }
    }

    const route = httpContext?.url || '';
    const httpStatus = httpContext?.statusCode || 0;
    const hasError = true;

    if (!shouldSampleTrace(this.config, route, hasError)) return;

    const span = this.tracer.startSpan('error.report', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'error.message': error.message,
        'error.type': error.name || 'Error',
        'error.file': errorFile || 'unknown',
        'error.line': errorLine || 0,
        'service.name': this.config.service,
      },
    });

    if (httpContext?.method) span.setAttribute('http.method', httpContext.method);
    if (httpContext?.url) span.setAttribute('http.url', httpContext.url);
    if (httpContext?.statusCode) span.setAttribute('http.status_code', httpContext.statusCode);

    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error);

    if (shouldSampleLog(this.config, route, LogLevel.ERROR, httpStatus, hasError)) {
      this.logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: error.message,
        attributes: {
          'error.name': error.name || 'Error',
          'error.message': error.message,
          'error.file': errorFile || 'unknown',
          'error.line': errorLine || 0,
          'service.name': this.config.service,
            ...(httpContext?.method && { 'http.method': httpContext.method }),
          ...(httpContext?.url && { 'http.url': httpContext.url }),
          ...(httpContext?.statusCode && { 'http.status_code': httpContext.statusCode }),
        },
      });
    }

    span.end();
  }

  async submitApplicationError(
    name: string,
    message: string,
    file = 'handler',
    line = 0,
    statusCode = 500,
    method?: string,
    url?: string,
    requestBody?: string | Buffer,
  ): Promise<void> {
    let base = this.config.endpoint.replace(/\/$/, '');
    if (base.endsWith('/v1/traces') || base.endsWith('/v1/logs')) {
      base = base.replace(/\/v1\/(traces|logs)$/, '');
    }
    const apiUrl = `${base}/api/v1/errors`;
    const payload: Record<string, unknown> = {
      name, message, file, line,
      timestamp: new Date().toISOString(),
      service: this.config.service,
    };
    if (method) payload.http_method = method;
    if (url) payload.http_url = url;
    if (requestBody !== undefined) {
      const bodyStr = typeof requestBody === 'string' ? requestBody : requestBody.toString('utf-8');
      payload.http_body = bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + '...' : bodyStr;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.token) headers['Authorization'] = `Bearer ${this.config.token}`;
    try {
      await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // fire-and-forget
    }
  }

  async shutdown(): Promise<void> {
    await this.flushLogs();
    if (this.sdk) await this.sdk.shutdown();
    if (this.loggerProvider) await this.loggerProvider.shutdown();
    this.initialized = false;
  }
}

export function initGlobalClient(cfg?: Config): OTelClient {
  if (globalClient) return globalClient;
  const resolvedCfg = cfg ?? configFromEnv();
  globalClient = new OTelClient(resolvedCfg);
  globalClient.init().catch(err => {
    console.error('[Middle-Monitor] failed to initialize OpenTelemetry client:', err);
  });
  return globalClient;
}

export function getGlobalOTelClient(): OTelClient | null {
  return globalClient;
}

export function _resetGlobalOTelClientForTesting(): void {
  globalClient = null;
}
