import { describe, it, expect } from 'vitest';
import { MiddleMonitorError, NotInitializedError, ConfigError } from '../errors';

describe('MiddleMonitorError', () => {
  it('is an Error', () => {
    const err = new MiddleMonitorError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('test');
    expect(err.name).toBe('MiddleMonitorError');
  });
});

describe('NotInitializedError', () => {
  it('has correct message', () => {
    const err = new NotInitializedError();
    expect(err.message).toBe('client not initialized');
    expect(err.name).toBe('NotInitializedError');
  });

  it('is a MiddleMonitorError', () => {
    expect(new NotInitializedError()).toBeInstanceOf(MiddleMonitorError);
  });
});

describe('ConfigError', () => {
  it('has default message', () => {
    const err = new ConfigError();
    expect(err.message).toBe('endpoint and token required');
    expect(err.name).toBe('ConfigError');
  });

  it('accepts custom message', () => {
    const err = new ConfigError('custom detail');
    expect(err.message).toBe('custom detail');
  });

  it('is a MiddleMonitorError', () => {
    expect(new ConfigError()).toBeInstanceOf(MiddleMonitorError);
  });
});
