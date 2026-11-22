const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
const { exportRun, logTail, previewProcessing, runLog, sample, writePage } = require('../src/core/datasets.cjs');
const { parseJson, stringify } = require('../src/core/json.cjs');
const { LimitScheduler } = require('../src/core/limits.cjs');
const { batches, inputValues, requestFor, validateConnection, validateTemplate } = require('../src/core/model.cjs');
const { CLUSTERS_COLUMNS, FUNNEL_COLUMNS, FUNNEL_PATH } = require('../src/core/processings.cjs');
const { executeRun } = require('../src/core/runner.cjs');
const { DEFER_MS, scheduleDecision } = require('../src/core/schedule.cjs');
const { Service } = require('../src/core/service.cjs');
const { START_PASSWORD, Store } = require('../src/core/store.cjs');

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-api-test-'));
  const store = new Store(root);
  const vault = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: encrypted => Buffer.from(encrypted, 'base64').toString() };
  const service = new Service(store, vault);
  const admin = store.authenticate('admin', START_PASSWORD);
  const user = store.changePassword(admin.id, START_PASSWORD, 'FixturePassword!234');
  const requests = [];
  let server;
  if (handler) {
    server = http.createServer(async (req, res) => {
      try {
        const buffers = [];
        for await (const buffer of req) buffers.push(buffer);
        const request = { url: new URL(req.url, 'http://localhost'), method: req.method, headers: req.headers,
          body: Buffer.concat(buffers).toString() };
        requests.push(request);
        const result = await handler(request, requests.length);
        res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json', ...(result.headers ?? {}) });
        res.end(result.body);
      } catch {
        res.writeHead(500).end('{"detail":"Ошибка заглушки"}');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const item of store.connections()) {
      store.putConnection({ ...item, endpoints: item.endpoints.map(endpoint => ({ ...endpoint, url, sandbox: url })) });
    }
  }
  for (const connection of store.connections()) {
    const endpoint = connection.endpoints[0];
    const profile = connection.profiles[0];
    service.credentialSettings(user, {
      connectionId: connection.id, endpointId: endpoint.id, profileId: profile.id, environment: 'production',
      values: Object.fromEntries(profile.headers.map(header => [header.key, `fixture-${header.key}`])),
    }, true);
  }
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  let clock = Date.now();
  const wait = async ms => { clock += ms; };
  const limiter = new LimitScheduler({ wait, now: () => clock });
  return { store, service, user, requests,
    run: (runId, options) => executeRun(store, runId, service.credentials(runId), { limiter, wait, ...options }) };
}

test('три шаблона работают через HTTP, разбивают период и список, сохраняют страницы и XLSX', async t => {
  const fx = await fixture(t, request => {
    if (request.url.pathname === '/api/v3/orders') {
      return { body: request.url.searchParams.get('next') === '0'
        ? '{"next":9223372036854775807,"orders":[{"id":9223372036854775806,"article":"FBS"}]}'
        : '{"next":0,"orders":[]}' };
    }
    if (request.url.pathname === '/v2/warehouse/list') {
      const payload = parseJson(request.body);
      return { body: payload.cursor
        ? '{"cursor":"","has_next":false,"warehouses":[{"warehouse_id":2,"name":"Второй"}]}'
        : '{"cursor":"Q+/==","has_next":true,"warehouses":[{"warehouse_id":9223372036854775805,"name":"Первый"}]}' };
    }
    return { body: request.url.searchParams.has('pageToken')
      ? '{"status":"OK","result":{"shipments":[{"status":"ERROR","id":9223372036854775804}],"paging":{}}}'
      : '{"status":"OK","result":{"shipments":[],"paging":{"nextPageToken":"Z+ /"}}}' };
  });
  const { service, store, user } = fx;
  const ids = Array.from({ length: 201 }, (_, index) => String(index + 1));
  ids[200] = '9223372036854775803';
  const job = service.saveJob(user, { name: 'Маркеты', folder: 'Сводки / Ноябрь', format: 'xlsx', entries: [
    { templateId: 'wb-orders', values: '{"dateFrom":"2026-09-01","dateTo":"2026-10-05"}' },
    { templateId: 'ozon-warehouses', values: `{"warehouse_ids":[${ids.join(',')}]}` },
    { templateId: 'yandex-shipments', values: '{"campaignId":9223372036854775802,"cancelledOrders":false,"orderIds":null}' },
  ] });
  const runId = service.createRun(user, { kind: 'job', jobId: job });
  assert.throws(() => service.createRun(user, { kind: 'job', jobId: job }), /уже выполняется/);
  await fx.run(runId);
  const run = store.run(runId);
  assert.equal(run.state, 'completed');
  assert.deepEqual(Object.values(run.progress.sources).map(source => source.rows), [2, 4, 1]);
  assert.equal(run.snapshot.sources[1].version, 1);
  const [wb1, wb2, wb3, wb4, oz1, oz2, oz3, oz4, ym1, ym2] = fx.requests;
  assert.equal(fx.requests.length, 10);
  assert.equal(wb1.method, 'GET');
  assert.equal(wb1.headers.authorization, 'fixture-token');
  assert.equal(wb1.url.searchParams.get('limit'), '1000');
  assert.equal(wb2.url.searchParams.get('next'), '9223372036854775807');
  assert.equal(Number(wb3.url.searchParams.get('dateFrom')) - Number(wb1.url.searchParams.get('dateTo')), 1);
  assert.equal(wb3.url.searchParams.get('next'), '0');
  assert.equal(wb4.url.searchParams.get('dateTo'), String(Date.parse('2026-10-05T23:59:59Z') / 1000));
  assert.equal(oz1.method, 'POST');
  assert.equal(oz1.headers['client-id'], 'fixture-clientId');
  assert.equal(oz1.headers['api-key'], 'fixture-key');
  assert.equal(parseJson(oz1.body).warehouse_ids.length, 200);
  assert.equal(parseJson(oz2.body).cursor, 'Q+/==');
  assert.match(oz3.body, /"warehouse_ids":\[9223372036854775803\]/);
  assert.equal(parseJson(oz3.body).cursor, undefined);
  assert.equal(parseJson(oz4.body).cursor, 'Q+/==');
  assert.equal(ym1.method, 'PUT');
  assert.match(ym1.url.pathname, /\/9223372036854775802\//);
  assert.equal(ym1.url.searchParams.get('limit'), '30');
  assert.deepEqual(JSON.parse(ym1.body), { cancelledOrders: false, orderIds: null });
  assert.equal(ym2.url.searchParams.get('pageToken'), 'Z+ /');
  assert.ok(run.progress.exportPath, run.progress.exportError);
  const workbook = new ExcelJS.Workbook();
  const files = await fs.readdir(run.progress.exportPath);
  await workbook.xlsx.readFile(path.join(run.progress.exportPath, files.find(filename => filename.endsWith('.xlsx'))));
  assert.equal(workbook.worksheets.length, 3);
  assert.equal(workbook.worksheets[0].getCell('A2').value, '9223372036854775806');
  assert.equal(workbook.worksheets[1].getCell('A2').value, '9223372036854775805');
  const split = await exportRun(store, run, 'xlsx', { rowLimit: 2 });
  assert.equal((await fs.readdir(split)).filter(filename => filename.endsWith('.xlsx')).length, 2);
  const csv = await exportRun(store, run, 'csv');
  assert.match(await fs.readFile(path.join(csv, '01-Сборочные задания FBS.csv'), 'utf8'), /9223372036854775806/);
  assert.doesNotMatch(await logTail(runLog(store, runId)), /fixture-(token|key|clientId)/);
});

test('сетевой журнал сохраняет адрес, метод и причину сбоя без значений параметров и ключей', async t => {
  const fx = await fixture(t);
  const runId = fx.service.createRun(fx.user, { kind: 'test', entry: {
    templateId: 'yandex-shipments', values: '{"campaignId":1234567890,"orderIds":[9876543210]}',
  } });
  await fx.run(runId, { fetcher: async (_url, options) => {
    assert.equal(options.headers.get('api-key'), 'fixture-key');
    const error = new Error('net::ERR_NAME_NOT_RESOLVED');
    throw new TypeError('Internal URL contains fixture-key', { cause: error });
  } });
  const log = await logTail(runLog(fx.store, runId));
  assert.doesNotMatch(log, /fixture-key|1234567890|9876543210|Internal URL/);
  const events = log.trim().split('\n').map(line => JSON.parse(line));
  const requests = events.filter(item => item.type === 'request');
  const failures = events.filter(item => item.type === 'network_error');
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].url, 'https://api.partner.market.yandex.ru/v2/campaigns/%7BcampaignId%7D/first-mile/shipments');
  assert.deepEqual(requests[0].queryFields, ['limit']);
  assert.deepEqual(requests[0].bodyFields, ['orderIds']);
  assert.deepEqual(requests.map(item => item.attempt), [1, 2, 3]);
  assert.deepEqual(failures.map(item => item.code), Array(3).fill('ERR_NAME_NOT_RESOLVED'));
  assert.ok(failures.every(item => Number.isSafeInteger(item.elapsedMs)));
  assert.match(fx.store.run(runId).progress.sources[0].error, /DNS.*ERR_NAME_NOT_RESOLVED/);
});

test('неверная структура и повтор курсора дают неполный результат без потери строк', async t => {
  const fx = await fixture(t, request => {
    if (request.url.pathname === '/api/v3/orders') return { body: '{"next":0,"orders":[{"id":1}]}' };
    if (request.url.pathname === '/v2/warehouse/list') return { body: '{"warehouses":[],"has_next":"false"}' };
    return { body: '{"status":"ERROR","result":{"shipments":[]}}' };
  });
  const job = fx.service.saveJob(fx.user, { name: 'Ошибки', format: 'csv', entries: [
    { templateId: 'wb-orders' }, { templateId: 'ozon-warehouses' }, { templateId: 'yandex-shipments', values: '{"campaignId":11}' },
  ] });
  const runId = fx.service.createRun(fx.user, { kind: 'job', jobId: job });
  await fx.run(runId);
  const run = fx.store.run(runId);
  assert.equal(run.state, 'partial');
  assert.equal(run.progress.sources[0].state, 'partial');
  assert.match(run.progress.sources[0].error, /не продвинулся/);
  assert.match(run.progress.sources[1].error, /boolean/);
  assert.match(run.progress.sources[2].error, /ошибке в теле/);
  assert.equal(fx.requests.length, 3);
  assert.equal(fx.store.pages(runId, 0)[0].rows, 1);
  assert.match(run.progress.exportPath, /ЧАСТИЧНО/);
});

test('тест черновика сохраняет образец при несовпадении схемы и не запрашивает следующую страницу', async t => {
  const fx = await fixture(t, () => ({ body: '{"other":[{"wide":9223372036854775807}],"next":1}' }));
  const runId = fx.service.createRun(fx.user, { kind: 'test', entry: { templateId: 'wb-orders' } });
  await fx.run(runId);
  assert.equal(fx.store.run(runId).state, 'failed');
  assert.equal(fx.requests.length, 1);
  assert.equal(fx.store.template('wb-orders').sample_run_id, runId);
  const received = await sample(fx.store, runId, 0);
  assert.equal(received.shape.other[0].wide, 'int64');
  assert.match(received.text, /9223372036854775807/);
});

test('после прерывания безопасный запуск продолжает зафиксированную страницу и версию', async t => {
  let during;
  const fx = await fixture(t, () => {
    during = fx.store.run(id).progress.sources[0].requests;
    return { body: '{"orders":[],"next":0}' };
  });
  const job = fx.service.saveJob(fx.user, { name: 'Возобновление', format: 'csv', entries: [{ templateId: 'wb-orders' }] });
  const id = fx.service.createRun(fx.user, { kind: 'job', jobId: job });
  await writePage(fx.store, id, 0, 0, 0, [{ id: 1 }]);
  fx.store.commitPage(id, 0, 0, 0, parseJson('{"value":9223372036854775807}'), 1, 'more', null);
  fx.store.updateRun(id, 'running', { sources: { 0: { name: 'Сборочные задания FBS', state: 'running', rows: 1 } } });
  const draft = fx.store.template('wb-orders').draft;
  fx.service.saveDraft(fx.user, stringify({ ...draft, name: 'Другая версия', path: '/new-path' }));
  fx.service.publish(fx.user, draft.id);
  const pending = [];
  await fx.service.recover(runId => pending.push(runId));
  assert.deepEqual(pending, [id]);
  assert.equal(fx.store.run(id).finished_at, null);
  await fx.run(id);
  assert.equal(fx.requests.length, 1);
  assert.equal(fx.requests[0].url.searchParams.get('next'), '9223372036854775807');
  assert.equal(fx.requests[0].url.pathname, '/api/v3/orders');
  assert.equal(fx.store.run(id).state, 'completed');
  assert.equal(fx.store.pages(id, 0).length, 2);
  assert.deepEqual(during, { done: 1, failed: 0, remaining: 1, exact: false });
  assert.deepEqual(fx.store.run(id).progress.sources[0].requests, { done: 2, failed: 0, remaining: 0, exact: true });
});

test('прогресс показывает остаток в ожидании лимита и учитывает повтор как тот же запрос', async t => {
  let runId;
  const steps = [];
  let triedSecond = false;
  const fx = await fixture(t, request => {
    const id = Number(request.url.searchParams.get('id'));
    const current = fx.store.run(runId);
    steps.push({ id, ...current.progress.sources[0].requests });
    if (id === 2 && !triedSecond) {
      triedSecond = true;
      return { status: 429, body: '{}', headers: { 'Retry-After': '2' } };
    }
    if (id === 2) return { status: 400, body: '{}' };
    return { body: JSON.stringify([{ id }]) };
  });
  const { service, store, user } = fx;
  const templateId = service.saveDraft(user, stringify({ connectionId: 'wildberries', endpointId: 'marketplace',
    name: 'Запросы по списку', method: 'GET', path: '/example', safeToRetry: true,
    parameters: [{ name: 'id', where: 'query', type: 'array', items: { type: 'integer' }, batchSize: 1, encoding: 'csv' }],
    limits: [{ id: 'example', type: 'bucket', refillMs: 200, burst: 1 }], response: { rows: '$' } }));
  service.publish(user, templateId);
  const processingId = service.saveProcessing(user, { templateId, name: 'Артикулы', columns: [{ path: 'id', name: 'ID' }] });
  const jobId = service.saveJob(user, { name: 'Выгрузка', format: 'csv', entries: [{ templateId, processingId, values: '{"id":[1,2,3]}' }] });
  runId = service.createRun(user, { kind: 'job', jobId });
  let waiting;
  await fx.run(runId, { wait: async () => { waiting = store.run(runId); } });
  assert.deepEqual(steps.map(({ id, done, failed, remaining }) => [id, done, failed, remaining]),
    [[1, 0, 0, 3], [2, 1, 0, 2], [2, 1, 0, 2], [3, 2, 1, 1]]);
  assert.ok(steps.every(step => step.exact));
  assert.equal(waiting.state, 'waiting');
  assert.deepEqual(waiting.progress.sources[0].requests, { done: 1, failed: 0, remaining: 2, exact: true });
  assert.equal(waiting.finished_at, null);
  const run = store.run(runId);
  assert.equal(run.state, 'partial');
  assert.deepEqual(run.progress.sources[0].requests, { done: 3, failed: 1, remaining: 0, exact: true });
  assert.ok(run.finished_at >= run.created);
  const summary = service.runSummary(user, runId);
  assert.equal(summary.finished_at, run.finished_at);
  assert.equal(service.workspace(user).runs.find(item => item.id === runId).finished_at, run.finished_at);
  const csv = await fs.readFile(path.join(run.progress.exportPath, '01-Артикулы.csv'), 'utf8');
  assert.equal(csv, '\ufeffID\r\n1\r\n3\r\n');
  store.updateRun(runId, run.state, { ...run.progress, exportPath: 'другой экспорт' }, run.finished_at + 1000);
  assert.equal(store.run(runId).finished_at, run.finished_at);
  assert.equal(store.run(runId).updated, run.finished_at + 1000);
});

test('время завершения старых запусков восстанавливается из журнала', async t => {
  const { store, user } = await fixture(t);
  const created = Date.now() - 10_000;
  const start = () => store.createRun({ owner: user.id, name: 'История', kind: 'test', snapshot: { sources: [] }, now: created });
  const recorded = start();
  const missing = start();
  const finished = created + 2000;
  store.updateRun(recorded, 'completed', {}, finished);
  store.updateRun(recorded, 'completed', {}, finished + 1500);
  store.updateRun(missing, 'cancelled', {}, finished);
  const filename = runLog(store, recorded);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify({ at: new Date(finished).toISOString(), type: 'finished', state: 'completed' })}\n`);

  store.db.exec('ALTER TABLE runs DROP COLUMN finished_at');
  const reopened = new Store(store.root);
  try {
    assert.equal(reopened.run(recorded).finished_at, null);
    await new Service(reopened, null).restoreFinishedTimes();
    assert.equal(reopened.run(recorded).finished_at, finished);
    assert.equal(reopened.run(recorded).updated, finished + 1500);
    assert.equal(reopened.run(missing).finished_at, null);
  } finally {
    reopened.close();
  }
});

test('справочник обновляется явно, переносится описанием и защищён от циклов', async t => {
  const fx = await fixture(t, () => ({ body: '{"warehouses":[{"warehouse_id":9223372036854775807}],"has_next":false}' }));
  const { store, service, user } = fx;
  const original = store.template('ozon-warehouses').draft;
  const dependent = service.saveDraft(user, stringify({ ...original, id: 'dependent', parameters: original.parameters.map(parameter =>
    parameter.name === 'warehouse_ids' ? { ...parameter, reference: { templateId: original.id, mode: 'all', path: 'warehouse_id' } } : parameter) }));
  service.publish(user, dependent);
  assert.throws(() => service.createRun(user, { kind: 'test', entry: { templateId: dependent } }), /Сначала обновите/);
  const refresh = service.createRun(user, { kind: 'dictionary', entry: { templateId: original.id } });
  await fx.run(refresh);
  const result = service.createRun(user, { kind: 'test', entry: { templateId: dependent } });
  await fx.run(result);
  assert.match(fx.requests[1].body, /"warehouse_ids":\[9223372036854775807\]/);
  assert.equal(store.run(result).snapshot.sources[0].references.warehouse_ids, refresh);
  assert.throws(() => service.saveDraft(user, stringify({ ...original, parameters: store.template(dependent).draft.parameters.map(parameter =>
    parameter.reference ? { ...parameter, reference: { ...parameter.reference, templateId: dependent } } : parameter) })), /цикл/);
  const content = service.pack(user, { templateId: dependent });
  assert.doesNotMatch(content, /fixture-key|fixture-clientId/);
  assert.deepEqual(service.import(user, content), { connections: 1, templates: 2 });
});

test('пакеты не содержат ключей, конечный адрес защищён, параметры обычного пользователя ограничены', async t => {
  const fx = await fixture(t);
  const { service, store, user } = fx;
  const viewer = store.createUser('test-user', 'Viewer!23456', 'user');
  assert.equal(service.workspace(viewer).connections.length, 0);
  assert.equal(service.workspace(viewer).options.length, 3);
  assert.throws(() => service.pack(viewer, { connectionId: 'ozon' }), /настройщик/);
  assert.throws(() => service.credentialSettings(viewer, {}), /настройщик/);
  const initial = store.connection('wildberries');
  service.saveConnection(user, stringify({ ...initial, endpoints: initial.endpoints.map((endpoint, index) =>
    index ? endpoint : { ...endpoint, url: 'https://example.com' }) }));
  assert.equal(store.secretRef(initial.id, 'marketplace', 'default', 'production'), undefined);
  const template = store.template('wb-orders').published;
  const source = { connection: store.connection(initial.id), template, environment: 'production' };
  assert.throws(() => requestFor(source, { limit: 1000 }, { link: 'https://different.example/path' }), /за пределы/);
  assert.throws(() => service.saveDraft(user, stringify({ ...template, path: '//other.example' })), /относительным/);
});

test('разбиение по байтам применяется только к разрешённому списку', () => {
  const connection = validateConnection({ id: 'example', name: 'Example', endpoints: [{ id: 'api', name: 'API', url: 'https://example.com' }] });
  const template = validateTemplate({ id: 'bytes', name: 'Bytes', connectionId: connection.id, endpointId: 'api',
    method: 'PUT', path: '/rows', maxBodyBytes: 48,
    parameters: [{ name: 'ids', type: 'array', where: 'body', items: { type: 'string' }, splitForBody: true }],
    response: { rows: '$' } }, connection);
  const values = inputValues(template, { ids: ['кириллица', 'ещё строка', 'и ещё'] });
  const output = [...batches({ template, connection, environment: 'production' }, values)];
  assert.ok(output.length > 1);
  assert.deepEqual(output.flatMap(item => item.ids), values.ids);
});

test('лимиты общие для шаблонов и учитывают параллельность, 4XX, ресурсную квоту и Retry-After', async () => {
  let now = 1_800_000_000_000;
  const waited = [];
  const limiter = new LimitScheduler({ now: () => now, wait: async ms => { now += ms; waited.push(ms); } });
  const connection = { policyId: 'provider', account: 'seller', limits: [] };
  const env = { connection, environment: 'production' };
  const wb = { ...env, template: { limits: [{ id: 'bucket', type: 'bucket', burst: 1, refillMs: 200, badRequestCost: 10 }] } };
  const first = await limiter.acquire(wb, {}, {});
  first(400);
  const second = await limiter.acquire({ ...wb, template: { ...wb.template, id: 'other' } }, {}, {});
  assert.deepEqual(waited, [2000]);
  second(429, new Headers({ 'retry-after': '3' }));
  const third = await limiter.acquire(wb, {}, {});
  assert.deepEqual(waited, [2000, 3000]);
  third(200);
  const ym = { ...env, template: { limits: [
    { id: 'parallel', type: 'concurrency', max: 1, scopeParam: ['campaignId'] },
    { id: 'quota', type: 'resource', scopeParam: ['campaignId'] },
  ] } };
  const campaign1 = await limiter.acquire(ym, { campaignId: 1 }, {});
  const campaign2 = await limiter.acquire(ym, { campaignId: 2 }, {});
  campaign2(200);
  campaign1(420, new Headers({
    'x-ratelimit-resource-remaining': '0', 'x-ratelimit-resource-until': new Date(now + 10_000).toISOString(),
  }));
  assert.equal((await limiter.acquire(ym, { campaignId: 2 }, {}))(200), null);
  assert.equal(waited.length, 2);
  (await limiter.acquire(ym, { campaignId: 1 }, {}))(200);
  assert.equal(waited.at(-1), 10_000);
});

test('расписание догоняет только последнее событие и перепроверяет через 10 минут', () => {
  const now = new Date(2026, 10, 19, 12).valueOf();
  const start = new Date(2026, 10, 19, 9).valueOf();
  const job = { value: { schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' } },
    schedule_cursor: now - 3 * 86_400_000, pending_at: null, pending_slot: null };
  const deferred = scheduleDecision(job, true, now);
  assert.deepEqual(deferred, { cursor: start, pendingAt: now + DEFER_MS, pendingSlot: start, start: false });
  const pending = { ...job, schedule_cursor: deferred.cursor, pending_at: deferred.pendingAt, pending_slot: deferred.pendingSlot };
  assert.equal(scheduleDecision(pending, false, now + 60_000), null);
  assert.equal(scheduleDecision(pending, true, now + DEFER_MS).pendingAt, now + 2 * DEFER_MS);
  const due = scheduleDecision(pending, false, now + DEFER_MS);
  assert.equal(due.start, true);
  assert.equal(due.scheduledFor, start);
});

test('расписание сдвигает относительный период каждый день и сохраняет фиксированные даты', async t => {
  const fx = await fixture(t, () => ({ body: '{"orders":[],"next":0}' }));
  const firstDay = new Date(2026, 4, 12, 9);
  const nextDay = new Date(2026, 4, 13, 9);
  const values = '{"dateFrom":{"daysFromRun":-1},"dateTo":{"daysFromRun":0}}';
  const jobId = fx.service.saveJob(fx.user, { name: 'Скользящий период', format: 'csv',
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' },
    entries: [
      { templateId: 'wb-orders', values },
      { templateId: 'wb-orders', values: '{"dateFrom":"2026-05-01","dateTo":"2026-05-02"}' },
    ],
  });
  fx.store.scheduleJob(jobId, firstDay.valueOf() - 1000, null, null);
  const started = [];
  const enqueue = runId => started.push(runId);
  await fx.service.startScheduled(firstDay.valueOf(), enqueue);
  await fx.run(started[0]);
  await fx.service.startScheduled(nextDay.valueOf(), enqueue);
  await fx.run(started[1]);
  assert.equal(started.length, 2);
  const periods = started.map(id => fx.store.run(id).snapshot.sources.map(({ values }) => [values.dateFrom, values.dateTo]));
  assert.deepEqual(periods, [
    [['2026-05-11', '2026-05-12'], ['2026-05-01', '2026-05-02']],
    [['2026-05-12', '2026-05-13'], ['2026-05-01', '2026-05-02']],
  ]);
  assert.equal(fx.store.job(jobId).value.entries[0].values, values);
  assert.equal(fx.requests[0].url.searchParams.get('dateFrom'), String(Date.parse('2026-05-11T00:00:00Z') / 1000));
  assert.equal(fx.requests[2].url.searchParams.get('dateTo'), String(Date.parse('2026-05-13T23:59:59Z') / 1000));
});

test('относительные даты разрешаются во вложенных полях и сохраняют местное время', () => {
  const connection = validateConnection({ id: 'example', name: 'Example', endpoints: [{ id: 'api', name: 'API', url: 'https://example.com' }] });
  const template = validateTemplate({ id: 'period', name: 'Period', connectionId: connection.id, endpointId: 'api',
    method: 'POST', path: '/rows', parameters: [
      { name: 'period', type: 'object', where: 'body', properties: {
        start: { type: 'datetime' }, days: { type: 'array', items: { type: 'date' } },
      } },
    ], response: { rows: '$' },
  }, connection);
  const day = new Date(2026, 2, 8, 23, 15);
  const values = { period: { start: { daysFromRun: -1, time: '09:30' }, days: [{ daysFromRun: -8 }, '2026-03-08'] } };
  assert.deepEqual(inputValues(template, values, false, day), {
    period: { start: new Date(2026, 2, 7, 9, 30).toISOString(), days: ['2026-02-28', '2026-03-08'] },
  });
  assert.throws(() => inputValues(template, { period: { days: [{ daysFromRun: 0.5 }] } }, false, day), /целое смещение/);
});

test('обработка воронки разворачивает периоды в новые строки из сохранённых и свежих данных', async t => {
  const responses = JSON.stringify({ data: { products: [
    { product: { nmId: '9007199254740993', title: 'Карточка', vendorCode: '0001', brandName: 'Марка', stocks: { balanceSum: 12 } },
      statistic: {
        selected: { period: { start: '2026-11-18', end: '2026-11-19' }, orderCount: 0, timeToReady: { days: 1 },
          wbClub: { orderCount: 0 }, conversions: { buyoutPercent: 76 } },
        past: { period: { start: '2026-11-16', end: '2026-11-17' }, orderCount: 5 },
        comparison: { orderCountDynamic: 100 },
      } },
    { product: { nmId: 222, title: 'Вторая карточка' }, statistic: {
      selected: { period: { start: '2026-11-18', end: '2026-11-19' } }, past: {},
    } },
  ] } });
  const fx = await fixture(t, () => ({ body: responses }));
  const { service, user, store } = fx;
  const draft = service.saveDraft(user, stringify({
    id: 'funnel', name: 'Исходная статистика', connectionId: 'wildberries', endpointId: 'marketplace',
    method: 'POST', path: FUNNEL_PATH, available: true, response: { rows: 'data.products',
      columns: [{ name: 'Статистика (JSON)', path: 'statistic' }] },
  }));
  service.publish(user, draft);
  const processingId = service.saveProcessing(user, { templateId: draft, name: 'Разворот воронки' });
  const originalJob = service.saveJob(user, {
    name: 'Исходник', format: 'csv', entries: [{ templateId: draft }],
  });
  const originalId = service.createRun(user, { kind: 'job', jobId: originalJob });
  await fx.run(originalId);
  const raw = store.run(originalId);
  const variant = service.processingFromRun(user, raw, { processingId, source: 0 });
  const output = await exportRun(store, raw, 'xlsx', variant);
  assert.equal(fx.requests.length, 1);
  assert.ok(await fs.stat(raw.progress.exportPath));
  const meta = JSON.parse(await fs.readFile(path.join(output, 'результат.json'), 'utf8'));
  assert.deepEqual(meta.tables, [{ name: 'Разворот воронки', rows: 3 }]);
  const workbook = new ExcelJS.Workbook();
  const filename = (await fs.readdir(output)).find(name => name.endsWith('.xlsx'));
  await workbook.xlsx.readFile(path.join(output, filename));
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), FUNNEL_COLUMNS.map(column => column.name));
  assert.equal(sheet.rowCount, 4);
  const cell = (row, field) => sheet.getRow(row).getCell(FUNNEL_COLUMNS.findIndex(column => column.path === field) + 1).value;
  assert.deepEqual(sheet.getRow(2).values.slice(1, 9),
    ['9007199254740993', 'Карточка', '0001', 'Марка', 12, 'Текущий', '2026-11-18', '2026-11-19']);
  assert.deepEqual(sheet.getRow(3).values.slice(1, 9),
    ['9007199254740993', 'Карточка', '0001', 'Марка', 12, 'Предыдущий', '2026-11-16', '2026-11-17']);
  assert.equal(cell(2, 'statistic.orderCount'), 0);
  assert.equal(cell(3, 'statistic.orderCount'), 5);
  assert.equal(cell(2, 'statistic.timeToReady.days'), 1);
  assert.equal(cell(2, 'statistic.conversions.buyoutPercent'), 76);
  assert.equal(cell(3, 'statistic.conversions.buyoutPercent'), null);
  assert.equal(cell(4, 'product.nmId'), 222);

  const processedJob = service.saveJob(user, { name: 'Обработанные данные', format: 'csv',
    entries: [{ templateId: draft, processingId }, { templateId: draft }] });
  const processedId = service.createRun(user, { kind: 'job', jobId: processedJob });
  service.saveProcessing(user, { id: processingId, templateId: draft, name: 'Другое имя', columns: FUNNEL_COLUMNS.slice(0, 5) });
  await fx.run(processedId);
  const processed = store.run(processedId);
  assert.equal(processed.state, 'completed');
  const info = JSON.parse(await fs.readFile(path.join(processed.progress.exportPath, 'результат.json'), 'utf8'));
  assert.deepEqual(info.tables, [
    { name: 'Разворот воронки', rows: 3 }, { name: 'Исходная статистика', rows: 2 },
  ]);
  const preview = await service.result(user, { runId: processedId, source: 0, offset: 0 });
  assert.equal(preview.rows.length, 3);
  assert.equal(preview.rows[1].periodType, 'Предыдущий');
});

function installAdvertising(fx) {
  const { service, user, store } = fx;
  const bundle = require('../examples/wb-search-clusters.json');
  assert.deepEqual(service.import(user, JSON.stringify(bundle)), { connections: 1, templates: 3 });
  const connection = store.connections().find(item => item.name === bundle.connections[0].name);
  const url = store.connection('wildberries').endpoints[0].url;
  service.saveConnection(user, stringify({ ...connection, endpoints: [{ ...connection.endpoints[0], url }] }));
  service.credentialSettings(user, {
    connectionId: connection.id, endpointId: 'advert', profileId: 'default', environment: 'production',
    values: { token: 'fixture-advert-token' },
  }, true);
  const templates = bundle.templates.map(item => store.templates().find(record =>
    record.draft.connectionId === connection.id && record.draft.path === item.path));
  assert.throws(() => service.publish(user, templates[2].id), /справочника из того же подключения/);
  for (const template of templates) service.publish(user, template.id);
  return templates.map(template => template.id);
}

test('цепочка WB обновляет состав кампаний и отправляет точные пары порциями по 100', async t => {
  const countPath = '/adv/v1/promotion/count';
  const detailPath = '/api/advert/v3/adverts';
  const statsPath = '/adv/v1/normquery/stats';
  const ids = Array.from({ length: 50 }, (_, i) => String(100 + i)).concat('9223372036854775807');
  let campaigns = ids;
  let productIds = ['10', '9223372036854775806'];
  const fx = await fixture(t, request => {
    if (request.url.pathname === countPath) {
      const list = entries => entries.map(advertId => `{"advertId":${advertId}}`).join(',');
      return { body: `{"adverts":[{"advert_list":[${list(campaigns.slice(0, 32))}]},{"advert_list":[${list(campaigns.slice(-22))}]}]}` };
    }
    if (request.url.pathname === detailPath) {
      const requested = request.url.searchParams.get('advertIds').split(',');
      const nms = [...productIds, productIds[0]].map(nmId => `{"nmId":${nmId}}`).join(',');
      return { body: `{"adverts":[${requested.map(advertId => `{"advertId":${advertId},"nms":[${nms}]}`).join(',')}]}` };
    }
    return { body: `{"items":${stringify(parseJson(request.body).items)}}` };
  });
  const { service, store, user, requests } = fx;
  const [countId, detailId, statsId] = installAdvertising(fx);
  const values = '{"from":{"daysFromRun":-2},"to":{"daysFromRun":-1}}';
  const day = new Date(2026, 10, 20, 9).valueOf();
  const entry = { templateId: statsId, values };

  const previewId = service.createRun(user, { kind: 'test', entry }, day);
  await fx.run(previewId);
  assert.equal(store.run(previewId).state, 'completed');
  assert.deepEqual(requests.map(request => request.url.pathname), [countPath, detailPath, detailPath, statsPath]);
  assert.equal(parseJson(requests.at(-1).body).items.length, 100);
  assert.equal(store.template(statsId).sample_run_id, previewId);
  assert.equal(store.template(detailId).sample_run_id, null);

  requests.length = 0;
  const jobId = service.saveJob(user, { name: 'Кластеры', format: 'csv', entries: [entry],
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' } });
  const id = service.createRun(user, { kind: 'job', jobId }, day);
  assert.deepEqual(store.run(id).snapshot.order, [2, 1, 0]);
  await fx.run(id);
  const first = store.run(id);
  assert.equal(first.state, 'completed');
  assert.deepEqual(requests.map(request => request.url.pathname), [countPath, detailPath, detailPath, statsPath, statsPath]);
  assert.deepEqual(requests.slice(1, 3).map(request => request.url.searchParams.get('advertIds').split(',')), [ids.slice(0, 50), ids.slice(50)]);
  assert.ok(requests.slice(1, 3).every(request => [...request.url.searchParams.keys()].join() === 'advertIds'));
  assert.ok(requests.every(request => request.headers.authorization === 'fixture-advert-token'));
  assert.deepEqual(requests.slice(3).map(request => parseJson(request.body).items.length), [100, 2]);
  const expected = ids.flatMap(advertId => productIds.map(nmId => `{"advertId":${advertId},"nmId":${nmId}}`));
  assert.deepEqual(requests.slice(3).flatMap(request => parseJson(request.body).items.map(item => stringify(item))), expected);
  const result = JSON.parse(await fs.readFile(path.join(first.progress.exportPath, 'результат.json'), 'utf8'));
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].rows, 102);
  assert.deepEqual(Object.keys(result.sources), ['0']);
  assert.equal(store.dictionary(countId), undefined);
  assert.equal(store.dictionary(detailId), undefined);

  campaigns = ['100', '999'];
  productIds = ['77'];
  requests.length = 0;
  store.scheduleJob(jobId, day, null, null);
  const queued = [];
  await service.startScheduled(new Date(2026, 10, 21, 9).valueOf(), runId => queued.push(runId));
  await fx.run(queued[0]);
  assert.deepEqual(requests.map(request => request.url.pathname), [countPath, detailPath, statsPath]);
  assert.deepEqual(JSON.parse(requests.at(-1).body),
    { from: '2026-11-19', to: '2026-11-20', items: [{ advertId: 100, nmId: 77 }, { advertId: 999, nmId: 77 }] });
  assert.deepEqual(store.run(id).snapshot.sources[0].resolved.items.map(item => stringify(item)), expected);
});

test('медиакампании запрашиваются по одному ID и сохраняются вместе с баннерами', async t => {
  const listPath = '/adv/v1/adverts';
  const detailPath = '/adv/v1/advert';
  const fx = await fixture(t, request => {
    if (request.url.pathname === listPath) {
      return { body: '[{"advertId":23569},{"advertId":24680},{"advertId":25791},{"advertId":23569}]' };
    }
    const advertId = Number(request.url.searchParams.get('id'));
    if (advertId === 24680) return { status: 204 };
    const items = advertId === 23569 ? [{ id: 68080, cpm: 0 }, { id: 68081, cpm: 351 }] : [];
    return { body: JSON.stringify({ advertId, extended: { expenses: 10000 }, items }) };
  });
  const { service, store, user, requests } = fx;
  const template = { connectionId: 'wildberries', endpointId: 'marketplace', method: 'GET' };
  const listId = service.saveDraft(user, stringify({ ...template, name: 'Список медиакампаний',
    path: listPath, response: { rows: '$' } }));
  service.publish(user, listId);
  const details = { ...template, name: 'Медиакампании', path: detailPath, response: {
    rows: '$', singleObject: true, allowNoContent: true,
    columns: [{ path: 'advertId', name: 'ID кампании' }, { path: 'extended.expenses', name: 'Расходы' }],
    tables: [{ name: 'Баннеры', path: 'items', columns: [
      { path: '$parent.advertId', name: 'ID кампании' }, { path: 'id', name: 'ID баннера' }, { path: 'cpm', name: 'CPM' },
    ] }],
  } };
  const detailId = service.saveDraft(user, stringify({ ...details, parameters: [{
    name: 'id', where: 'query', type: 'array', items: { type: 'integer', min: 1 }, required: true, batchSize: 1, encoding: 'csv',
    reference: { templateId: listId, mode: 'all', refresh: 'run', path: 'advertId' },
  }] }));
  service.publish(user, detailId);

  const jobId = service.saveJob(user, { name: 'Медиа', format: 'xlsx', entries: [{ templateId: detailId }] });
  const runId = service.createRun(user, { kind: 'job', jobId });
  await fx.run(runId);
  assert.deepEqual(requests.map(({ url }) => url.pathname + url.search),
    [listPath, `${detailPath}?id=23569`, `${detailPath}?id=24680`, `${detailPath}?id=25791`]);
  assert.ok(requests.every(request => request.method === 'GET' && request.body === ''));
  const run = store.run(runId);
  assert.equal(run.state, 'completed');
  assert.equal(run.progress.sources[0].rows, 2);
  const files = await fs.readdir(run.progress.exportPath);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path.join(run.progress.exportPath, files.find(filename => filename.endsWith('.xlsx'))));
  const campaigns = book.getWorksheet('Медиакампании');
  assert.deepEqual(campaigns.getSheetValues().slice(2), [[, 23569, 10000], [, 25791, 10000]]);
  const banners = book.getWorksheet('Баннеры');
  assert.deepEqual(banners.getSheetValues().slice(2), [[, 23569, 68080, 0], [, 23569, 68081, 351]]);
});

test('статистика WB Медиа передаёт корневой массив с датами и сохраняет ID кампании', async t => {
  const listPath = '/adv/v1/adverts';
  const statsPath = '/adv/v1/stats';
  const fx = await fixture(t, request => {
    if (request.url.pathname === listPath) return { body: '[{"advertId":23569},{"advertId":24680},{"advertId":23569}]' };
    const [{ id, dates }] = JSON.parse(request.body);
    const response = id === 23569 ? [{ dates, stats: [{ item_id: 68080, views: 30, clicks: 0 }] }]
      : [{ advertId: id, error: 'Кампания не найдена' }];
    return { body: JSON.stringify(response) };
  });
  const { service, store, user, requests } = fx;
  const connection = { connectionId: 'wildberries', endpointId: 'marketplace' };
  const listId = service.saveDraft(user, stringify({ ...connection, name: 'Список медиакампаний',
    method: 'GET', path: listPath, response: { rows: '$' } }));
  service.publish(user, listId);
  const dates = { type: 'array', items: { type: 'date', required: true }, required: true, minItems: 1 };
  const campaigns = { name: 'campaigns', where: 'body', key: '$', type: 'array', required: true, minItems: 1, batchSize: 1,
    items: { type: 'object', properties: { id: { type: 'integer', required: true }, dates } } };
  const config = { ...connection, name: 'Статистика медиа', method: 'POST', path: statsPath, parameters: [campaigns], response: {
    rows: '$', requestFields: { campaignId: 'campaigns.0.id' },
    columns: [{ path: 'request.campaignId', name: 'ID кампании' }, { path: 'error', name: 'Ошибка' }],
    tables: [{ name: 'Баннеры', path: 'stats', columns: [
      { path: '$parent.request.campaignId', name: 'ID кампании' }, { path: 'item_id', name: 'ID баннера' },
      { path: 'views', name: 'Просмотры' }, { path: 'clicks', name: 'Клики' },
    ] }],
  } };
  const templateId = service.saveDraft(user, stringify(config));
  const previewId = service.createRun(user, { kind: 'test', entry: { templateId,
    values: '{"campaigns":[{"id":23569,"dates":["2026-11-19",{"daysFromRun":-1}]}]}' } }, new Date(2026, 10, 21, 12).getTime());
  await fx.run(previewId);
  assert.equal(store.run(previewId).state, 'completed');
  assert.deepEqual(JSON.parse(requests[0].body), [{ id: 23569, dates: ['2026-11-19', '2026-11-20'] }]);
  assert.equal(JSON.parse((await service.testSample(user, templateId)).text)[0].request, undefined);

  const linked = { ...campaigns, reference: {
    templateId: listId, mode: 'all', refresh: 'run', fields: { id: 'advertId', dates: '$input.dates' },
  } };
  const form = { ...dates, name: 'dates', where: 'input' };
  assert.throws(() => service.saveDraft(user, stringify({ ...config, parameters: [linked] })), /параметр формы/);
  assert.throws(() => service.saveDraft(user, stringify({ ...config, parameters: [form, { ...linked, batchSize: 100 }] })), /batchSize 1/);
  assert.throws(() => service.saveDraft(user, stringify({ ...config, parameters: [campaigns, { ...form, where: 'body' }] })),
    /единственным параметром тела/);
  service.saveDraft(user, stringify({ ...config, id: templateId, parameters: [form, linked] }));
  service.publish(user, templateId);
  requests.length = 0;

  const jobId = service.saveJob(user, { name: 'Медиа', format: 'xlsx', entries: [{ templateId,
    values: '{"dates":[{"daysFromRun":-2},{"daysFromRun":-1}]}' }] });
  const runId = service.createRun(user, { kind: 'job', jobId }, new Date(2026, 10, 22, 12).getTime());
  await fx.run(runId);
  const run = store.run(runId);
  assert.equal(run.state, 'completed');
  assert.deepEqual(requests.map(request => request.url.pathname), [listPath, statsPath, statsPath]);
  assert.deepEqual(requests.slice(1).map(request => JSON.parse(request.body)),
    [23569, 24680].map(id => [{ id, dates: ['2026-11-20', '2026-11-21'] }]));
  assert.ok(requests.slice(1).every(request => request.method === 'POST' && request.headers['content-type'] === 'application/json'));
  const files = await fs.readdir(run.progress.exportPath);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path.join(run.progress.exportPath, files.find(filename => filename.endsWith('.xlsx'))));
  assert.equal(book.getWorksheet('Статистика медиа').getCell('B3').value, 'Кампания не найдена');
  assert.deepEqual(book.getWorksheet('Баннеры').getRow(2).values.slice(1), [23569, 68080, 30, 0]);
});

test('fullstats отбирает статусы до разворота кампаний и делит ID и даты', async t => {
  const listPath = '/adv/v1/promotion/count';
  const statsPath = '/adv/v3/fullstats';
  const ids = Array.from({ length: 51 }, (_, index) => index + 1);
  let includeEligible = true;
  const fx = await fixture(t, request => {
    if (request.url.pathname === listPath) {
      const groups = [{ status: 4 }, { status: 8, advert_list: [{ advertId: 100 }] }];
      if (includeEligible) groups.push(
        { status: 7, advert_list: ids.slice(0, 25).map(advertId => ({ advertId })) },
        { status: 9, advert_list: ids.slice(25, 50).map(advertId => ({ advertId })) },
        { status: 11, advert_list: [{ advertId: 51 }, { advertId: 1 }] },
      );
      return { body: JSON.stringify({ adverts: groups }) };
    }
    const date = request.url.searchParams.get('beginDate');
    return { body: JSON.stringify(request.url.searchParams.get('ids').split(',').map(id => ({
      advertId: Number(id), views: 25, days: [{ date, views: 25 }],
    }))) };
  });
  const { service, store, user, requests } = fx;
  const [listId] = installAdvertising(fx);
  const { connectionId, endpointId } = store.template(listId).published;
  const templateId = service.saveDraft(user, stringify({ connectionId, endpointId, name: 'Статистика кампаний WB',
    method: 'GET', path: statsPath, parameters: [
      { name: 'ids', where: 'query', type: 'array', items: { type: 'integer', min: 1 }, required: true, batchSize: 50, encoding: 'csv',
        reference: { templateId: listId, mode: 'all', refresh: 'run', expand: 'advert_list', path: 'advertId',
          filter: { path: 'status', values: [7, 9, 11] } } },
      { name: 'beginDate', where: 'query', type: 'date', required: true },
      { name: 'endDate', where: 'query', type: 'date', required: true },
    ], period: { from: 'beginDate', to: 'endDate', daysPerRequest: 31 }, response: {
      rows: '$', requestFields: { beginDate: 'beginDate', endDate: 'endDate' },
      columns: [{ path: 'advertId', name: 'ID кампании' }, { path: 'request.beginDate', name: 'Начало' },
        { path: 'request.endDate', name: 'Конец' }],
      tables: [{ name: 'По дням', path: 'days', columns: [
        { path: '$parent.advertId', name: 'ID кампании' }, { path: 'date', name: 'Дата' },
      ] }],
    } }));
  service.publish(user, templateId);
  const jobId = service.saveJob(user, { name: 'Статистика', format: 'xlsx', entries: [{ templateId,
    values: '{"beginDate":{"daysFromRun":-32},"endDate":"2026-11-02"}' }] });
  const date = new Date(2026, 10, 2, 12).getTime();
  const runId = service.createRun(user, { kind: 'job', jobId }, date);
  await fx.run(runId);
  assert.deepEqual(requests.map(({ url }) => url.pathname), [listPath, statsPath, statsPath, statsPath, statsPath]);
  assert.ok(requests.every(request => request.method === 'GET' && request.body === ''));
  assert.deepEqual(requests.slice(1).map(({ url }) => Object.fromEntries(url.searchParams)),
    [ids.slice(0, 50), [51]].flatMap(batch => [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-02']]
      .map(([beginDate, endDate]) => ({ ids: batch.join(','), beginDate, endDate }))));
  const run = store.run(runId);
  assert.equal(run.state, 'completed');
  assert.equal(run.progress.sources[0].rows, 102);
  const files = await fs.readdir(run.progress.exportPath);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path.join(run.progress.exportPath, files.find(filename => filename.endsWith('.xlsx'))));
  const main = book.getWorksheet('Статистика кампаний WB');
  assert.deepEqual(main.getRow(2).values.slice(1), [1, '2026-10-01', '2026-10-31']);
  assert.deepEqual(main.getRow(52).values.slice(1), [1, '2026-11-01', '2026-11-02']);
  assert.equal(book.getWorksheet('По дням').rowCount, 103);

  requests.length = 0;
  includeEligible = false;
  const emptyId = service.createRun(user, { kind: 'job', jobId }, date);
  await fx.run(emptyId);
  assert.deepEqual(requests.map(({ url }) => url.pathname), [listPath]);
  assert.match(store.run(emptyId).progress.sources[0].warning, /HTTP-запрос пропущен/);
});

test('пустая цепочка пропускает HTTP-запросы, а частичная загрузка кампаний блокирует статистику', async t => {
  let mode = 'empty';
  const countPath = '/adv/v1/promotion/count';
  const detailPath = '/api/advert/v3/adverts';
  const fx = await fixture(t, request => {
    if (request.url.pathname === countPath) {
      const adverts = mode === 'empty' ? [] : [{ advert_list: Array.from({ length: 51 }, (_, i) => ({ advertId: i + 1 })) }];
      return { body: JSON.stringify({ adverts }) };
    }
    if (request.url.searchParams.get('advertIds') === '51') return { status: 403, body: '{}' };
    return { body: '{"adverts":[{"advertId":1,"nms":[{"nmId":10}]}]}' };
  });
  const { service, store, user, requests } = fx;
  const [, , statsId] = installAdvertising(fx);
  const jobId = service.saveJob(user, { name: 'Кластеры', format: 'csv', entries: [{
    templateId: statsId, values: '{"from":"2026-11-18","to":"2026-11-19"}',
  }] });
  const runId = service.createRun(user, { kind: 'job', jobId });
  await fx.run(runId);
  const empty = store.run(runId);
  assert.equal(empty.state, 'completed');
  assert.match(empty.progress.sources[0].warning, /HTTP-запрос пропущен/);
  assert.deepEqual(requests.map(request => request.url.pathname), [countPath]);
  assert.ok(empty.progress.exportPath);
  assert.deepEqual(empty.progress.sources[0].requests, { done: 0, failed: 0, remaining: 0, exact: true });

  mode = 'partial';
  requests.length = 0;
  const blocked = service.createRun(user, { kind: 'job', jobId });
  await fx.run(blocked);
  const failed = store.run(blocked);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.progress.sources[1].state, 'partial');
  assert.match(failed.progress.sources[0].error, /из зависимого запроса/);
  assert.deepEqual(requests.map(request => request.url.pathname), [countPath, detailPath, detailPath]);
  assert.equal(failed.progress.exportPath, undefined);
});

test('обработка кластеров разворачивает dailyStats и пропускает пустые записи', async t => {
  const fx = await fixture(t, request => {
    if (request.url.pathname === '/adv/v1/promotion/count') return { body: '{"adverts":[{"advert_list":[{"advertId":10}]}]}' };
    if (request.url.pathname === '/api/advert/v3/adverts') return { body: '{"adverts":[{"advertId":10,"nms":[{"nmId":20}]}]}' };
    return { body: '{"items":[' +
      '{"advertId":10,"nmId":20},' +
      '{"advertId":10,"nmId":21,"dailyStats":[]},' +
      '{"advertId":10,"nmId":22,"dailyStats":null},' +
      '{"advertId":10,"nmId":9223372036854775807,"dailyStats":[' +
      '{"date":"2026-11-16","stat":{"clicks":0,"normQuery":"корм","spend":1.25}},' +
      '{"date":"2026-11-16","stat":{"clicks":1,"normQuery":"сухой корм","spend":0}}]},' +
      '{"advertId":10,"nmId":20,"dailyStats":[{"date":"2026-11-17","stat":{"orders":2}}]}' +
      ']}' };
  });
  const { service, store, user, requests } = fx;
  const [, , templateId] = installAdvertising(fx);
  const processingId = service.saveProcessing(user, { templateId, name: 'Кластеры по дням' });
  const entry = { templateId, values: '{"from":"2026-11-16","to":"2026-11-18"}' };
  const jobId = service.saveJob(user, { name: 'Исходная выгрузка', format: 'csv', entries: [entry] });
  const runId = service.createRun(user, { kind: 'job', jobId });
  await fx.run(runId);
  const stored = store.run(runId);
  const result = await exportRun(store, stored, 'xlsx', service.processingFromRun(user, stored, { source: 0, processingId }));
  assert.equal(requests.length, 3);
  const meta = JSON.parse(await fs.readFile(path.join(result, 'результат.json'), 'utf8'));
  assert.deepEqual(meta.tables, [{ name: 'Кластеры по дням', rows: 3 }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(result, 'Кластеры по дням.xlsx'));
  const [sheet] = workbook.worksheets;
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(1).values.slice(1), CLUSTERS_COLUMNS.map(column => column.name));
  assert.deepEqual(sheet.getRow(2).values.slice(1, 4), [10, '9223372036854775807', '2026-11-16']);
  assert.deepEqual(sheet.getRow(3).values.slice(1, 4), [10, '9223372036854775807', '2026-11-16']);
  assert.deepEqual(sheet.getRow(4).values.slice(1, 4), [10, 20, '2026-11-17']);
  assert.equal(sheet.getCell('F2').value, 0);
  assert.equal(sheet.getCell('K3').value, 'сухой корм');
  assert.equal(sheet.getCell('N3').value, 0);
  assert.ok(await fs.stat(stored.progress.exportPath));

  const automaticJob = service.saveJob(user, { name: 'Обработанная выгрузка', format: 'csv',
    entries: [{ ...entry, processingId }] });
  const automaticId = service.createRun(user, { kind: 'job', jobId: automaticJob });
  await fx.run(automaticId);
  const automatic = store.run(automaticId);
  assert.equal(automatic.state, 'completed');
  const preview = await service.result(user, { runId: automaticId, source: 0, offset: 0 });
  assert.equal(preview.rows.length, 3);
  assert.equal(preview.rows[0].stat.normQuery, 'корм');
  assert.equal(preview.rows[1].stat.normQuery, 'сухой корм');
});

test('удаление выгрузки сохраняет шаблон, обработку и запуски при обновлении базы', async t => {
  const fx = await fixture(t, () => ({ body: '{"data":{"products":[{"product":{"nmId":11},"statistic":' +
    '{"selected":{"period":{"start":"2026-11-18","end":"2026-11-19"}}}}]}}' }));
  const { service, store, user } = fx;
  const owner = store.createUser('export-owner', 'FixturePassword!234', 'user');
  const another = store.createUser('export-other', 'FixturePassword!234', 'user');
  const templateId = service.saveDraft(user, stringify({
    id: 'funnel-to-export', name: 'Воронка для выгрузки', folder: 'До перемещения', available: true,
    connectionId: 'wildberries', endpointId: 'marketplace', method: 'POST', path: FUNNEL_PATH,
    response: { rows: 'data.products' },
  }));
  service.publish(user, templateId);
  service.saveDraft(user, stringify({ ...store.template(templateId).draft, folder: 'Рабочие/Отчёты' }));
  assert.equal(service.workspace(owner).options.find(item => item.id === templateId).folder, 'Рабочие/Отчёты');

  const processingId = service.saveProcessing(user, { templateId, name: 'По периодам' });
  const options = { name: 'Карточки', format: 'csv', entries: [{ templateId, processingId }],
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' } };
  const jobId = service.saveJob(owner, options);
  const keptId = service.saveJob(owner, { ...options, name: 'Другая выгрузка', schedule: null });
  const runId = service.createRun(owner, { kind: 'job', jobId });

  store.db.exec('ALTER TABLE jobs DROP COLUMN deleted_at');
  const reopened = new Store(store.root);
  try {
    assert.equal(reopened.job(jobId).deleted_at, null);
    assert.equal(reopened.run(runId).job_id, jobId);
  } finally {
    reopened.close();
  }

  assert.throws(() => service.deleteJob(another, jobId), /недоступна/);
  const now = Date.now();
  store.scheduleJob(jobId, now - 86_400_000, now + 1000, now);
  service.deleteJob(owner, jobId);
  service.deleteJob(owner, jobId);
  assert.deepEqual(service.workspace(owner).jobs.map(job => job.id), [keptId]);
  assert.equal(store.job(jobId).pending_at, null);
  assert.equal(store.job(jobId).pending_slot, null);
  assert.throws(() => service.createRun(owner, { kind: 'job', jobId }), /недоступна/);
  assert.throws(() => service.saveJob(owner, { ...options, id: jobId }), /недоступна/);
  assert.equal(store.template(templateId).version, 1);
  assert.equal(store.processing(processingId).templateId, templateId);

  await fx.run(runId);
  const calls = [];
  await service.startScheduled(now + 86_400_000, id => calls.push(id));
  assert.deepEqual(calls, []);
  assert.equal(service.workspace(owner).runs.length, 1);
  const run = service.getRun(owner, runId);
  assert.equal(run.state, 'completed');
  assert.ok(await fs.stat(run.progress.exportPath));
});

test('редактируемые шаги показывают счётчики, образцы и ошибки на сохранённых данных', async t => {
  const fx = await fixture(t, () => ({ body: '{"orders":[' +
    '{"id":9223372036854775807,"details":[{"date":"2026-11-18","count":0},{"date":"некорректная дата","count":5}]} ,' +
    '{"id":5,"details":[]},{"id":8,"details":"ошибка"}],"next":0}' }));
  const { service, store, user } = fx;
  const runId = service.createRun(user, { kind: 'test', entry: { templateId: 'wb-orders' } });
  await fx.run(runId);
  const run = store.run(runId);
  const config = { name: 'Тест шагов', templateId: 'wb-orders', runId, source: 0, steps: [
    { type: 'filter', path: 'details', operator: 'arrayNotEmpty', onError: 'skip' },
    { type: 'expandArray', path: 'details', as: 'item' },
    { type: 'validate', checks: [{ path: 'item.date', kind: 'date' }], onError: 'skip' },
    { type: 'copy', fields: [{ from: 'id', to: 'id' }, { from: 'item.count', to: 'count' }] },
  ], columns: [{ path: 'id', name: 'Номер' }, { path: 'count', name: 'Количество' }] };
  assert.equal(service.processingRuns(user, 'wb-orders')[0].rows, 3);
  const { processing, sourceIndex } = service.processingPreview(user, config);
  const result = await previewProcessing(store, run, sourceIndex, processing);
  assert.equal(result.error, undefined);
  assert.equal(result.input.rows, 3);
  assert.deepEqual(result.stages.map(({ input, rows, errors }) => [input, rows, errors]), [
    [3, 1, 1], [1, 2, 0], [2, 1, 1], [1, 1, 0],
  ]);
  assert.deepEqual(JSON.parse(result.output.samples[0]), { 'Номер': '9223372036854775807', 'Количество': 0 });
  const saved = service.saveProcessing(user, config);
  const output = await exportRun(store, run, 'csv', service.processingFromRun(user, run, { processingId: saved, source: 0 }));
  const report = JSON.parse(await fs.readFile(path.join(output, 'результат.json'), 'utf8'));
  assert.equal(report.tables[0].rows, 1);

  const strict = service.processingPreview(user, { ...config, steps: config.steps.map(step => ({ ...step, onError: 'stop' })) });
  const stopped = await previewProcessing(store, run, sourceIndex, strict.processing);
  assert.match(stopped.error, /Шаг 3/);
  assert.throws(() => service.saveProcessing(user, { ...config, steps: [{ type: 'validate', checks: [] }] }), /Шаг 1/);
  assert.equal(fx.requests.length, 1);
});

test('архив шаблонов сохраняет связанные выгрузки, а удаление проверяет зависимости', async t => {
  const fx = await fixture(t, request => {
    if (request.url.pathname === '/adv/v1/promotion/count') return { body: '{"adverts":[{"advert_list":[{"advertId":1}]}]}' };
    if (request.url.pathname === '/api/advert/v3/adverts') return { body: '{"adverts":[{"advertId":1,"nms":[{"nmId":10}]}]}' };
    return { body: '{"items":[]}' };
  });
  const { service, store, user } = fx;
  const [first, middle, last] = installAdvertising(fx);
  const owner = store.createUser('template-viewer', 'FixturePassword!234', 'user');
  const processingId = service.saveProcessing(user, { templateId: last, name: 'Кластеры' });
  const job = { name: 'Статистика по расписанию', format: 'csv', entries: [
    { templateId: last, processingId, values: '{"from":"2026-11-18","to":"2026-11-19"}' },
  ] };
  const jobId = service.saveJob(owner, job);
  const usage = service.templateUsage(user, first);
  assert.equal(usage.jobs[0].name, job.name);
  assert.equal(usage.jobs[0].indirect, true);
  assert.equal(usage.processings[0].name, 'Кластеры');
  assert.equal(usage.templates.length, 2);
  assert.throws(() => service.templateUsage(owner, first), /настройщику/);
  assert.throws(() => service.deleteTemplate(user, first), /Шаблон используется/);
  assert.throws(() => service.deleteProcessing(user, processingId), /выгрузок/);

  const draftSource = service.saveDraft(user, JSON.stringify({ ...store.template(first).draft, id: undefined, name: 'Новый список' }));
  const middleDraft = store.template(middle).draft;
  service.saveDraft(user, JSON.stringify({ ...middleDraft, parameters: middleDraft.parameters.map(parameter =>
    parameter.reference ? { ...parameter, reference: { ...parameter.reference, templateId: draftSource } } : parameter) }));
  const draftUsage = service.templateUsage(user, draftSource);
  assert.deepEqual(draftUsage.jobs, []);
  assert.deepEqual(draftUsage.processings, []);
  assert.equal(draftUsage.templates.length, 2);
  assert.ok(draftUsage.templates.every(template => template.draftOnly));
  assert.throws(() => service.deleteTemplate(user, draftSource), /Шаблон используется/);

  store.db.exec('ALTER TABLE templates DROP COLUMN archived_at');
  const reopened = new Store(store.root);
  reopened.close();
  service.archiveTemplate(user, first, true);
  service.archiveTemplate(user, last, true);
  assert.equal(service.workspace(owner).options.find(option => option.id === first).archived, true);
  assert.throws(() => service.saveJob(owner, job), /Восстановите шаблон/);
  assert.throws(() => service.publish(user, first), /Восстановите шаблон/);
  assert.equal(service.saveJob(owner, { ...job, id: jobId }), jobId);
  const runId = service.createRun(owner, { kind: 'job', jobId });
  await fx.run(runId);
  assert.equal(store.run(runId).state, 'completed');
  assert.equal(fx.requests.length, 3);

  service.deleteJob(owner, jobId);
  service.deleteProcessing(user, processingId);
  service.deleteTemplate(user, last);
  service.deleteTemplate(user, middle);
  service.deleteTemplate(user, draftSource);
  service.archiveTemplate(user, first, false);
  service.deleteTemplate(user, first);
  assert.equal(store.template(last), null);
  assert.ok(store.run(runId).progress.exportPath);
  assert.ok(await fs.stat(store.run(runId).progress.exportPath));
});
