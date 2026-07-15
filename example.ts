import express from 'express';

import { MiddleMonitorClient, getClient } from './src/index';
const app = express();

app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    client.reportError(err).catch(() => {});
    next(err);
  }
);
