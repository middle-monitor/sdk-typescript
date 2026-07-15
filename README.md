# Middle-Monitor TypeScript SDK

TypeScript/JavaScript SDK for capturing and reporting errors to Middle-Monitor.

## Installation

From GitHub:

```bash
npm install git+https://github.com/middle-monitor/sdk-typescript.git
```

Or from a local path:

```bash
npm install
```

## Usage

### Basic setup

```typescript
import { MiddleMonitorClient } from '@middle-monitor/sdk';

const client = new MiddleMonitorClient({
  apiUrl: 'http://localhost:8080',
  service: 'my-service'
});

try {
  throw new Error('Something went wrong');
} catch (error) {
  await client.reportError(error as Error);
}
```

### Custom error

```typescript
await client.reportCustomError(
  'DatabaseError',
  'Failed to connect to database',
  '/path/to/db.ts',
  123
);
```

### Function wrapper

```typescript
const riskyFunction = client.wrapFunction(() => {
  throw new Error('This will be automatically reported');
});
```

### Environment variable setup

```typescript
import { getClient } from '@middle-monitor/sdk';

// Reads MIDDLE_MONITOR_API_URL, MIDDLE_MONITOR_SERVICE
const client = getClient();
```

### Express middleware

```typescript
import { MiddleMonitorClient } from '@middle-monitor/sdk';

const client = new MiddleMonitorClient({
  service: 'my-api'
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  client.reportError(err).catch(() => {});
  next(err);
});
```

### Environment variables

```bash
export MIDDLE_MONITOR_API_URL=http://monitor.example.com
export MIDDLE_MONITOR_SERVICE=my-service
```
