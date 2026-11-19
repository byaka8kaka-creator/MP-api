const { setTimeout: sleep } = require('node:timers/promises');
const { InputError, parseJson, stringify } = require('./json.cjs');
const { batches, demand, historyWarning, initialPosition, inputValues, nextPosition, requestFor, responseRows } = require('./model.cjs');
const { exportRun, logEvent, referenceValues, saveSample, writePage } = require('./datasets.cjs');

class HttpProblem extends InputError {
  constructor(status, delay, detail) {
    const meanings = {
      400: 'Некорректные параметры', 401: 'Проверьте авторизацию', 402: 'Проверьте подписку',
      403: 'У ключа нет доступа к методу', 413: 'Тело запроса слишком большое', 420: 'Ограничение Маркета',
      422: 'API отклонил параметры', 429: 'Превышен лимит запросов',
    };
    super(`HTTP ${status}. ${meanings[status] ?? 'API не выполнил запрос'}.${detail ? ` ${detail}` : ''}`);
    this.status = status;
    this.delay = delay;
  }
}

function problem(error) {
  return error instanceof InputError ? error.message : 'Не удалось получить или сохранить ответ. Проверьте соединение и папку приложения.';
}

async function responseText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString('utf8');
      size += value.byteLength;
      if (size > maxBytes) throw new InputError('Страница ответа превышает настроенный размер. Уменьшите размер страницы.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function safeDetail(raw, credentials) {
  let result;
  try {
    const payload = parseJson(raw);
    const detail = payload?.detail ?? payload?.details;
    if (typeof detail === 'string') result = detail;
  } catch {
    return '';
  }
  if (!result) return '';
  return redactCredentials(result, credentials).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function redactCredentials(text, credentials) {
  for (const value of Object.values(credentials)) {
    if (typeof value !== 'string' || !value) continue;
    text = text.replaceAll(value, '[скрыто]').replaceAll(encodeURIComponent(value), '[скрыто]');
  }
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [скрыто]');
}

function networkCode(error, depth = 0) {
  if (!error || depth >= 5) return undefined;
  if (error.name === 'TimeoutError') return 'TIMEOUT';
  const nested = networkCode(error.cause, depth + 1);
  if (nested) return nested;
  if (Array.isArray(error.errors)) {
    for (const cause of error.errors.slice(0, 8)) {
      const code = networkCode(cause, depth + 1);
      if (code) return code;
    }
  }
  if (error.message === 'Redirect was cancelled') return 'REDIRECT_BLOCKED';
  const chromium = /^net::(ERR_[A-Z_0-9]+)$/.exec(error.message)?.[1];
  return chromium ?? (/^[A-Z][A-Z_0-9]{2,64}$/.test(error.code) ? error.code : undefined);
}

function networkFailure(error, timeout, status) {
  const code = timeout?.aborted ? 'TIMEOUT' : networkCode(error) ?? 'NETWORK_ERROR';
  let reason = status ? 'Соединение прервалось при чтении ответа API' : 'Не получен HTTP-ответ от API';
  if (/NAME_NOT_RESOLVED|DNS|ENOTFOUND|EAI_AGAIN/.test(code)) reason = 'Не удалось определить IP-адрес API (DNS)';
  if (/PROXY|TUNNEL/.test(code)) reason = 'Не удалось пройти через прокси';
  if (/CERT|SSL|TLS|SELF_SIGNED|ISSUER|VERIFY_LEAF/.test(code)) reason = 'Ошибка TLS или проверки сертификата API';
  if (/TIMEOUT|TIMEDOUT|TIMED_OUT/.test(code)) reason = 'Истёк тайм-аут HTTP-запроса';
  if (/REFUSED/.test(code) && !/PROXY/.test(code)) reason = 'Сервер отклонил соединение';
  if (code === 'REDIRECT_BLOCKED') reason = 'API вернул перенаправление';
  return { code, reason };
}

async function receive(source, values, position, credentials, context) {
  const { fetcher, limiter, signal, onWait, onRequest, onResponse, onNetworkError, onRetry } = context;
  const request = requestFor(source, values, position, credentials);
  const bodyBytes = Buffer.byteLength(request.body ?? '');
  demand(bodyBytes <= source.template.maxBodyBytes, 'JSON-тело превышает лимит байт.');
  const mask = value => redactCredentials(value, credentials);
  const description = {
    method: request.method,
    url: mask(request.url.origin + request.logPath),
    queryFields: [...new Set(request.url.searchParams.keys())].map(mask),
    bodyFields: request.bodyFields.map(mask),
    bodyBytes,
  };
  const attempts = source.template.safeToRetry ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    const release = await limiter.acquire(source, values, credentials, signal, onWait);
    let status;
    let headers;
    let raw;
    let transportError;
    let retryDelay;
    let timeout;
    const started = performance.now();
    try {
      await onRequest(attempt, description);
      try {
        timeout = AbortSignal.timeout(source.template.timeoutMs);
        const response = await fetcher(request.url, {
          method: request.method, headers: request.headers, body: request.body, redirect: 'manual',
          credentials: 'omit', cache: 'no-store',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        status = response.status;
        headers = response.headers;
        if (!response.ok) {
          try { raw = await responseText(response, 16 * 1024); } catch { raw = ''; }
        } else {
          raw = await responseText(response, source.template.maxResponseBytes);
        }
      } catch (error) {
        transportError = error;
      }
    } finally {
      retryDelay = release(status, headers);
    }
    const elapsedMs = Math.round(performance.now() - started);
    if (status) await onResponse(status, attempt, elapsedMs);
    signal?.throwIfAborted();
    if (!transportError && status >= 200 && status < 300) {
      let payload = null;
      if (status !== 204 || raw) {
        try { payload = parseJson(raw); } catch { throw new InputError('Сервер вернул некорректный JSON.'); }
      }
      return { status, raw, payload, url: request.url };
    }
    const network = transportError && !(transportError instanceof InputError) ? networkFailure(transportError, timeout, status) : null;
    if (network) await onNetworkError(attempt, elapsedMs, network.code);
    const error = network ? new InputError(`${network.reason} (${network.code}).`)
      : (transportError ?? new HttpProblem(status, retryDelay, safeDetail(raw, credentials)));
    const transient = Boolean(network && network.code !== 'REDIRECT_BLOCKED') ||
      status >= 500 || [420, 429].includes(status);
    if (!transient || attempt >= attempts) throw error;
    const delay = Math.max(retryDelay ?? 0, 500 * 2 ** (attempt - 1));
    await onRetry(delay, attempt);
    onWait(delay);
    await context.wait(delay, signal);
  }
}

async function resolveInputs(store, source) {
  const values = { ...source.values };
  for (const parameter of source.template.parameters) {
    const reference = parameter.reference;
    const runId = source.references[parameter.name];
    if (!reference || !runId) continue;
    const dictionary = store.run(runId);
    demand(dictionary?.state === 'completed', 'Сохранённая версия справочника недоступна.');
    if (reference.mode === 'all') {
      const items = new Map();
      for await (const value of referenceValues(store, dictionary, reference.path)) {
        items.set(stringify(value), value);
        demand(items.size <= 1_000_000, 'Справочник слишком велик для одного параметра.');
      }
      values[parameter.name] = [...items.values()];
      continue;
    }
    const selection = reference.mode === 'many' ? values[parameter.name] : [values[parameter.name]];
    const expected = new Set(selection.map(value => stringify(value)));
    for await (const item of referenceValues(store, dictionary, reference.path)) {
      expected.delete(stringify(item));
      if (expected.size === 0) break;
    }
    demand(expected.size === 0, `«${parameter.label}»: выбранных значений нет в сохранённом справочнике.`);
  }
  return inputValues(source.template, values);
}

async function executeSource(store, run, index, secrets, context, update) {
  const source = run.snapshot.sources[index];
  const progress = run.progress.sources[index];
  const previous = store.pages(run.id, index);
  const credentials = secrets[index] ?? {};
  const trace = (type, fields) => logEvent(store, run.id, type, { source: index + 1, ...fields });
  progress.rows = previous.reduce((total, page) => total + page.rows, 0);
  progress.state = 'running';
  update('running');
  if (source.secretExpires && source.secretExpires <= Date.now()) throw new InputError('Истёк срок действия ключа подключения.');
  if (!source.resolved) {
    source.resolved = await resolveInputs(store, source);
    store.readyRun(run.id, run.snapshot);
  }
  const warning = historyWarning(source.template, source.resolved, new Date(run.created));
  if (warning) progress.warning = warning;
  const pagination = source.template.pagination;
  const completed = new Map();
  for (const page of previous) {
    if (!completed.has(page.batch)) completed.set(page.batch, []);
    completed.get(page.batch).push(page);
  }
  let batchIndex = -1;
  const errors = [];
  for (const values of batches(source, source.resolved)) {
    batchIndex++;
    context.signal?.throwIfAborted();
    const saved = completed.get(batchIndex) ?? [];
    const last = saved.at(-1);
    progress.batches = batchIndex + 1;
    if (last?.status === 'done') continue;
    if (last?.status === 'partial') {
      errors.push(last.problem);
      continue;
    }
    let position = last?.next ?? initialPosition(pagination);
    const seen = new Set([stringify(initialPosition(pagination)), ...saved.filter(page => page.next !== null).map(page => stringify(page.next))]);
    let batchRows = saved.reduce((total, page) => total + page.rows, 0);
    try {
      for (let page = saved.length; ; page++) {
        context.signal?.throwIfAborted();
        const http = await receive(source, values, position, credentials, {
          ...context,
          onWait: delay => {
            if (delay < 1000) return;
            run.progress.waiting = { source: index, until: Date.now() + delay };
            update('waiting');
          },
          onRequest: (attempt, request) => {
            delete run.progress.waiting;
            update('running');
            return trace('request', { batch: batchIndex + 1, page: page + 1, attempt, ...request });
          },
          onResponse: (status, attempt, elapsedMs) =>
            trace('http', { batch: batchIndex + 1, page: page + 1, status, attempt, elapsedMs }),
          onNetworkError: (attempt, elapsedMs, code) =>
            trace('network_error', { batch: batchIndex + 1, page: page + 1, attempt, elapsedMs, code }),
          onRetry: (delay, attempt) => trace('retry', { batch: batchIndex + 1, page: page + 1, delay, attempt }),
        });
        if (page === 0 && batchIndex === 0 && http.raw) {
          await saveSample(store, run.id, index, http.raw);
          if (run.kind === 'test') store.linkSample(source.template.id, run.id);
        }
        const rows = responseRows(source.template.response, http.payload, http.status);
        batchRows += rows.length;
        let next = null;
        let incomplete = null;
        if (run.kind !== 'test') {
          try {
            next = nextPosition(pagination, http.payload, rows, position, values, batchRows, http.url);
            demand(!next || !seen.has(stringify(next)), 'Курсор уже использовался. Полученные строки сохранены.');
            demand(!next || page + 1 < pagination.maxPages, 'Достигнуто защитное ограничение числа страниц.');
          } catch (error) {
            incomplete = problem(error);
            next = null;
          }
        }
        await writePage(store, run.id, index, batchIndex, page, rows);
        store.commitPage(run.id, index, batchIndex, page, next, rows.length,
          incomplete ? 'partial' : next ? 'more' : 'done', incomplete);
        progress.rows += rows.length;
        progress.page = page + 1;
        update('running');
        await trace('page_saved', { batch: batchIndex + 1, page: page + 1, rows: rows.length, problem: incomplete });
        if (incomplete) errors.push(incomplete);
        if (!next) break;
        seen.add(stringify(next));
        position = next;
      }
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof HttpProblem && [401, 402, 403].includes(error.status)) throw error;
      errors.push(problem(error));
      await trace('batch_failed', { batch: batchIndex + 1, problem: problem(error) });
    }
    if (run.kind === 'test') break;
  }
  if (errors.length) {
    progress.error = errors[0];
    progress.failedBatches = errors.length;
    progress.state = progress.rows > 0 || previous.some(page => page.status === 'done') ? 'partial' : 'failed';
  } else {
    delete progress.error;
    delete progress.failedBatches;
    progress.state = 'completed';
  }
}

async function executeRun(store, runId, secrets, {
  limiter, signal, fetcher = fetch, wait = (ms, sign) => sleep(ms, undefined, { signal: sign }),
} = {}) {
  const run = store.run(runId);
  if (!run) return;
  const update = state => store.updateRun(runId, state, run.progress);
  run.progress.sources ??= {};
  const context = { limiter, signal, fetcher, wait };
  await logEvent(store, runId, 'started', { kind: run.kind }, true);
  update('running');
  let state;
  try {
    for (const [index, source] of run.snapshot.sources.entries()) {
      signal?.throwIfAborted();
      const progress = run.progress.sources[index] ??= { rows: 0, name: source.template.name };
      if (progress.state === 'completed') continue;
      if (source.skipOnRecovery) {
        progress.state = progress.rows > 0 ? 'partial' : 'failed';
        progress.error = 'Этот шаблон требует решения пользователя после прерывания.';
        continue;
      }
      try {
        await executeSource(store, run, index, secrets, context, update);
      } catch (error) {
        signal?.throwIfAborted();
        progress.state = progress.rows ? 'partial' : 'failed';
        progress.error = problem(error);
        await logEvent(store, runId, 'source_failed', { source: index + 1, problem: progress.error }, true);
      }
      update('running');
    }
    const sources = Object.values(run.progress.sources);
    state = sources.every(source => source.state === 'completed') ? 'completed'
      : sources.some(source => source.rows > 0 || source.state === 'completed') ? 'partial' : 'failed';
    if (state === 'completed' && run.kind === 'dictionary') {
      store.putDictionary(run.snapshot.sources[0].template.id, run.id);
    }
    if (run.kind === 'job' && state !== 'failed') {
      run.progress.exporting = true;
      update('running');
      try {
        run.progress.exportPath = await exportRun(store, { ...run, state }, run.snapshot.format);
      } catch (error) {
        run.progress.exportError = problem(error);
      } finally {
        delete run.progress.exporting;
      }
    }
  } catch (error) {
    state = signal?.aborted ? 'cancelled' : 'interrupted';
    if (!signal?.aborted) run.progress.error = problem(error);
  }
  delete run.progress.waiting;
  update(state);
  await logEvent(store, runId, 'finished', { state }, true);
}

module.exports = { executeRun, problem, receive };
