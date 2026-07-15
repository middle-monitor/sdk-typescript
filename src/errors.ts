export class MiddleMonitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiddleMonitorError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotInitializedError extends MiddleMonitorError {
  constructor() {
    super('client not initialized');
    this.name = 'NotInitializedError';
  }
}

export class ConfigError extends MiddleMonitorError {
  constructor(detail = 'endpoint and token required') {
    super(detail);
    this.name = 'ConfigError';
  }
}
