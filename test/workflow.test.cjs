const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
const { exportRun, logTail, runLog, sample, writePage } = require('../src/core/datasets.cjs');
const { parseJson, stringify } = require('../src/core/json.cjs');
const { LimitScheduler } = require('../src/core/limits.cjs');
const { batches, inputValues, requestFor, validateConnection, validateTemplate } = require('../src/core/model.cjs');
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
  return { store, service, user, requests, run: runId => executeRun(store, runId, service.credentials(runId), { limiter, wait }) };
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
  const fx = await fixture(t, () => ({ body: '{"orders":[],"next":0}' }));
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
  await fx.run(id);
  assert.equal(fx.requests.length, 1);
  assert.equal(fx.requests[0].url.searchParams.get('next'), '9223372036854775807');
  assert.equal(fx.requests[0].url.pathname, '/api/v3/orders');
  assert.equal(fx.store.run(id).state, 'completed');
  assert.equal(fx.store.pages(id, 0).length, 2);
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
