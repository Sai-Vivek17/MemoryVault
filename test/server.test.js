'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    createMemoryVaultServer,
    executeCommand,
    readConfiguration,
} = require('../server');

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createServerFixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryvault-server-'));
    const errors = [];
    const application = createMemoryVaultServer({
        host: '127.0.0.1',
        port: 0,
        aofPath: path.join(directory, 'appendonly.aof'),
        onError: (error) => errors.push(error),
        ...options,
    });
    const address = await application.start();

    t.after(async () => {
        await application.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return { application, port: address.port, errors };
}

class LineClient {
    constructor(socket) {
        this.socket = socket;
        this.buffer = '';
        this.lines = [];
        this.waiters = [];
        this.closed = new Promise((resolve) => socket.once('close', resolve));

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            this.buffer += chunk;
            let newline = this.buffer.indexOf('\n');
            while (newline !== -1) {
                const line = this.buffer.slice(0, newline).replace(/\r$/, '');
                this.buffer = this.buffer.slice(newline + 1);
                const waiter = this.waiters.shift();
                if (waiter) {
                    waiter.resolve(line);
                } else {
                    this.lines.push(line);
                }
                newline = this.buffer.indexOf('\n');
            }
        });
    }

    static connect(port) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.once('connect', () => resolve(new LineClient(socket)));
            socket.once('error', reject);
        });
    }

    send(command) {
        this.socket.write(`${command}\r\n`);
    }

    nextLine(timeoutMilliseconds = 1000) {
        if (this.lines.length > 0) {
            return Promise.resolve(this.lines.shift());
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for response')), timeoutMilliseconds);
            this.waiters.push({
                resolve: (line) => {
                    clearTimeout(timer);
                    resolve(line);
                },
            });
        });
    }

    destroy() {
        this.socket.destroy();
    }
}

test('serves the documented command set and closes on QUIT', async (t) => {
    const { port } = await createServerFixture(t);
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());

    client.send('PING');
    assert.equal(await client.nextLine(), '+PONG');
    client.send('SET greeting hello world');
    assert.equal(await client.nextLine(), '+OK');
    client.send('GET greeting');
    assert.equal(await client.nextLine(), '+hello world');
    client.send('DBSIZE');
    assert.equal(await client.nextLine(), ':1');
    client.send('KEYS');
    assert.equal(await client.nextLine(), '*1');
    assert.equal(await client.nextLine(), '+greeting');
    client.send('DEL greeting');
    assert.equal(await client.nextLine(), ':1');
    client.send('GET greeting');
    assert.equal(await client.nextLine(), '$-1');
    client.send('FLUSHDB');
    assert.equal(await client.nextLine(), '+OK');
    client.send('QUIT');
    assert.equal(await client.nextLine(), '+OK');
    await client.closed;
});

test('handles fragmented commands and multiple pipelined commands', async (t) => {
    const { port } = await createServerFixture(t);
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());

    client.socket.write('SET fragmented hello');
    await delay(10);
    client.socket.write(' world\r\nGET fragmented\r\nPING\r\n');

    assert.equal(await client.nextLine(), '+OK');
    assert.equal(await client.nextLine(), '+hello world');
    assert.equal(await client.nextLine(), '+PONG');
});

test('validates TTL syntax and expires keys', async (t) => {
    const { port } = await createServerFixture(t);
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());

    client.send('SET invalid value EX nope');
    assert.equal(await client.nextLine(), '-ERR TTL must be a positive integer');
    client.send('SET invalid value EX 0');
    assert.equal(await client.nextLine(), '-ERR TTL must be a positive integer');
    client.send('SET temporary value EX 1');
    assert.equal(await client.nextLine(), '+OK');
    await delay(1100);
    client.send('GET temporary');
    assert.equal(await client.nextLine(), '$-1');
});

test('requires authentication when a password is configured', async (t) => {
    const { port } = await createServerFixture(t, { password: 'correct-horse' });
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());

    client.send('PING');
    assert.equal(await client.nextLine(), '-NOAUTH authentication required');
    client.send('AUTH wrong');
    assert.equal(await client.nextLine(), '-NOAUTH invalid password');
    client.send('AUTH correct-horse');
    assert.equal(await client.nextLine(), '+OK');
    client.send('PING');
    assert.equal(await client.nextLine(), '+PONG');
});

test('rejects oversized command buffers and closes the socket', async (t) => {
    const { port } = await createServerFixture(t, { maxBufferBytes: 1024 });
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());

    client.socket.write('x'.repeat(1025));
    assert.equal(await client.nextLine(), '-ERR command exceeds maximum length');
    await client.closed;
});

test('accepts a large pipeline when each command is within the limit', async (t) => {
    const { port } = await createServerFixture(t, { maxBufferBytes: 1024 });
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());
    const count = 300;

    client.socket.write(`${Array(count).fill('PING').join('\r\n')}\r\n`);
    for (let index = 0; index < count; index += 1) {
        assert.equal(await client.nextLine(), '+PONG');
    }
});

test('stop closes active connections and is idempotent', async (t) => {
    const { application, port } = await createServerFixture(t);
    const client = await LineClient.connect(port);
    t.after(() => client.destroy());

    await application.stop();
    await client.closed;
    await application.stop();
});

test('executeCommand validates arity and unknown commands', () => {
    const store = {
        get: () => null,
        keys: () => [],
        size: () => 0,
    };
    assert.equal(executeCommand(store, '').response, '-ERR empty command');
    assert.match(executeCommand(store, 'GET').response, /wrong number/);
    assert.match(executeCommand(store, 'UNKNOWN').response, /unknown command/);
});

test('reads and validates environment configuration', () => {
    const configuration = readConfiguration({
        MEMORYVAULT_HOST: '0.0.0.0',
        MEMORYVAULT_PORT: '6380',
        MEMORYVAULT_AOF_PATH: './data/test.aof',
        MEMORYVAULT_PASSWORD: 'secret',
        MEMORYVAULT_MAX_COMMAND_BYTES: '2048',
    });

    assert.equal(configuration.host, '0.0.0.0');
    assert.equal(configuration.port, 6380);
    assert.equal(configuration.password, 'secret');
    assert.equal(configuration.maxBufferBytes, 2048);
    assert.equal(path.isAbsolute(configuration.aofPath), true);
    assert.throws(() => readConfiguration({ MEMORYVAULT_PORT: 'invalid' }), /must be an integer/);
});
