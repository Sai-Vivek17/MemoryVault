'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Store = require('../store');

function createFixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryvault-store-'));
    const aofPath = path.join(directory, 'appendonly.aof');
    const stores = [];

    t.after(() => {
        for (const store of stores) {
            store.close();
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return {
        aofPath,
        open(options = {}) {
            const store = new Store({ aofPath, ...options });
            stores.push(store);
            return store;
        },
    };
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('stores, overwrites, lists, and deletes values', (t) => {
    const fixture = createFixture(t);
    const store = fixture.open();

    assert.equal(store.set('alpha', 'one'), true);
    assert.equal(store.set('empty', ''), true);
    assert.equal(store.get('alpha'), 'one');
    assert.equal(store.get('empty'), '');
    assert.deepEqual(store.keys().sort(), ['alpha', 'empty']);
    assert.equal(store.size(), 2);

    store.set('alpha', 'two');
    assert.equal(store.get('alpha'), 'two');
    assert.equal(store.del('alpha'), 1);
    assert.equal(store.del('alpha'), 0);
    assert.equal(store.get('alpha'), null);
});

test('persists values containing spaces across restarts', (t) => {
    const fixture = createFixture(t);
    const first = fixture.open();
    first.set('message', 'hello durable world');
    first.close();

    const second = fixture.open();
    assert.equal(second.get('message'), 'hello durable world');
});

test('expires a key while the server is running', async (t) => {
    const fixture = createFixture(t);
    const store = fixture.open();
    store.set('temporary', 'value', 0.05);

    assert.equal(store.get('temporary'), 'value');
    await delay(100);
    assert.equal(store.get('temporary'), null);
    assert.equal(store.size(), 0);
});

test('overwriting a key without a TTL cancels its previous expiration', async (t) => {
    const fixture = createFixture(t);
    const store = fixture.open();
    store.set('session', 'temporary', 0.05);
    store.set('session', 'permanent');

    await delay(100);
    assert.equal(store.get('session'), 'permanent');
});

test('preserves the remaining TTL across a restart', async (t) => {
    const fixture = createFixture(t);
    const first = fixture.open();
    first.set('temporary', 'value', 0.15);
    first.close();

    await delay(40);
    const second = fixture.open();
    assert.equal(second.get('temporary'), 'value');
    await delay(150);
    assert.equal(second.get('temporary'), null);
});

test('does not resurrect a key that expired while offline', async (t) => {
    const fixture = createFixture(t);
    const first = fixture.open();
    first.set('temporary', 'value', 0.05);
    first.close();

    await delay(80);
    const second = fixture.open();
    assert.equal(second.get('temporary'), null);
});

test('flush is durable and clears active expirations', (t) => {
    const fixture = createFixture(t);
    const first = fixture.open();
    first.set('alpha', 'one');
    first.set('temporary', 'value', 60);
    first.flush();
    assert.equal(first.size(), 0);
    first.close();

    const second = fixture.open();
    assert.equal(second.size(), 0);
});

test('loads AOF files written by the original release', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(fixture.aofPath, 'SET alpha hello legacy world\nDEL missing\n', 'utf8');

    const store = fixture.open();
    assert.equal(store.get('alpha'), 'hello legacy world');
});

test('ignores only an incomplete final AOF record', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(
        fixture.aofPath,
        '{"v":1,"op":"SET","key":"safe","value":"yes","expiresAt":null}\n{"v":1',
        'utf8',
    );

    const store = fixture.open();
    assert.equal(store.get('safe'), 'yes');
});

test('rejects corruption in a complete AOF record', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(fixture.aofPath, 'not-a-valid-record\n', 'utf8');
    assert.throws(() => fixture.open(), /Invalid AOF record on line 1/);
});

test('validates direct Store API input and closed state', (t) => {
    const fixture = createFixture(t);
    const store = fixture.open();
    assert.throws(() => store.set('', 'value'), /non-empty string/);
    assert.throws(() => store.set('key', 1), /value must be a string/);
    assert.throws(() => store.set('key', 'value', 0), /TTL must be a positive/);
    store.close();
    store.close();
    assert.throws(() => store.set('key', 'value'), /store is closed/);
});
