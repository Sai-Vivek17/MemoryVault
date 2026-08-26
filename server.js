'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const Store = require('./store');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6379;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

function error(message) {
    return `-ERR ${message}`;
}

function safeEqual(left, right) {
    const leftDigest = crypto.createHash('sha256').update(left).digest();
    const rightDigest = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function parseCommand(commandLine) {
    const trimmed = commandLine.trim();
    return trimmed ? trimmed.split(/\s+/) : [];
}

function executeCommand(store, commandLine, context = {}) {
    const parts = parseCommand(commandLine);
    if (parts.length === 0) {
        return { response: error('empty command') };
    }

    const command = parts[0].toUpperCase();
    const password = context.password || null;

    if (command === 'QUIT') {
        if (parts.length !== 1) {
            return { response: error('wrong number of arguments for QUIT command') };
        }
        return { response: '+OK', close: true };
    }

    if (command === 'AUTH') {
        if (!password) {
            return { response: error('AUTH is not configured') };
        }
        if (parts.length !== 2) {
            return { response: error('wrong number of arguments for AUTH command') };
        }
        if (!safeEqual(parts[1], password)) {
            return { response: '-NOAUTH invalid password' };
        }
        context.authenticated = true;
        return { response: '+OK' };
    }

    if (password && !context.authenticated) {
        return { response: '-NOAUTH authentication required' };
    }

    try {
        switch (command) {
            case 'PING':
                if (parts.length !== 1) {
                    return { response: error('wrong number of arguments for PING command') };
                }
                return { response: '+PONG' };

            case 'SET': { // SET <key> <value...> [EX <positive-seconds>]
                if (parts.length < 3) {
                    return { response: error('wrong number of arguments for SET command') };
                }

                let valueEnd = parts.length;
                let ttlSeconds = null;
                if (parts.length >= 5 && parts[parts.length - 2].toUpperCase() === 'EX') {
                    const ttlText = parts[parts.length - 1];
                    if (!/^[1-9]\d*$/.test(ttlText)) {
                        return { response: error('TTL must be a positive integer') };
                    }
                    ttlSeconds = Number(ttlText);
                    if (!Number.isSafeInteger(ttlSeconds)
                        || Date.now() + (ttlSeconds * 1000) > Number.MAX_SAFE_INTEGER) {
                        return { response: error('TTL is too large') };
                    }
                    valueEnd -= 2;
                } else if (parts[parts.length - 1].toUpperCase() === 'EX') {
                    return { response: error('syntax error: EX requires a TTL') };
                }

                const value = parts.slice(2, valueEnd).join(' ');
                if (value.length === 0) {
                    return { response: error('value must not be empty') };
                }
                store.set(parts[1], value, ttlSeconds);
                return { response: '+OK' };
            }

            case 'GET': {
                if (parts.length !== 2) {
                    return { response: error('wrong number of arguments for GET command') };
                }
                const value = store.get(parts[1]);
                return { response: value === null ? '$-1' : `+${value}` };
            }

            case 'DEL':
                if (parts.length !== 2) {
                    return { response: error('wrong number of arguments for DEL command') };
                }
                return { response: `:${store.del(parts[1])}` };

            case 'DBSIZE':
                if (parts.length !== 1) {
                    return { response: error('wrong number of arguments for DBSIZE command') };
                }
                return { response: `:${store.size()}` };

            case 'FLUSHDB':
                if (parts.length !== 1) {
                    return { response: error('wrong number of arguments for FLUSHDB command') };
                }
                store.flush();
                return { response: '+OK' };

            case 'KEYS': { // The custom protocol supports KEYS without a pattern.
                if (parts.length !== 1) {
                    return { response: error('wrong number of arguments for KEYS command') };
                }
                const keys = store.keys().sort();
                const rows = keys.map((key) => `+${key}`);
                return { response: [`*${keys.length}`, ...rows].join('\r\n') };
            }

            default:
                return { response: error(`unknown command '${command}'`) };
        }
    } catch (caught) {
        context.onError?.(caught);
        return { response: error('persistence operation failed') };
    }
}

function createMemoryVaultServer(options = {}) {
    const host = options.host ?? DEFAULT_HOST;
    const port = options.port ?? DEFAULT_PORT;
    const password = options.password || null;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const onError = typeof options.onError === 'function' ? options.onError : () => {};

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new RangeError('port must be an integer from 0 to 65535');
    }
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1024) {
        throw new RangeError('maxBufferBytes must be an integer of at least 1024');
    }

    const store = options.store || new Store({
        aofPath: options.aofPath,
        fsync: options.fsync,
        onError,
    });
    let stopped = false;
    const sockets = new Set();

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        let buffer = '';
        const context = {
            password,
            authenticated: !password,
            onError,
        };

        socket.on('data', (chunk) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                let line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.endsWith('\r')) {
                    line = line.slice(0, -1);
                }
                if (Buffer.byteLength(line, 'utf8') > maxBufferBytes) {
                    socket.end(`${error('command exceeds maximum length')}\r\n`);
                    buffer = '';
                    return;
                }

                const result = executeCommand(store, line, context);
                if (result.close) {
                    socket.end(`${result.response}\r\n`);
                    return;
                }
                socket.write(`${result.response}\r\n`);
                newlineIndex = buffer.indexOf('\n');
            }

            if (Buffer.byteLength(buffer, 'utf8') > maxBufferBytes) {
                socket.end(`${error('command exceeds maximum length')}\r\n`);
                buffer = '';
            }
        });

        socket.on('error', onError);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('error', onError);

    function start() {
        if (stopped) {
            return Promise.reject(new Error('server has already been stopped'));
        }
        if (server.listening) {
            return Promise.resolve(server.address());
        }

        return new Promise((resolve, reject) => {
            const onStartupError = (startupError) => {
                server.off('listening', onListening);
                reject(startupError);
            };
            const onListening = () => {
                server.off('error', onStartupError);
                resolve(server.address());
            };
            server.once('error', onStartupError);
            server.once('listening', onListening);
            server.listen({ host, port });
        });
    }

    function stop() {
        if (stopped) {
            return Promise.resolve();
        }
        stopped = true;

        return new Promise((resolve, reject) => {
            const finish = (closeError) => {
                try {
                    store.close();
                    if (closeError) {
                        reject(closeError);
                    } else {
                        resolve();
                    }
                } catch (storeError) {
                    reject(storeError);
                }
            };

            if (server.listening) {
                server.close(finish);
                for (const socket of sockets) {
                    socket.destroy();
                }
            } else {
                finish();
            }
        });
    }

    return { server, store, start, stop };
}

function parseIntegerSetting(name, value, fallback, minimum, maximum) {
    if (value === undefined || value === '') {
        return fallback;
    }
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} must be an integer`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    }
    return number;
}

function readConfiguration(environment = process.env) {
    return {
        host: environment.MEMORYVAULT_HOST || DEFAULT_HOST,
        port: parseIntegerSetting('MEMORYVAULT_PORT', environment.MEMORYVAULT_PORT, DEFAULT_PORT, 1, 65535),
        aofPath: environment.MEMORYVAULT_AOF_PATH
            ? path.resolve(environment.MEMORYVAULT_AOF_PATH)
            : path.join(__dirname, 'appendonly.aof'),
        password: environment.MEMORYVAULT_PASSWORD || null,
        maxBufferBytes: parseIntegerSetting(
            'MEMORYVAULT_MAX_COMMAND_BYTES',
            environment.MEMORYVAULT_MAX_COMMAND_BYTES,
            DEFAULT_MAX_BUFFER_BYTES,
            1024,
            64 * 1024 * 1024,
        ),
    };
}

async function main() {
    const configuration = readConfiguration();
    const reportError = (caught) => console.error(`[MemoryVault] ${caught.message}`);
    const application = createMemoryVaultServer({ ...configuration, onError: reportError });
    const address = await application.start();
    console.log(`MemoryVault listening on ${address.address}:${address.port}`);
    console.log(`Durable AOF: ${configuration.aofPath}`);
    console.log(configuration.password ? 'Authentication: enabled' : 'Authentication: disabled (localhost only by default)');

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`Received ${signal}; shutting down.`);
        try {
            await application.stop();
        } catch (caught) {
            reportError(caught);
            process.exitCode = 1;
        }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
    main().catch((caught) => {
        console.error(`[MemoryVault] Failed to start: ${caught.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    createMemoryVaultServer,
    executeCommand,
    readConfiguration,
};
