import chalk from 'chalk';

const isDev = process.env.NODE_ENV === 'development';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: Error) => void;
  debug: (msg: string) => void;
  success: (msg: string) => void;
}

const getTimestamp = () => {
  return new Date().toISOString();
};

export class ConsoleLogger implements Logger {
  private shouldLog(): boolean {
    return isDev || process.env.DEBUG === '1';
  }

  info(msg: string): void {
    if (!this.shouldLog()) return;
    // eslint-disable-next-line no-console
    console.log(
      chalk.blue(`[${getTimestamp()}]`),
      chalk.cyan.bold('[INFO]'),
      chalk.cyan(msg)
    );
  }

  warn(msg: string): void {
    if (!this.shouldLog()) return;
    // eslint-disable-next-line no-console
    console.warn(
      chalk.blue(`[${getTimestamp()}]`),
      chalk.yellow.bold('[WARN]'),
      chalk.yellow(msg)
    );
  }

  error(msg: string, err?: Error): void {
    if (!this.shouldLog()) return;
    // eslint-disable-next-line no-console
    console.error(
      chalk.blue(`[${getTimestamp()}]`),
      chalk.red.bold('[ERROR]'),
      chalk.red(msg),
      err ? `\n${chalk.red(err.stack ?? err.message)}` : ''
    );
  }

  debug(msg: string): void {
    if (!this.shouldLog()) return;
    // eslint-disable-next-line no-console
    console.debug(
      chalk.blue(`[${getTimestamp()}]`),
      chalk.gray.bold('[DEBUG]'),
      chalk.gray(msg)
    );
  }

  success(msg: string): void {
    if (!this.shouldLog()) return;
    // eslint-disable-next-line no-console
    console.log(
      chalk.blue(`[${getTimestamp()}]`),
      chalk.green.bold('[SUCCESS]'),
      chalk.green(msg)
    );
  }
}