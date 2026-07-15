import { Config, LogLevel, newConfig, configFromEnv } from './config';
import { OTelClient, getMessageFromExceptionBody } from './client';

export { getMessageFromExceptionBody };

export class MiddleMonitorClient {
  private otelClient: OTelClient;
  readonly config: Config;

  constructor(cfg: Config) {
    this.config = cfg;
    this.otelClient = new OTelClient(cfg);
    this.otelClient.init().catch(err => {
      console.error('[Middle-Monitor] failed to initialize OpenTelemetry client:', err);
    });
  }

  setToken(token: string): void {
    this.config.token = token;
  }

  private isApplicationError(stack: string): boolean {
    if (!stack) return false;
    const frameworkPaths = [
      'node_modules', '.next/', 'dist/', 'build/',
      'vendor/', 'lib/', 'packages/', '.nuxt/', '.vite/',
    ];
    for (const line of stack.split('\n')) {
      const match =
        line.match(/at .+ \((.+):(\d+):\d+\)/) ||
        line.match(/at (.+):(\d+):\d+/) ||
        line.match(/\((.+):(\d+):\d+\)/);
      if (match?.[1]) {
        const filename = match[1];
        if (!frameworkPaths.some(p => filename.includes(p))) {
          if (!filename.includes('_test.') && !filename.includes('.gen.') && !filename.includes('.spec.')) {
            return true;
          }
        }
      }
    }
    return false;
  }

  async reportError(error: Error, file?: string, line?: number): Promise<void> {
    if (!error) return;
    if (error.stack && !this.isApplicationError(error.stack)) return;
    await this.otelClient.reportError(error, file, line);
  }

  async reportErrorWithDetails(error: Error, file: string, line: number): Promise<void> {
    await this.otelClient.reportError(error, file, line);
  }

  async reportCustomError(name: string, message: string, file: string, line: number): Promise<void> {
    const error = new Error(message);
    error.name = name;
    await this.otelClient.reportError(error, file, line);
  }

  async reportCustomErrorWithHTTP(
    name: string,
    message: string,
    file: string,
    line: number,
    httpMethod?: string,
    httpURL?: string,
    httpHeaders?: string,
    httpBody?: string,
  ): Promise<void> {
    const error = new Error(message);
    error.name = name;
    await this.otelClient.reportError(error, file, line, {
      method: httpMethod,
      url: httpURL,
      headers: httpHeaders,
      body: httpBody,
    });
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
    await this.otelClient.submitApplicationError(name, message, file, line, statusCode, method, url, requestBody);
  }

  wrapFunction<T extends (...args: unknown[]) => unknown>(
    fn: T,
  ): (...args: Parameters<T>) => ReturnType<T> {
    return (...args: Parameters<T>): ReturnType<T> => {
      try {
        const result = fn(...args);
        if (result instanceof Promise) {
          return result.catch(err => {
            if (err instanceof Error && err.stack && this.isApplicationError(err.stack)) {
              this.reportError(err).catch(() => {});
            }
            throw err;
          }) as ReturnType<T>;
        }
        return result as ReturnType<T>;
      } catch (err) {
        if (err instanceof Error && err.stack && this.isApplicationError(err.stack)) {
          this.reportError(err).catch(() => {});
        }
        throw err;
      }
    };
  }

  log(level: LogLevel, message: string, attrs?: Record<string, string>): void {
    this.otelClient.log(level, message, attrs);
  }

  async logSync(level: LogLevel, message: string, attrs?: Record<string, string>): Promise<void> {
    await this.otelClient.logSync(level, message, attrs);
  }

  async flushLogs(timeoutMs = 5000): Promise<void> {
    await this.otelClient.flushLogs(timeoutMs);
  }

  async shutdown(): Promise<void> {
    await this.otelClient.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let _globalClient: MiddleMonitorClient | null = null;
let _initDone = false;
const _initLock = { locked: false };

// ---------------------------------------------------------------------------
// Global init API (mirrors Go: Init, InitWithConfig, InitSimple, GetGlobalClient, GetGlobalConfig)
// ---------------------------------------------------------------------------

export function init(cfg?: Config): void {
  if (_initDone && _globalClient) return;
  const resolvedCfg = cfg ?? configFromEnv();
  _globalClient = new MiddleMonitorClient(resolvedCfg);
  if (!resolvedCfg.token) {
    console.warn(
      `[Middle-Monitor] initialized without token: service=${resolvedCfg.service}`,
    );
  }
  _initDone = true;
}

export function initSimple(): void {
  init(undefined);
}

export function initWithConfig(
  apiUrl: string,
  service: string,
  token?: string,
): void {
  init(newConfig(apiUrl, service, token));
}

export function getGlobalClient(): MiddleMonitorClient | null {
  if (!_globalClient) init();
  return _globalClient;
}

export function getGlobalConfig(): Config | null {
  const client = getGlobalClient();
  return client ? client.config : null;
}

// ---------------------------------------------------------------------------
// Global convenience functions
// ---------------------------------------------------------------------------

export function reportError(error: Error): void {
  getGlobalClient()?.reportError(error).catch(() => {});
}

export function reportErrorWithDetails(error: Error, file: string, line: number): void {
  getGlobalClient()?.reportError(error, file, line).catch(() => {});
}

export function capturePanicGlobal(error: Error): void {
  getGlobalClient()?.reportError(error).catch(() => {});
}

export function log(level: LogLevel, message: string, attrs?: Record<string, string>): void {
  getGlobalClient()?.log(level, message, attrs);
}

export function logSync(level: LogLevel, message: string, attrs?: Record<string, string>): Promise<void> {
  return getGlobalClient()?.logSync(level, message, attrs) ?? Promise.resolve();
}

export function flushLogs(timeoutMs = 5000): Promise<void> {
  return getGlobalClient()?.flushLogs(timeoutMs) ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function _resetGlobalClientForTesting(): void {
  _globalClient = null;
  _initDone = false;
}

export type { Config, SamplingConfig, TracesSamplingConfig, LogsSamplingConfig } from './config';
export { LogLevel, newConfig, configFromEnv, defaultSamplingConfig, shouldSampleTrace, shouldSampleLog } from './config';
export { MiddleMonitorError, NotInitializedError, ConfigError } from './errors';
