const { randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { finished } = require('node:stream/promises');
const ExcelJS = require('exceljs');
const { InputError, get, inferShape, isLosslessNumber, object, parseJson, publicValue, scalarText, stringify } = require('./json.cjs');
const { batches, demand } = require('./model.cjs');
const { processingRows, processingSteps, recordSample } = require('./processings.cjs');
const { campaignColumns, campaignLookups, campaignRows, campaignSummaryRows, summaryHeaders } = require('./campaign-report.cjs');
const { workbookBindings, workbookExecutor } = require('./workbook-processing.cjs');

const XLSX_ROWS = 1_048_575;
const DAY = 86_400_000;

function resultDir(store, runId, source) {
  return path.join(store.root, 'data', 'runs', runId, `source-${source + 1}`);
}

function pageFile(store, runId, source, batch, page) {
  return path.join(resultDir(store, runId, source), `batch-${batch + 1}`, `page-${page + 1}.ndjson`);
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600, flush: true });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writePage(store, runId, source, batch, page, rows) {
  const body = rows.length ? `${rows.map(row => stringify(row)).join('\n')}\n` : '';
  await writeAtomic(pageFile(store, runId, source, batch, page), body);
}

async function saveSample(store, runId, source, raw) {
  await writeAtomic(path.join(resultDir(store, runId, source), 'sample.json'), raw);
}

async function sample(store, runId, source) {
  let raw;
  try {
    raw = await fs.readFile(path.join(resultDir(store, runId, source), 'sample.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return {
    shape: inferShape(parseJson(raw)),
    text: raw.length <= 25_000 ? raw : raw.slice(0, 25_000),
    truncated: raw.length > 25_000,
  };
}

async function* records(store, run, sourceIndex, signal, options) {
  const source = run.snapshot.sources[sourceIndex];
  demand(source, 'Набор данных отсутствует.');
  const keyPath = options?.allRows ? undefined : source.template.response.deduplicateBy;
  const seen = keyPath === undefined ? null : new Set();
  const requestBatches = options?.requestFields?.length ? batches(source, source.resolved ?? source.values) : null;
  let batch = -1;
  let request;
  for (const page of store.pages(run.id, sourceIndex)) {
    if (requestBatches && batch < page.batch) {
      let values;
      while (batch < page.batch) {
        const next = requestBatches.next();
        demand(!next.done, `Для «${options.alias}» отсутствуют параметры сохранённого запроса.`);
        values = next.value;
        batch++;
      }
      request = Object.fromEntries(options.requestFields.map(field => {
        const value = get(values, field.path);
        demand(value !== undefined, `Для «${options.alias}» заполните параметр запроса «${field.path}».`);
        return [field.name, value];
      }));
    }
    const stream = createReadStream(pageFile(store, run.id, sourceIndex, page.batch, page.page), { encoding: 'utf8', signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const row = parseJson(line);
        if (seen) {
          const key = get(row, keyPath);
          if (key !== undefined && key !== null) {
            const encoded = stringify(key);
            if (seen.has(encoded)) continue;
            seen.add(encoded);
          }
        }
        if (request) {
          demand(object(row) && (row.request === undefined || object(row.request)), 'Поля запроса можно добавить к объекту записи.');
          yield { ...row, request: { ...row.request, ...request } };
        } else yield row;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}

async function* outputRecords(store, run, index, processing = run.snapshot.sources[index]?.processing) {
  const steps = processing ? processingSteps(processing) : null;
  for await (const record of records(store, run, index)) {
    if (steps) yield* processingRows(steps, record);
    else yield record;
  }
}

async function previewProcessing(store, run, index, processing) {
  if (processing.scope === 'workbook') return previewWorkbook(store, run, processing);
  const steps = processingSteps(processing);
  const input = { rows: 0, samples: [] };
  const stages = steps.map(step => ({ type: step.type, input: 0, rows: 0, errors: 0, samples: [] }));
  const output = { rows: 0, samples: [] };
  let error;
  try {
    for await (const record of records(store, run, index)) {
      recordSample(input, record);
      for (const row of processingRows(steps, record, stages)) {
        if (output.samples.length < 3) {
          recordSample(output, Object.fromEntries(processing.columns.map(column => [column.name, cellFrom(column, row, undefined, row)])));
        } else {
          output.rows++;
        }
      }
    }
  } catch (failure) {
    if (!(failure instanceof InputError)) throw failure;
    error = failure.message;
  }
  return { input, stages, output, error };
}

async function preview(store, run, source, offset) {
  const rows = [];
  let index = 0;
  for await (const record of outputRecords(store, run, source)) {
    if (index++ < offset) continue;
    rows.push(publicValue(record));
    if (rows.length > 30) break;
  }
  return { rows: rows.slice(0, 30), more: rows.length > 30 };
}

async function* referenceValues(store, run, reference, index = 0, signal, inputs) {
  const { filter } = reference;
  const allowed = filter && new Set(filter.values.map(value => stringify(value)));
  for await (const row of records(store, run, index, signal)) {
    if (allowed && !allowed.has(stringify(get(row, filter.path)))) continue;
    const items = reference.expand === undefined ? [row] : get(row, reference.expand);
    demand(Array.isArray(items), `В ответе зависимого запроса отсутствует массив «${reference.expand}».`);
    for (const item of items) {
      if (reference.fields) {
        const fields = Object.entries(reference.fields).map(([name, path]) => {
          if (path.startsWith('$input.')) {
            const value = get(inputs, path.slice(7));
            demand(value !== undefined, `Заполните параметр формы «${path.slice(7)}».`);
            return [name, value];
          }
          const value = path.startsWith('$parent.') ? get(row, path.slice(8)) : get(item, path);
          demand(value !== undefined, `В ответе зависимого запроса отсутствует поле «${path}».`);
          return [name, value];
        });
        yield Object.fromEntries(fields);
        continue;
      }
      const value = get(item, reference.path);
      if (Array.isArray(value)) {
        yield* value;
      } else if (value !== undefined) {
        yield value;
      } else {
        demand(reference.refresh !== 'run', `В ответе зависимого запроса отсутствует поле «${reference.path}».`);
      }
    }
  }
}

function cellValue(value) {
  if (value === undefined || value === null) return null;
  if (isLosslessNumber(value) || typeof value === 'object') return scalarText(value);
  return value;
}

function tableColumns(columns) {
  return columns.length ? columns : [{ name: 'Запись', path: '$' }];
}

function cellFrom(column, row, item, parent) {
  if (column.path === '$item') return cellValue(item);
  if (column.path === '$parent') return cellValue(parent);
  if (column.path.startsWith('$item.')) return cellValue(get(item, column.path.slice(6)));
  if (column.path.startsWith('$parent.')) return cellValue(get(parent, column.path.slice(8)));
  return cellValue(get(row, column.path));
}

async function* tabularRows(readRows, columns, expansion, separate) {
  for await (const record of readRows) {
    if (expansion === undefined) {
      yield columns.map(column => cellFrom(column, record, undefined, record));
      continue;
    }
    const array = get(record, expansion);
    if (array !== undefined && array !== null && !Array.isArray(array)) {
      throw new InputError('Поле для разворачивания должно содержать массив.');
    }
    if (!separate && !array?.length) yield columns.map(column => cellFrom(column, record, undefined, record));
    for (const item of array ?? []) {
      yield columns.map(column => cellFrom(column, separate ? item : record, item, record));
    }
  }
}

function sourceTables(source, readRows, processing, extraColumns = []) {
  if (processing) return [{
    name: processing.name, headers: processing.columns.map(column => column.name),
    rows: tabularRows(readRows(), processing.columns), rowCount: 0,
  }];
  const response = source.template.response;
  const main = [...tableColumns(response.columns).filter(column => !extraColumns.some(extra => extra.name === column.name)),
    ...extraColumns];
  const definitions = [{
    name: source.template.name, headers: main.map(column => column.name),
    rows: tabularRows(readRows(), main, response.expand, false), rowCount: 0,
  }];
  for (const table of response.tables) {
    const fields = tableColumns(table.columns);
    definitions.push({ name: table.name, headers: fields.map(column => column.name),
      rows: tabularRows(readRows(), fields, table.path, true), rowCount: 0 });
  }
  return definitions;
}

async function tables(store, run, override, sourceIndex) {
  if (override?.scope === 'workbook' || (!override && run.snapshot.workbook)) {
    return workbookTables(store, run, override ?? run.snapshot.workbook.processing,
      override ? undefined : run.snapshot.workbook.bindings).definitions;
  }
  if (!override && run.snapshot.campaignReport) {
    const { statistic, adverts, products } = run.snapshot.campaignReport;
    const lookups = await campaignLookups(records(store, run, adverts), records(store, run, products));
    const readStats = () => records(store, run, statistic);
    const sheets = sourceTables(run.snapshot.sources[statistic], () => campaignRows(readStats(), lookups), undefined, campaignColumns);
    sheets.push({ name: 'Свод РК', headers: summaryHeaders, rows: campaignSummaryRows(readStats(), lookups), rowCount: 0 });
    return sheets;
  }
  return run.snapshot.sources.flatMap((source, index) => {
    if (override ? index !== sourceIndex : source.isDependency) return [];
    const processing = override ?? source.processing;
    return sourceTables(source, () => outputRecords(store, run, index, processing), processing);
  });
}

function workbookTables(store, run, processing, indices, preview = false) {
  const bindings = indices ?? workbookBindings(processing, run.snapshot.sources);
  const executor = workbookExecutor(processing,
    source => records(store, run, bindings[source.alias], undefined, source), preview);
  const definitions = processing.sheets.map(sheet => ({
    name: sheet.name, headers: sheet.columns.map(column => column.name),
    rows: tabularRows(executor.rows(sheet.input), sheet.columns, sheet.expand, sheet.separate), rowCount: 0,
  }));
  return { ...executor, definitions };
}

async function previewWorkbook(store, run, processing) {
  const { definitions, stages } = workbookTables(store, run, processing, undefined, true);
  const sheets = definitions.map(table => ({ name: table.name, rows: 0, samples: [], used: false }));
  let error;
  try {
    for (const [index, table] of definitions.entries()) {
      const sheet = sheets[index];
      sheet.used = true;
      for await (const cells of table.rows) {
        if (sheet.samples.length < 3) recordSample(sheet, Object.fromEntries(table.headers.map((name, column) => [name, cells[column]])));
        else sheet.rows++;
      }
    }
  } catch (failure) {
    if (!(failure instanceof InputError)) throw failure;
    error = failure.message;
  } finally {
    for (const table of definitions) await table.rows.return();
  }
  return { scope: 'workbook', stages, sheets, error };
}

function fileName(value, max = 80) {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().replace(/[. ]+$/, '').slice(0, max);
  return !sanitized || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized) ? `_${sanitized || 'данные'}` : sanitized;
}

function dailyName(now) {
  const date = new Date(now);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(value => String(value).padStart(2, '0')).join('-');
}

function csvCell(value) {
  if (value === null) return '';
  const raw = String(value);
  const safe = typeof value === 'string' && /^[\s\u0000]*[=+\-@]/.test(raw) && !/^-?\d+(?:\.\d+)?$/.test(raw)
    ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

async function writeCsv(dir, definitions) {
  for (const [index, table] of definitions.entries()) {
    const filename = path.join(dir, `${String(index + 1).padStart(2, '0')}-${fileName(table.name)}.csv`);
    const file = await fs.open(filename, 'w', 0o600);
    try {
      await file.write(`\ufeff${table.headers.map(csvCell).join(',')}\r\n`);
      let buffer = '';
      for await (const row of table.rows) {
        table.rowCount++;
        buffer += `${row.map(csvCell).join(',')}\r\n`;
        if (buffer.length >= 128 * 1024) {
          await file.write(buffer);
          buffer = '';
        }
      }
      if (buffer) await file.write(buffer);
    } finally {
      await file.close();
    }
  }
}

function sheetNames(definitions) {
  const used = new Set();
  return definitions.map(table => {
    const base = fileName(table.name.replace(/[\[\]]/g, '-').replace(/^'+|'+$/g, ''), 31);
    let name = base;
    let index = 2;
    while (used.has(name.toLowerCase()) || name.toLowerCase() === 'history') {
      const suffix = ` ${index++}`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

async function writeXlsx(dir, name, definitions, rowLimit) {
  const sheetLabels = sheetNames(definitions);
  const cursors = await Promise.all(definitions.map(table => table.rows.next()));
  for (let part = 1; ; part++) {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path.join(dir, `${fileName(name)}${part === 1 ? '' : `-${part}`}.xlsx`),
      useSharedStrings: false, useStyles: false,
    });
    try {
      for (const [index, table] of definitions.entries()) {
        const sheet = workbook.addWorksheet(sheetLabels[index]);
        demand(table.headers.length <= 16_384, 'Колонок больше, чем поддерживает Excel.');
        sheet.addRow(table.headers).commit();
        for (let count = 0; count < rowLimit && !cursors[index].done; count++) {
          const row = cursors[index].value;
          demand(row.every(value => typeof value !== 'string' || value.length <= 32_767),
            'Значение длиннее 32 767 символов. Для этой выгрузки доступен CSV.');
          sheet.addRow(row).commit();
          table.rowCount++;
          cursors[index] = await table.rows.next();
        }
        sheet.commit();
      }
      await workbook.commit();
    } catch (error) {
      const closed = finished(workbook.stream).catch(() => {});
      workbook.zip.abort();
      workbook.stream.destroy();
      await closed;
      throw error;
    }
    if (cursors.every(cursor => cursor.done)) break;
  }
}

async function exportRun(store, run, format, { rowLimit = XLSX_ROWS, processing, sourceIndex } = {}) {
  demand(['xlsx', 'csv'].includes(format), 'Выберите XLSX или CSV.');
  const sources = processing && processing.scope !== 'workbook' ? { [sourceIndex]: run.progress.sources?.[sourceIndex] }
    : Object.fromEntries(Object.entries(run.progress.sources ?? {}).filter(([index]) => !run.snapshot.sources[index]?.isDependency));
  demand(run.snapshot.sources.length && Object.values(sources).some(source =>
    source?.rows > 0 || source?.state === 'completed'), 'Доступных результатов для экспорта нет.');
  const title = processing?.name ?? run.name;
  const definitions = await tables(store, run, processing, sourceIndex);
  demand(definitions.length, 'Доступных таблиц для экспорта нет.');
  const target = path.join(store.root, 'exports');
  const temporary = await fs.mkdtemp(path.join(target, '.export-'));
  const name = `${run.state === 'completed' ? '' : 'ЧАСТИЧНО-'}${fileName(title)}`;
  try {
    if (format === 'csv') await writeCsv(temporary, definitions);
    if (format === 'xlsx') await writeXlsx(temporary, name, definitions, rowLimit);
    await fs.writeFile(path.join(temporary, 'результат.json'), JSON.stringify({
      id: run.id, name: title, state: run.state, sources,
      tables: definitions.map(table => ({ name: table.name, rows: table.rowCount })),
    }, null, 2), { mode: 0o600 });
    const dir = path.join(target, `${run.id}--${name}-${format}-${randomUUID().slice(0, 8)}`);
    await fs.rename(temporary, dir);
    return dir;
  } finally {
    for (const table of definitions) await table.rows.return();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function generalLog(store, now = Date.now()) {
  return path.join(store.root, 'logs', `${dailyName(now)}.ndjson`);
}

function runLog(store, id) {
  return path.join(store.root, 'logs', 'runs', `${id}.ndjson`);
}

async function logEvent(store, runId, type, fields = {}, general = false) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), runId, type, ...fields })}\n`;
  const filename = runLog(store, runId);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.appendFile(filename, line, { mode: 0o600 });
  if (general) await fs.appendFile(generalLog(store), line, { mode: 0o600 });
}

async function logTail(filename) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const { size } = await file.stat();
    const length = Math.min(128 * 1024, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    const value = buffer.subarray(0, bytesRead).toString();
    return length < size ? value.slice(value.indexOf('\n') + 1) : value;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    await file?.close();
  }
}

async function prune(store, now = Date.now()) {
  const retention = store.setting('retention');
  const exportsDir = path.join(store.root, 'exports');
  const exports = await fs.readdir(exportsDir, { withFileTypes: true });
  for (const { id } of store.expiredRuns(now - retention.dataDays * DAY)) {
    store.removeRun(id);
    await fs.rm(path.join(store.root, 'data', 'runs', id), { recursive: true, force: true });
    for (const name of exports.filter(item => item.isDirectory() && item.name.startsWith(`${id}--`))) {
      await fs.rm(path.join(exportsDir, name.name), { recursive: true, force: true });
    }
  }
  for (const dir of [path.join(store.root, 'logs'), path.join(store.root, 'logs', 'runs')]) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue;
      const filename = path.join(dir, entry.name);
      const metadata = await fs.stat(filename);
      if (metadata.mtimeMs < now - retention.logsDays * DAY) await fs.rm(filename, { force: true });
    }
  }
}

module.exports = { exportRun, generalLog, logEvent, logTail, pageFile, preview, previewProcessing, prune, records,
  referenceValues, runLog, sample, saveSample, writePage };
