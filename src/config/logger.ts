import pino, { type LoggerOptions } from 'pino';
import { env } from './env.js';

const redactionPaths = [
  'req.headers.authorization',
  'password',
  '*.password',
  'otp',
  '*.otp',
  'otpHash',
  '*.otpHash',
  '*.codeCt',
  '*.codeIv',
  '*.codeTag',
  '*.codeDekEnc',
  '*.panCt',
  '*.panIv',
  '*.panTag',
];

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: redactionPaths,
    censor: '[REDACTED]',
  },
  base: {
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const options: LoggerOptions =
  env.NODE_ENV === 'development'
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : baseOptions;

export const logger = pino(options);
