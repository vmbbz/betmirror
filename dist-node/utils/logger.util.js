import chalk from 'chalk';
const isDev = process.env.NODE_ENV === 'development';
const getTimestamp = () => {
    return new Date().toISOString();
};
export class ConsoleLogger {
    shouldLog() {
        return isDev || process.env.DEBUG === '1';
    }
    info(msg) {
        if (!this.shouldLog())
            return;
        // eslint-disable-next-line no-console
        console.log(chalk.blue(`[${getTimestamp()}]`), chalk.cyan.bold('[INFO]'), chalk.cyan(msg));
    }
    warn(msg) {
        if (!this.shouldLog())
            return;
        // eslint-disable-next-line no-console
        console.warn(chalk.blue(`[${getTimestamp()}]`), chalk.yellow.bold('[WARN]'), chalk.yellow(msg));
    }
    error(msg, err) {
        if (!this.shouldLog())
            return;
        // eslint-disable-next-line no-console
        console.error(chalk.blue(`[${getTimestamp()}]`), chalk.red.bold('[ERROR]'), chalk.red(msg), err ? `\n${chalk.red(err.stack ?? err.message)}` : '');
    }
    debug(msg) {
        if (!this.shouldLog())
            return;
        // eslint-disable-next-line no-console
        console.debug(chalk.blue(`[${getTimestamp()}]`), chalk.gray.bold('[DEBUG]'), chalk.gray(msg));
    }
    success(msg) {
        if (!this.shouldLog())
            return;
        // eslint-disable-next-line no-console
        console.log(chalk.blue(`[${getTimestamp()}]`), chalk.green.bold('[SUCCESS]'), chalk.green(msg));
    }
}
