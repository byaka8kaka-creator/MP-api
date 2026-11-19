const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { InputError, object, publicValue, readJson, stringify } = require('./json.cjs');
const { demand, folder, id, inputValues, profileFor, text, validateConnection, validateTemplate } = require('./model.cjs');
const { generalLog, logEvent, logTail, preview, referenceValues, runLog, sample } = require('./datasets.cjs');
const { scheduleDecision, validateSchedule } = require('./schedule.cjs');

function canConfigure(user) {
  return user.role === 'admin' || user.role === 'configurator';
}

function safeToSee(user, owner) {
  return user.role === 'admin' || user.id === owner;
}

function formTemplate(template, version) {
  return {
    id: template.id, name: template.name, folder: template.folder, connectionId: template.connectionId, version,
    parameters: template.parameters.map(param => ({
      ...publicValue(param),
      defaultJson: param.default === undefined ? '' : stringify(param.default),
    })),
  };
}

function validateGraph(proposed, templates) {
  const visited = new Set();
  const path = new Set();
  function visit(template) {
    demand(!path.has(template.id), 'Настройки создают цикл зависимостей справочников.');
    if (visited.has(template.id)) return;
    path.add(template.id);
    for (const parameter of template.parameters) {
      if (!parameter.reference) continue;
      const source = templates.get(parameter.reference.templateId);
      demand(source && source.connectionId === template.connectionId, 'Выберите шаблон справочника из того же подключения.');
      visit(source);
    }
    path.delete(template.id);
    visited.add(template.id);
  }
  visit(proposed);
}

class Service {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
  }

  workspace(user) {
    const store = this.store;
    const editor = canConfigure(user);
    const all = store.templates();
    const connections = store.connections();
    return {
      user,
      jobs: store.jobs(user.role === 'admin' ? null : user.id).map(item => ({
        ...item, active: store.activeJob(item.id),
      })),
      runs: store.runs(user.role === 'admin' ? null : user.id),
      folders: store.folders().filter(row => row.kind === 'job' ? row.scope === user.id : editor),
      options: all.filter(record => record.published && (editor || record.published.available)).map(record => {
        const option = formTemplate(record.published, record.version);
        const connection = connections.find(item => item.id === option.connectionId);
        const endpoint = connection?.endpoints.find(item => item.id === record.published.endpointId);
        return { ...option, connection: connection?.name, sandbox: Boolean(endpoint?.sandbox) };
      }),
      connections: editor ? connections : [],
      templates: editor ? all.map(item => ({
        id: item.id, version: item.version, draft: publicValue(item.draft), draftJson: stringify(item.draft, null, 2),
        published: item.published && publicValue(item.published), sampleRunId: item.sample_run_id,
        dictionary: store.dictionary(item.id) ?? null,
      })) : [],
      retention: user.role === 'admin' ? store.setting('retention') : null,
      users: user.role === 'admin' ? store.users() : [],
    };
  }

  saveFolder(user, value) {
    demand(['template', 'job'].includes(value.kind), 'Выберите раздел папки.');
    const workspace = value.kind === 'template' ? id(value.scope) : user.id;
    if (value.kind === 'template') demand(canConfigure(user) && this.store.connection(workspace), 'Доступ к подключению закрыт.');
    const name = folder(value.path);
    demand(name, 'Введите имя папки.');
    this.store.putFolder(value.kind, workspace, name);
  }

  saveConnection(user, raw) {
    demand(canConfigure(user), 'Подключения редактирует настройщик.');
    const value = readJson(raw, 'Подключение');
    demand(object(value), 'Подключение должно быть объектом.');
    const config = validateConnection({ ...value, id: value.id || randomUUID() });
    const before = this.store.connection(config.id);
    this.store.transaction(() => {
      for (const previous of before?.endpoints ?? []) {
        const next = config.endpoints.find(endpoint => endpoint.id === previous.id);
        for (const environment of ['production', 'sandbox']) {
          const field = environment === 'sandbox' ? 'sandbox' : 'url';
          const origin = endpoint => endpoint?.[field] ? new URL(endpoint[field]).origin : null;
          for (const profile of before.profiles) {
            const same = config.profiles.find(item => item.id === profile.id);
            if (origin(previous) !== origin(next) || !same || stringify(same.headers) !== stringify(profile.headers)) {
              this.store.clearSecret(config.id, previous.id, profile.id, environment);
            }
          }
        }
      }
      this.store.putConnection(config);
    });
    return config.id;
  }

  credentialSettings(user, value, save = false) {
    demand(canConfigure(user), 'Подключения редактирует настройщик.');
    const { connectionId, endpointId, profileId, environment } = value;
    const connection = this.store.connection(id(connectionId));
    const endpoint = connection?.endpoints.find(item => item.id === endpointId);
    const profile = connection?.profiles.find(item => item.id === profileId);
    demand(endpoint && profile && ['production', 'sandbox'].includes(environment) &&
      (environment !== 'sandbox' || endpoint.sandbox), 'Выберите адрес, среду и профиль авторизации.');
    if (save) {
      if (value.clear === true) {
        this.store.clearSecret(connectionId, endpointId, profileId, environment);
      } else {
        const auth = Object.fromEntries(profile.headers.map(header => {
          const raw = value.values?.[header.key];
          demand(typeof raw === 'string' && raw.trim() && raw.length <= 16_384 && !/[\r\n]/.test(raw), `Заполните заголовок «${header.name}».`);
          return [header.key, raw.trim()];
        }));
        const expires = value.expires ? Date.parse(`${value.expires}T23:59:59.999Z`) : null;
        demand(expires === null || Number.isFinite(expires), 'Некорректная дата окончания действия.');
        this.store.putSecret(connectionId, endpointId, profileId, environment, this.vault.encrypt(JSON.stringify(auth)), expires);
      }
    }
    const stored = this.store.secretRef(connectionId, endpointId, profileId, environment);
    return { configured: Boolean(stored), expires: stored?.expires ?? null };
  }

  saveDraft(user, raw) {
    demand(canConfigure(user), 'Шаблоны редактирует настройщик.');
    const value = readJson(raw, 'Черновик');
    demand(object(value), 'Черновик должен быть объектом.');
    const connection = this.store.connection(id(value.connectionId));
    const template = validateTemplate({ ...value, id: value.id || randomUUID() }, connection);
    const graph = new Map(this.store.templates().map(item => [item.id, item.published ?? item.draft]));
    graph.set(template.id, template);
    validateGraph(template, graph);
    this.store.putDraft(template);
    return template.id;
  }

  publish(user, templateId) {
    demand(canConfigure(user), 'Версии публикует настройщик.');
    const record = this.store.template(id(templateId));
    demand(record, 'Черновик отсутствует.');
    const draft = validateTemplate(record.draft, this.store.connection(record.draft.connectionId));
    const published = new Map(this.store.templates().filter(item => item.published).map(item => [item.id, item.published]));
    published.set(draft.id, draft);
    validateGraph(draft, published);
    return this.store.transaction(() => this.store.publish(draft.id));
  }

  pack(user, selection) {
    demand(canConfigure(user), 'Пакеты шаблонов экспортирует настройщик.');
    const templates = new Map(this.store.templates().map(item => [item.id, item.published ?? item.draft]));
    const list = new Map();
    function add(template) {
      if (list.has(template.id)) return;
      list.set(template.id, template);
      for (const param of template.parameters) {
        if (param.reference && templates.has(param.reference.templateId)) add(templates.get(param.reference.templateId));
      }
    }
    const connectionIds = new Set();
    if (selection.templateId) {
      const entry = templates.get(id(selection.templateId));
      demand(entry, 'Шаблон отсутствует.');
      add(entry);
    } else {
      const connectionId = id(selection.connectionId);
      demand(this.store.connection(connectionId), 'Подключение отсутствует.');
      connectionIds.add(connectionId);
      for (const item of templates.values()) if (item.connectionId === connectionId) add(item);
    }
    for (const template of list.values()) connectionIds.add(template.connectionId);
    return stringify({
      format: 'mp-api-config', version: 1,
      connections: [...connectionIds].map(connectionId => this.store.connection(connectionId)),
      templates: [...list.values()],
    }, null, 2);
  }

  import(user, raw) {
    demand(canConfigure(user), 'Пакеты шаблонов импортирует настройщик.');
    const document = readJson(raw, 'Пакет');
    demand(document?.format === 'mp-api-config' && document.version === 1 && Array.isArray(document.connections) &&
      Array.isArray(document.templates) && document.connections.length <= 100 && document.templates.length <= 1000,
    'Формат пакета не поддерживается.');
    const connectionMap = new Map(document.connections.map(item => [id(item.id), validateConnection({
      ...item, id: randomUUID(), policyId: item.policyId ?? item.id,
    })]));
    const templateMap = new Map(document.templates.map(item => [id(item.id), randomUUID()]));
    demand(connectionMap.size === document.connections.length && templateMap.size === document.templates.length,
      'Идентификаторы в пакете повторяются.');
    const requests = document.templates.map(item => {
      const connection = connectionMap.get(item.connectionId);
      demand(connection, 'В пакете отсутствует подключение шаблона.');
      const parameters = item.parameters?.map(param => param.reference ? {
        ...param, reference: { ...param.reference, templateId: templateMap.get(param.reference.templateId) },
      } : param);
      return validateTemplate({ ...item, id: templateMap.get(item.id), connectionId: connection.id, parameters }, connection);
    });
    const graph = new Map(requests.map(item => [item.id, item]));
    for (const item of requests) validateGraph(item, graph);
    this.store.transaction(() => {
      for (const connection of connectionMap.values()) this.store.putConnection(connection);
      for (const template of requests) this.store.putDraft(template);
    });
    return { connections: connectionMap.size, templates: requests.length };
  }

  source(user, entry, draft = false, runDay = new Date()) {
    const record = this.store.template(id(entry.templateId));
    demand(record && (draft ? canConfigure(user) : record.published && (canConfigure(user) || record.published.available)),
      'Шаблон недоступен.');
    const definition = draft ? record.draft : record.published;
    const connection = this.store.connection(definition.connectionId);
    const template = validateTemplate(definition, connection);
    const environment = entry.environment ?? 'production';
    demand(['production', 'sandbox'].includes(environment), 'Выберите рабочую или тестовую среду.');
    const source = { template, connection, environment, version: draft ? null : record.version, references: {} };
    const { endpoint, profile } = profileFor(source);
    demand(environment !== 'sandbox' || endpoint.sandbox, 'В подключении отсутствует адрес песочницы.');
    const inputs = typeof entry.values === 'string' ? readJson(entry.values, 'Параметры запуска') : entry.values ?? {};
    source.values = inputValues(template, inputs, true, runDay);
    for (const param of template.parameters) {
      if (!param.reference || (param.reference.mode !== 'all' && source.values[param.name] == null)) continue;
      const reference = this.store.dictionary(param.reference.templateId);
      demand(reference, `Сначала обновите справочник для параметра «${param.label}».`);
      source.references[param.name] = reference.run_id;
    }
    const secret = profile && this.store.secretRef(connection.id, endpoint.id, profile.id, environment);
    source.secretId = secret?.id ?? null;
    source.secretExpires = secret?.expires ?? null;
    return source;
  }

  saveJob(user, value) {
    const jobId = value.id ? id(value.id) : randomUUID();
    const existing = this.store.job(jobId);
    demand(!existing || safeToSee(user, existing.owner), 'Выгрузка недоступна.');
    const owner = existing ? this.store.user(existing.owner) : user;
    demand(Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 30, 'Выберите от 1 до 30 источников.');
    const runDay = new Date();
    const entries = value.entries.map(item => {
      const entry = { templateId: id(item.templateId), environment: item.environment ?? 'production', values: item.values ?? '{}' };
      this.source(owner, entry, false, runDay);
      return entry;
    });
    demand(['xlsx', 'csv'].includes(value.format), 'Выберите XLSX или CSV.');
    const schedule = validateSchedule(value.schedule);
    const job = { id: jobId, name: text(value.name, 'название выгрузки'), folder: folder(value.folder),
      entries, format: value.format, schedule };
    const unchanged = JSON.stringify(existing?.value.schedule ?? null) === JSON.stringify(schedule);
    this.store.putJob(job, owner.id, unchanged);
    return jobId;
  }

  createRun(user, value, now = Date.now()) {
    const runDay = new Date(now);
    if (value.kind === 'job') {
      const job = this.store.job(id(value.jobId));
      demand(job && safeToSee(user, job.owner), 'Выгрузка недоступна.');
      const actor = this.store.user(job.owner);
      const snapshot = { format: job.value.format, sources: job.value.entries.map(entry => this.source(actor, entry, false, runDay)),
        scheduledFor: value.scheduledFor ?? null };
      return this.store.createRun({ owner: job.owner, jobId: job.id, name: job.value.name, kind: 'job', snapshot, now });
    }
    demand(canConfigure(user) && ['test', 'dictionary'].includes(value.kind), 'Запуск доступен настройщику.');
    const source = this.source(user, value.entry, value.kind === 'test', runDay);
    return this.store.createRun({ owner: user.id, name: source.template.name, kind: value.kind, snapshot: { sources: [source] }, now });
  }

  credentials(runId) {
    const run = this.store.run(runId);
    return run.snapshot.sources.map(source => {
      if (!source.secretId) return {};
      const secret = this.store.secret(source.secretId);
      if (!secret) return {};
      try { return JSON.parse(this.vault.decrypt(secret.encrypted)); } catch { return {}; }
    });
  }

  getRun(user, runId) {
    const run = this.store.run(id(runId));
    demand(run && safeToSee(user, run.owner), 'Запуск недоступен.');
    return run;
  }

  runSummary(user, runId) {
    const run = this.getRun(user, runId);
    const { snapshot, ...summary } = run;
    return {
      ...summary, sources: snapshot.sources.map(source => ({
        name: source.template.name, version: source.version, environment: source.environment,
        values: stringify(source.resolved ?? source.values, null, 2),
      })),
    };
  }

  async result(user, value) {
    const run = this.getRun(user, value.runId);
    demand(Number.isInteger(value.source) && run.snapshot.sources[value.source], 'Источник отсутствует.');
    demand(Number.isSafeInteger(value.offset) && value.offset >= 0, 'Некорректная страница просмотра.');
    return preview(this.store, run, value.source, value.offset);
  }

  async testSample(user, templateId) {
    demand(canConfigure(user), 'Образец доступен настройщику.');
    const record = this.store.template(id(templateId));
    return record?.sample_run_id ? sample(this.store, record.sample_run_id, 0) : null;
  }

  async dictionaryOptions(user, value) {
    const record = this.store.template(id(value.templateId));
    const definition = value.draft && canConfigure(user) ? record?.draft : record?.published;
    demand(definition && (canConfigure(user) || definition.available), 'Этот шаблон недоступен.');
    const reference = definition.parameters.find(parameter => parameter.name === value.parameter)?.reference;
    demand(reference, 'Параметр не связан со справочником.');
    const dictionary = this.store.dictionary(reference.templateId);
    if (!dictionary) return { updated: null, values: [], more: false };
    const run = this.store.run(dictionary.run_id);
    const offset = value.offset ?? 0;
    demand(Number.isSafeInteger(offset) && offset >= 0, 'Некорректная страница справочника.');
    const values = [];
    let index = 0;
    for await (const item of referenceValues(this.store, run, reference.path)) {
      if (index++ < offset) continue;
      values.push(stringify(item));
      if (values.length > 100) break;
    }
    return { updated: dictionary.updated, values: values.slice(0, 100), more: values.length > 100,
      rows: run.progress.sources[0].rows };
  }

  logPath(user, value) {
    if (value.runId) return runLog(this.store, this.getRun(user, value.runId).id);
    demand(canConfigure(user), 'Общий журнал доступен настройщику.');
    if (!value.day) return generalLog(this.store);
    demand(/^\d{4}-\d{2}-\d{2}$/.test(value.day), 'Укажите дату журнала.');
    return path.join(this.store.root, 'logs', `${value.day}.ndjson`);
  }

  async logs(user, value) {
    return logTail(this.logPath(user, value));
  }

  async startScheduled(now, dispatch) {
    for (const job of this.store.jobs()) {
      const decision = scheduleDecision(job, this.store.activeJob(job.id), now);
      if (!decision) continue;
      const { cursor, pendingAt, pendingSlot, start, scheduledFor } = decision;
      let runId;
      let failure;
      this.store.transaction(() => {
        this.store.scheduleJob(job.id, cursor, pendingAt, pendingSlot);
        if (!start) return;
        const user = this.store.user(job.owner);
        try {
          runId = this.createRun(user, { kind: 'job', jobId: job.id, scheduledFor }, now);
        } catch (error) {
          failure = error instanceof InputError ? error.message : 'Не удалось запланировать выгрузку.';
          const id = this.store.createRun({ owner: job.owner, jobId: job.id, name: job.value.name, kind: 'job',
            snapshot: { sources: [], scheduledFor } });
          this.store.updateRun(id, 'failed', { error: failure });
          runId = id;
        }
      });
      if (failure) await logEvent(this.store, runId, 'schedule_failed', { problem: failure }, true);
      if (runId && !failure) dispatch(runId);
    }
  }

  async recover(dispatch) {
    for (const { id: runId, state } of this.store.activeRuns()) {
      if (state === 'queued') { dispatch(runId); continue; }
      const run = this.store.run(runId);
      run.progress.sources ??= {};
      for (const [index, source] of run.snapshot.sources.entries()) {
        const progress = run.progress.sources[index] ??= { name: source.template.name, rows: 0, state: 'interrupted' };
        progress.rows = this.store.pages(runId, index).reduce((total, page) => total + page.rows, 0);
        if (progress.state === 'running') progress.state = 'interrupted';
      }
      delete run.progress.waiting;
      delete run.progress.exporting;
      this.store.updateRun(runId, 'interrupted', run.progress);
      await logEvent(this.store, runId, 'interrupted', {}, true);
      const allComplete = run.snapshot.sources.length && Object.values(run.progress.sources).every(source => source.state === 'completed');
      const resumable = (run.kind === 'job' && allComplete) || run.snapshot.sources.some((source, index) =>
        source.template.recovery !== 'decision' && run.progress.sources[index].state !== 'completed');
      if (!resumable || run.kind === 'test') continue;
      for (const [index, source] of run.snapshot.sources.entries()) {
        if (run.progress.sources?.[index]?.state === 'completed') continue;
        if (source.template.recovery === 'decision') {
          source.skipOnRecovery = true;
        } else if (source.template.recovery === 'restart') {
          this.store.db.prepare('DELETE FROM pages WHERE run_id = ? AND source = ?').run(runId, index);
          await fs.rm(path.join(this.store.root, 'data', 'runs', runId, `source-${index + 1}`), { recursive: true, force: true });
        }
      }
      this.store.readyRun(runId, run.snapshot);
      this.store.updateRun(runId, 'queued', run.progress);
      dispatch(runId);
    }
  }
}

module.exports = { Service, canConfigure, safeToSee, validateGraph };
