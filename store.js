'use strict';

const fs = require('fs');
const path = require('path');

const AOF_VERSION = 1;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

class Store {
    constructor(options = {}) {
        if (typeof options === 'string') {
            options = { aofPath: options };
        }

        this.data = new Map();
        this.expirations = new Map();
        this.aofPath = options.aofPath || path.join(__dirname, 'appendonly.aof');
        this.fsync = options.fsync !== false;
        this.onError = typeof options.onError === 'function' ? options.onError : null;
        this.lastError = null;
        this.fd = null;
        this.closed = false;

        fs.mkdirSync(path.dirname(this.aofPath), { recursive: true });
        this._loadAOF();
        this.fd = fs.openSync(this.aofPath, 'a');
        this._scheduleLoadedExpirations();
    }

    _loadAOF() {
        if (!fs.existsSync(this.aofPath)) {
            return;
        }

        const content = fs.readFileSync(this.aofPath, 'utf8');
        if (content.length === 0) {
            return;
        }

        const lines = content.split('\n');
        const hasTrailingNewline = content.endsWith('\n');

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index].trimEnd();
            if (!line.trim()) {
                continue;
            }

            try {
                this._applyRecord(this._parseRecord(line), false);
            } catch (error) {
                const isTruncatedTail = index === lines.length - 1 && !hasTrailingNewline;
                if (isTruncatedTail) {
                    break;
                }
                throw new Error(`Invalid AOF record on line ${index + 1}: ${error.message}`);
            }
        }
    }

    _parseRecord(line) {
        if (line.startsWith('{')) {
            const record = JSON.parse(line);
            this._validateRecord(record);
            return record;
        }

        // Backward compatibility with the original space-separated AOF format.
        const parts = line.split(' ');
        const operation = parts[0];
        if (operation === 'SET' && parts.length >= 3) {
            return {
                v: AOF_VERSION,
                op: 'SET',
                key: parts[1],
                value: parts.slice(2).join(' '),
                expiresAt: null,
            };
        }
        if (operation === 'DEL' && parts.length === 2) {
            return { v: AOF_VERSION, op: 'DEL', key: parts[1] };
        }
        if (operation === 'FLUSHDB' && parts.length === 1) {
            return { v: AOF_VERSION, op: 'FLUSHDB' };
        }

        throw new Error('unsupported record format');
    }

    _validateRecord(record) {
        if (!record || record.v !== AOF_VERSION || typeof record.op !== 'string') {
            throw new Error('unsupported record version');
        }

        if (record.op === 'SET') {
            if (typeof record.key !== 'string' || typeof record.value !== 'string') {
                throw new Error('SET requires string key and value fields');
            }
            if (record.expiresAt !== null && record.expiresAt !== undefined
                && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0)) {
                throw new Error('SET expiresAt must be a positive integer or null');
            }
            return;
        }

        if (record.op === 'DEL') {
            if (typeof record.key !== 'string') {
                throw new Error('DEL requires a string key field');
            }
            return;
        }

        if (record.op !== 'FLUSHDB') {
            throw new Error(`unsupported operation '${record.op}'`);
        }
    }

    _append(record) {
        this._assertOpen();
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        let offset = 0;

        while (offset < bytes.length) {
            const written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
            if (written <= 0) {
                throw new Error('could not append to the AOF');
            }
            offset += written;
        }
        if (this.fsync) {
            fs.fsyncSync(this.fd);
        }
    }

    _applyRecord(record, scheduleExpiration = true) {
        if (record.op === 'SET') {
            this._clearExpiration(record.key);
            const expiresAt = record.expiresAt ?? null;

            if (expiresAt !== null && expiresAt <= Date.now()) {
                this.data.delete(record.key);
                return;
            }

            this.data.set(record.key, record.value);
            if (expiresAt !== null) {
                this.expirations.set(record.key, { expiresAt, timer: null });
                if (scheduleExpiration) {
                    this._scheduleExpiration(record.key, expiresAt);
                }
            }
            return;
        }

        if (record.op === 'DEL') {
            this.data.delete(record.key);
            this._clearExpiration(record.key);
            return;
        }

        this.data.clear();
        this._clearAllExpirations();
    }

    _scheduleLoadedExpirations() {
        for (const [key, entry] of this.expirations) {
            this._scheduleExpiration(key, entry.expiresAt);
        }
    }

    _scheduleExpiration(key, expiresAt) {
        const existing = this.expirations.get(key);
        if (!existing || existing.expiresAt !== expiresAt) {
            return;
        }
        if (existing.timer) {
            clearTimeout(existing.timer);
        }

        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
            this._expire(key, expiresAt);
            return;
        }

        const timer = setTimeout(
            () => this._scheduleExpiration(key, expiresAt),
            Math.min(remaining, MAX_TIMEOUT_MS),
        );
        timer.unref?.();
        this.expirations.set(key, { expiresAt, timer });
    }

    _expire(key, expiresAt) {
        const current = this.expirations.get(key);
        if (!current || current.expiresAt !== expiresAt || !this.data.has(key)) {
            return;
        }

        try {
            this.del(key);
        } catch (error) {
            this.lastError = error;
            if (this.onError) {
                this.onError(error);
            }
            if (!this.closed) {
                const retry = setTimeout(() => this._scheduleExpiration(key, expiresAt), 1000);
                retry.unref?.();
                this.expirations.set(key, { expiresAt, timer: retry });
            }
        }
    }

    _clearExpiration(key) {
        const entry = this.expirations.get(key);
        if (entry?.timer) {
            clearTimeout(entry.timer);
        }
        this.expirations.delete(key);
    }

    _clearAllExpirations() {
        for (const entry of this.expirations.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.expirations.clear();
    }

    _assertOpen() {
        if (this.closed || this.fd === null) {
            throw new Error('store is closed');
        }
    }

    set(key, value, ttlSeconds = null) {
        this._assertOpen();
        if (typeof key !== 'string' || key.length === 0) {
            throw new TypeError('key must be a non-empty string');
        }
        if (typeof value !== 'string') {
            throw new TypeError('value must be a string');
        }
        if (ttlSeconds !== null
            && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0
                || Date.now() + (ttlSeconds * 1000) > Number.MAX_SAFE_INTEGER)) {
            throw new RangeError('TTL must be a positive number of seconds');
        }

        const expiresAt = ttlSeconds === null ? null : Math.ceil(Date.now() + (ttlSeconds * 1000));
        const record = { v: AOF_VERSION, op: 'SET', key, value, expiresAt };

        // Write and synchronize the intent before changing in-memory state.
        this._append(record);
        this._applyRecord(record);
        return true;
    }

    get(key) {
        return this.data.has(key) ? this.data.get(key) : null;
    }

    del(key) {
        this._assertOpen();
        if (!this.data.has(key)) {
            return 0;
        }

        const record = { v: AOF_VERSION, op: 'DEL', key };
        this._append(record);
        this._applyRecord(record);
        return 1;
    }

    keys() {
        return Array.from(this.data.keys());
    }

    size() {
        return this.data.size;
    }

    flush() {
        this._assertOpen();
        const record = { v: AOF_VERSION, op: 'FLUSHDB' };
        this._append(record);
        this._applyRecord(record);
    }

    close() {
        if (this.closed) {
            return;
        }

        this._clearAllExpirations();
        if (this.fd !== null) {
            let closeError = null;
            try {
                if (this.fsync) {
                    fs.fsyncSync(this.fd);
                }
            } catch (error) {
                closeError = error;
            }
            try {
                fs.closeSync(this.fd);
            } catch (error) {
                closeError ||= error;
            }
            this.fd = null;
            this.closed = true;
            if (closeError) {
                throw closeError;
            }
        }
        this.closed = true;
    }
}

module.exports = Store;
