import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class State {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(bucket TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(bucket,id)); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,status INTEGER NOT NULL,detail TEXT);');
    this.inTransaction = false;
  }
  list(bucket) {
    return this.db.prepare('SELECT data FROM records WHERE bucket=? ORDER BY CAST(id AS INTEGER),id').all(bucket).map(row => JSON.parse(row.data));
  }
  get(bucket, id) {
    const row = this.db.prepare('SELECT data FROM records WHERE bucket=? AND id=?').get(bucket, String(id));
    return row ? JSON.parse(row.data) : null;
  }
  nextId(bucket) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(CAST(id AS INTEGER)),0)+1 AS id FROM records WHERE bucket=?').get(bucket).id);
  }
  put(bucket, record) {
    const value = structuredClone(record);
    if (value.id === undefined || value.id === null) value.id = this.nextId(bucket);
    this.db.prepare('INSERT INTO records(bucket,id,data) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET data=excluded.data').run(bucket, String(value.id), JSON.stringify(value));
    return structuredClone(value);
  }
  patch(bucket, id, partial) {
    const previous = this.get(bucket, id);
    if (!previous) return null;
    return this.put(bucket, { ...previous, ...partial, id: previous.id });
  }
  delete(bucket, id) {
    return this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, String(id)).changes > 0;
  }
  meta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return value;
  }
  transaction(callback) {
    if (this.inTransaction) return callback();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = callback();
      if (result?.then) throw new Error('SQLite state transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.inTransaction = false; }
  }
  log(method, requestPath, status, detail = '') {
    this.db.prepare('INSERT INTO requests(time,method,path,status,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(), method, requestPath, status, String(detail).slice(0, 1000));
  }
  requestSummary() {
    return this.db.prepare('SELECT method,path,status,COUNT(*) AS count FROM requests GROUP BY method,path,status ORDER BY status DESC,path').all();
  }
  close() { this.db.close(); }
}
