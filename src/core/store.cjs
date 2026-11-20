const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parseJson, stringify } = require('./json.cjs');
const { demand, positive, text, validateConnection, validateTemplate } = require('./model.cjs');
const presets = require('./presets.cjs');

const START_PASSWORD = 'MPadmin2026!';
const ACTIVE = "('queued', 'running', 'waiting')";
const roles = ['admin', 'configurator', 'user'];

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

function validatePassword(password) {
  demand(typeof password === 'string' && password.length >= 10 && password.length <= 200, 'Пароль должен содержать от 10 до 200 символов.');
}

function decode(row, fields) {
  if (!row) return null;
  for (const field of fields) row[field] = row[field] === null ? null : parseJson(row[field]);
  return row;
}

class Store {
  constructor(root, { seed = true } = {}) {
    this.root = root;
    for (const dir of ['data', 'exports', 'logs']) mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, 'data', 'mp-api.sqlite'));
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, role TEXT NOT NULL,
        hash TEXT NOT NULL, salt TEXT NOT NULL, must_change INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, encrypted TEXT NOT NULL, expires INTEGER);
      CREATE TABLE IF NOT EXISTS secret_heads (
        connection_id TEXT, endpoint_id TEXT, profile_id TEXT, environment TEXT, secret_id TEXT REFERENCES secrets(id),
        PRIMARY KEY(connection_id, endpoint_id, profile_id, environment)
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY, draft TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, sample_run_id TEXT, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS template_versions (
        template_id TEXT REFERENCES templates(id), version INTEGER NOT NULL, value TEXT NOT NULL,
        published INTEGER NOT NULL, PRIMARY KEY (template_id, version)
      );
      CREATE TABLE IF NOT EXISTS processings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders (
        kind TEXT, scope TEXT, path TEXT, PRIMARY KEY (kind, scope, path)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, owner TEXT REFERENCES users(id), value TEXT NOT NULL,
        schedule_cursor INTEGER NOT NULL, pending_at INTEGER, pending_slot INTEGER, deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), owner TEXT REFERENCES users(id), state TEXT NOT NULL,
        kind TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        snapshot TEXT NOT NULL, progress TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs (job_id)
        WHERE job_id IS NOT NULL AND state IN ${ACTIVE};
      CREATE INDEX IF NOT EXISTS runs_by_date ON runs(created DESC);
      CREATE TABLE IF NOT EXISTS pages (
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, source INTEGER NOT NULL, batch INTEGER NOT NULL,
        page INTEGER NOT NULL, next TEXT, rows INTEGER NOT NULL, status TEXT NOT NULL, problem TEXT,
        PRIMARY KEY (run_id, source, batch, page)
      );
      CREATE TABLE IF NOT EXISTS dictionaries (
        template_id TEXT PRIMARY KEY REFERENCES templates(id), run_id TEXT REFERENCES runs(id),
        updated INTEGER NOT NULL
      );
    `);
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'deleted_at')) {
        this.db.exec('ALTER TABLE jobs ADD COLUMN deleted_at INTEGER');
      }
      if (!this.db.prepare('PRAGMA table_info(templates)').all().some(column => column.name === 'archived_at')) {
        this.db.exec('ALTER TABLE templates ADD COLUMN archived_at INTEGER');
      }
    });
    if (seed && !this.setting('initialized')) this.seed();
  }

  close() { this.db.close(); }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seed() {
    this.transaction(() => {
      if (this.setting('initialized')) return;
      this.createUser('admin', START_PASSWORD, 'admin');
      this.saveSetting('retention', { logsDays: 30, dataDays: 90 });
      for (const item of presets.connections) this.putConnection(validateConnection(item));
      for (const item of presets.templates) {
        this.putDraft(validateTemplate(item, this.connection(item.connectionId)));
        this.publish(item.id);
      }
      this.saveSetting('initialized', true);
    });
  }

  setting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? parseJson(row.value) : null;
  }

  saveSetting(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, stringify(value));
  }

  createUser(username, password, role) {
    username = text(username, 'логин', 48).toLowerCase();
    demand(/^[\p{L}\p{N}_.-]+$/u.test(username), 'Логин может содержать буквы, цифры, точку, дефис и подчёркивание.');
    validatePassword(password);
    demand(roles.includes(role), 'Выберите роль пользователя.');
    demand(!this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username), 'Этот логин уже занят.');
    const { hash, salt } = passwordHash(password);
    const id = randomUUID();
    this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1)').run(id, username, role, hash, salt);
    return this.user(id);
  }

  authenticate(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 48 || password.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
    const { hash } = passwordHash(password, row?.salt ?? '00000000000000000000000000000000');
    if (!row || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(row.hash, 'hex'))) return null;
    return this.user(row.id);
  }

  user(id) {
    return this.db.prepare('SELECT id, username, role, must_change FROM users WHERE id = ?').get(id);
  }

  users() {
    return this.db.prepare('SELECT id, username, role, must_change FROM users ORDER BY username').all();
  }

  changePassword(id, previous, password) {
    const user = this.user(id);
    demand(user && this.authenticate(user.username, previous), 'Текущий пароль неверен.');
    validatePassword(password);
    demand(previous !== password && password !== START_PASSWORD, 'Укажите новый пароль.');
    const { hash, salt } = passwordHash(password);
    this.db.prepare('UPDATE users SET hash = ?, salt = ?, must_change = 0 WHERE id = ?').run(hash, salt, id);
    return this.user(id);
  }

  setRole(id, role) {
    demand(roles.includes(role) && this.user(id), 'Выберите пользователя и роль.');
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  connection(id) {
    const record = this.db.prepare('SELECT value FROM connections WHERE id = ?').get(id);
    return record ? parseJson(record.value) : null;
  }

  connections() {
    return this.db.prepare('SELECT value FROM connections ORDER BY rowid').all().map(row => parseJson(row.value));
  }

  putConnection(connection) {
    this.db.prepare('INSERT INTO connections VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
      .run(connection.id, stringify(connection));
  }

  secretRef(connection, endpoint, profile, environment) {
    return this.db.prepare(`
      SELECT s.id, s.expires FROM secret_heads h JOIN secrets s ON s.id = h.secret_id
      WHERE connection_id = ? AND endpoint_id = ? AND profile_id = ? AND environment = ?
    `).get(connection, endpoint, profile, environment);
  }

  secret(id) {
    return this.db.prepare('SELECT encrypted, expires FROM secrets WHERE id = ?').get(id);
  }

  putSecret(connection, endpoint, profile, environment, encrypted, expires) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO secrets VALUES (?, ?, ?)').run(id, encrypted, expires);
      this.db.prepare(`
        INSERT INTO secret_heads VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, endpoint_id, profile_id, environment) DO UPDATE SET secret_id = excluded.secret_id
      `).run(connection, endpoint, profile, environment, id);
    });
  }

  clearSecret(connection, endpoint, profile, environment) {
    this.db.prepare('DELETE FROM secret_heads WHERE connection_id = ? AND endpoint_id = ? AND profile_id = ? AND environment = ?')
      .run(connection, endpoint, profile, environment);
  }

  templates() {
    return this.db.prepare(`
      SELECT t.id, t.draft, t.version, t.sample_run_id, t.archived_at, v.value AS published
      FROM templates t LEFT JOIN template_versions v ON v.template_id = t.id AND v.version = t.version
      ORDER BY t.rowid
    `).all().map(row => decode(row, ['draft', 'published']));
  }

  template(id) {
    return decode(this.db.prepare(`
      SELECT t.id, t.draft, t.version, t.sample_run_id, t.archived_at, v.value AS published
      FROM templates t LEFT JOIN template_versions v ON v.template_id = t.id AND v.version = t.version WHERE t.id = ?
    `).get(id), ['draft', 'published']);
  }

  versions(id) {
    return this.db.prepare('SELECT version, published, value FROM template_versions WHERE template_id = ? ORDER BY version DESC')
      .all(id).map(row => decode(row, ['value']));
  }

  putDraft(template) {
    this.db.prepare('INSERT INTO templates (id, draft) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET draft = excluded.draft')
      .run(template.id, stringify(template));
  }

  archiveTemplate(id, archived) {
    this.db.prepare('UPDATE templates SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, id);
  }

  removeTemplate(id) {
    this.db.prepare('DELETE FROM dictionaries WHERE template_id = ?').run(id);
    this.db.prepare('DELETE FROM template_versions WHERE template_id = ?').run(id);
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  publish(id) {
    const current = this.template(id);
    demand(current, 'Черновик отсутствует.');
    const version = current.version + 1;
    this.db.prepare('INSERT INTO template_versions VALUES (?, ?, ?, ?)').run(id, version, stringify(current.draft), Date.now());
    this.db.prepare('UPDATE templates SET version = ? WHERE id = ?').run(version, id);
    return version;
  }

  linkSample(id, runId) {
    this.db.prepare('UPDATE templates SET sample_run_id = ? WHERE id = ?').run(runId, id);
  }

  folders() {
    return this.db.prepare('SELECT * FROM folders ORDER BY path').all();
  }

  processings() {
    return this.db.prepare('SELECT value FROM processings ORDER BY rowid').all().map(row => parseJson(row.value));
  }

  processing(id) {
    const row = this.db.prepare('SELECT value FROM processings WHERE id = ?').get(id);
    return row ? parseJson(row.value) : null;
  }

  putProcessing(processing) {
    this.db.prepare('INSERT INTO processings VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
      .run(processing.id, stringify(processing));
  }

  removeProcessing(id) {
    this.db.prepare('DELETE FROM processings WHERE id = ?').run(id);
  }

  putFolder(kind, scope, path) {
    this.db.prepare('INSERT OR IGNORE INTO folders VALUES (?, ?, ?)').run(kind, scope, path);
  }

  jobs(owner = null) {
    const sql = owner
      ? 'SELECT * FROM jobs WHERE deleted_at IS NULL AND owner = ? ORDER BY rowid'
      : 'SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY rowid';
    return this.db.prepare(sql).all(...(owner ? [owner] : [])).map(row => decode(row, ['value']));
  }

  job(id) {
    return decode(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id), ['value']);
  }

  deleteJob(id) {
    this.db.prepare('UPDATE jobs SET deleted_at = ?, pending_at = NULL, pending_slot = NULL WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id);
  }

  putJob(job, owner, unchangedSchedule, now = Date.now()) {
    return this.db.prepare(`
      INSERT INTO jobs (id, owner, value, schedule_cursor) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value,
        schedule_cursor = CASE WHEN ? THEN jobs.schedule_cursor ELSE excluded.schedule_cursor END,
        pending_at = CASE WHEN ? THEN jobs.pending_at ELSE NULL END,
        pending_slot = CASE WHEN ? THEN jobs.pending_slot ELSE NULL END
      WHERE jobs.deleted_at IS NULL
    `).run(job.id, owner, stringify(job), now, Number(unchangedSchedule), Number(unchangedSchedule), Number(unchangedSchedule));
  }

  scheduleJob(id, cursor, pendingAt, pendingSlot) {
    this.db.prepare('UPDATE jobs SET schedule_cursor = ?, pending_at = ?, pending_slot = ? WHERE id = ? AND deleted_at IS NULL')
      .run(cursor, pendingAt, pendingSlot, id);
  }

  activeJob(id) {
    return Boolean(this.db.prepare(`SELECT 1 FROM runs WHERE job_id = ? AND state IN ${ACTIVE}`).get(id));
  }

  activeRuns() {
    return this.db.prepare(`SELECT id, state FROM runs WHERE state IN ${ACTIVE} ORDER BY created`).all();
  }

  runs(owner = null) {
    const filter = owner ? 'WHERE owner = ?' : '';
    return this.db.prepare(`
      SELECT id, job_id, owner, state, kind, name, created, updated, progress, pinned FROM runs
      ${filter} ORDER BY created DESC LIMIT 500
    `).all(...(owner ? [owner] : [])).map(row => decode(row, ['progress']));
  }

  run(id) {
    return decode(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id), ['snapshot', 'progress']);
  }

  createRun({ owner, jobId = null, name, kind, snapshot, now = Date.now() }) {
    if (jobId) demand(!this.activeJob(jobId), 'Эта выгрузка уже выполняется.');
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO runs (id, job_id, owner, state, kind, name, created, updated, snapshot, progress)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '{}')
    `).run(id, jobId, owner, kind, name, now, now, stringify(snapshot));
    return id;
  }

  updateRun(id, state, progress) {
    this.db.prepare('UPDATE runs SET state = ?, progress = ?, updated = ? WHERE id = ?')
      .run(state, stringify(progress), Date.now(), id);
  }

  readyRun(id, snapshot) {
    this.db.prepare('UPDATE runs SET snapshot = ? WHERE id = ?').run(stringify(snapshot), id);
  }

  pinRun(id, pinned) {
    this.db.prepare('UPDATE runs SET pinned = ? WHERE id = ?').run(Number(Boolean(pinned)), id);
  }

  pages(id, source, batch = null) {
    const filter = batch === null ? '' : 'AND batch = ?';
    return this.db.prepare(`
      SELECT * FROM pages WHERE run_id = ? AND source = ? ${filter} ORDER BY batch, page
    `).all(id, source, ...(batch === null ? [] : [batch])).map(row => decode(row, ['next']));
  }

  commitPage(id, source, batch, page, next, rows, status, problem) {
    this.db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, source, batch, page, next === null ? null : stringify(next), rows, status, problem);
  }

  dictionary(templateId) {
    return this.db.prepare('SELECT * FROM dictionaries WHERE template_id = ?').get(templateId);
  }

  putDictionary(templateId, runId) {
    this.db.prepare(`
      INSERT INTO dictionaries VALUES (?, ?, ?) ON CONFLICT(template_id) DO UPDATE SET run_id = excluded.run_id, updated = excluded.updated
    `).run(templateId, runId, Date.now());
  }

  referencedRuns() {
    const current = this.db.prepare('SELECT run_id AS id FROM dictionaries UNION SELECT sample_run_id AS id FROM templates WHERE sample_run_id IS NOT NULL').all();
    const unfinished = this.db.prepare(`SELECT snapshot FROM runs WHERE state IN ${ACTIVE} OR state = 'interrupted'`).all();
    return new Set([
      ...current.map(row => row.id),
      ...unfinished.flatMap(row => parseJson(row.snapshot).sources.flatMap(source => Object.values(source.references ?? {}))),
    ]);
  }

  expiredRuns(before) {
    const preserved = this.referencedRuns();
    return this.db.prepare(`SELECT id FROM runs WHERE updated < ? AND pinned = 0 AND state NOT IN ${ACTIVE}`)
      .all(before).filter(row => !preserved.has(row.id));
  }

  removeRun(id) {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  saveRetention(value) {
    const days = { logsDays: positive(value.logsDays, 'Хранение логов', 3650), dataDays: positive(value.dataDays, 'Хранение результатов', 3650) };
    this.saveSetting('retention', days);
    return days;
  }
}

module.exports = { START_PASSWORD, Store, roles };
