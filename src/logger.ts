import pino from 'pino';
import { loadConfig } from './config.js';

const level = (() => {
  try {
    return loadConfig().LOG_LEVEL;
  } catch {
    return process.env.LOG_LEVEL ?? 'info';
  }
})();

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
