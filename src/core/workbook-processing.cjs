const { InputError, get, integer, isLosslessNumber, object, pathParts, scalarText, stringify } = require('./json.cjs');
const { columns, demand, id, positive, text } = require('./model.cjs');
const { recordSample, stepRows, validateStep } = require('./processings.cjs');

const rowSteps = ['filter', 'validate', 'expandArray', 'expandObjects', 'copy'];

function list(value, label, read, empty = false) {
  demand(Array.isArray(value) && (empty || value.length), `Укажите ${label}.`);
  return value.map(item => {
    demand(object(item), `Проверьте ${label}.`);
    return read(item);
  });
}

function path(value) { pathParts(value); return value; }

function unique(items, key, message) {
  demand(new Set(items.map(item => item[key])).size === items.length, message);
  return items;
}

function keyType(value = 'exact') {
  demand(['exact', 'text', 'integer'].includes(value), 'Выберите тип сравнения ключа.');
  return value;
}

function choice(value, choices, message) {
  demand(choices.includes(value), message);
  return value;
}

function workbookStep(step, known) {
  const input = id(step.input);
  const output = id(step.output);
  demand(known.has(input), `Источник «${input}» должен быть указан перед этим шагом.`);
  demand(!known.has(output), `Имя «${output}» уже используется.`);
  const onError = choice(step.onError ?? 'stop', ['stop', 'skip'], 'Выберите действие при ошибке.');
  const base = { input, output, type: step.type, onError };
  if (rowSteps.includes(step.type)) return { ...base, ...validateStep(step) };
  switch (step.type) {
    case 'join': {
      const right = id(step.right);
      demand(known.has(right), `Справочник «${right}» должен быть указан перед соединением.`);
      const keys = list(step.keys, 'ключи соединения', key => ({ left: path(key.left), right: path(key.right), type: keyType(key.type) }));
      return { ...base, right, keys, as: id(step.as),
        matches: choice(step.matches ?? 'list', ['list', 'expand', 'first', 'unique'], 'Выберите обработку нескольких совпадений.'),
        missing: choice(step.missing ?? 'keep', ['keep', 'drop', 'error'], 'Выберите действие при отсутствии совпадения.') };
    }
    case 'collect':
      return { ...base, path: path(step.path), value: path(step.value), as: id(step.as),
        separator: String(step.separator ?? ', '), missing: String(step.missing ?? ''), unique: step.unique !== false };
    case 'distinct':
      return { ...base, keys: list(step.keys, 'ключи удаления дублей', key => ({ path: path(key.path), type: keyType(key.type) })) };
    case 'allocate': {
      const keys = { items: path(step.items), label: path(step.label), itemKey: path(step.itemKey),
        details: path(step.details), detailKey: path(step.detailKey), as: id(step.as) };
      const metrics = unique(list(step.metrics, 'показатели для распределения', metric => ({
        total: path(metric.total), detail: path(metric.detail), name: id(metric.name),
      })), 'name', 'Имена показателей должны различаться.');
      demand(!metrics.some(metric => metric.name === 'group'), 'Имя group используется для названия группы.');
      return { ...base, ...keys, metrics, unknown: text(step.unknown, 'название для пустой группы'),
        mixed: text(step.mixed, 'название для нескольких групп'),
        multiple: choice(step.multiple ?? 'reconcile', ['reconcile', 'combine'], 'Выберите правило распределения.') };
    }
    case 'group': {
      const keys = list(step.keys ?? [], 'ключи группировки', key => ({ path: path(key.path), name: id(key.name) }), true);
      const metrics = list(step.metrics, 'итоговые показатели', metric => {
        const op = choice(metric.op, ['sum', 'count', 'countDistinct', 'min', 'max'], 'Выберите операцию для показателя.');
        return { name: id(metric.name), op, ...(op === 'count' ? {} : { path: path(metric.path) }) };
      });
      unique([...keys, ...metrics], 'name', 'Имена полей результата группировки должны различаться.');
      return { ...base, keys, metrics, ...(step.uniform ? { uniform: path(step.uniform) } : {}) };
    }
    default:
      throw new InputError('Выберите поддерживаемый шаг обработки выгрузки.');
  }
}

function validateWorkbook(value) {
  demand(object(value), 'Укажите настройки обработки выгрузки.');
  const sources = unique(list(value.sources, 'источники обработки', source => ({
    alias: id(source.alias), templateId: id(source.templateId),
    ...(source.occurrence !== undefined ? { occurrence: positive(source.occurrence, 'номер источника', 30) } : {}),
    allRows: source.allRows === true,
    requestFields: unique(list(source.requestFields ?? [], 'поля из параметров запроса', field => ({ path: path(field.path), name: id(field.name) }), true),
      'name', 'Имена полей из запроса должны различаться.'),
  })), 'alias', 'Имена источников должны различаться.');
  const known = new Set(sources.map(source => source.alias));
  const steps = list(value.steps, 'шаги обработки', step => {
    const config = workbookStep(step, known);
    known.add(config.output);
    return config;
  }, true);
  const sheets = list(value.sheets, 'листы результата', sheet => {
    const input = id(sheet.input);
    demand(known.has(input), `Для листа выберите существующий набор «${input}».`);
    const fields = columns(sheet.columns);
    demand(fields.length > 0 && fields.length <= 16_384, 'Выберите колонки листа.');
    return { name: text(sheet.name, 'название листа'), input, columns: fields,
      ...(sheet.expand !== undefined ? { expand: path(sheet.expand), separate: sheet.separate === true } : {}) };
  });
  return { id: id(value.id), name: text(value.name, 'название обработки'), scope: 'workbook', sources, steps, sheets };
}

function workbookBindings(processing, sources) {
  return Object.fromEntries(processing.sources.map(source => {
    demand(object(source), 'Проверьте источники обработки.');
    id(source.alias);
    id(source.templateId);
    if (source.occurrence !== undefined) positive(source.occurrence, 'номер источника', 30);
    const matching = sources.flatMap((item, index) => !item.isDependency && item.template.id === source.templateId ? [index] : []);
    const index = source.occurrence ? matching[source.occurrence - 1] : matching.length === 1 ? matching[0] : undefined;
    demand(index !== undefined, matching.length > 1
      ? `Для «${source.alias}» укажите номер источника с этим шаблоном в обработке.`
      : `Добавьте источник «${source.alias}» с выбранным шаблоном в выгрузку.`);
    return [source.alias, index];
  }));
}

function keyPart(value, type) {
  if (value == null || value === '') return undefined;
  if (type === 'text') return scalarText(value);
  if (type === 'integer') {
    const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : integer(value);
    return parsed?.toString();
  }
  return value;
}

function recordKey(row, keys, side) {
  const values = keys.map(key => keyPart(get(row, key[side]), key.type));
  return values.some(value => value === undefined) ? undefined : stringify(values);
}

async function indexRows(rows, keys) {
  const index = new Map();
  for await (const row of rows) {
    const key = recordKey(row, keys, 'right');
    if (key === undefined) continue;
    const group = index.get(key) ?? [];
    group.push(row);
    index.set(key, group);
  }
  return index;
}

function* joinRow(row, step, index, trace) {
  let matches = index.get(recordKey(row, step.keys, 'left')) ?? [];
  if (step.matches === 'unique' && matches.length > 1) {
    const first = stringify(matches[0]);
    if (matches.some(candidate => stringify(candidate) !== first)) {
      if (trace) trace.conflicts++;
      matches = [];
    }
  }
  if (!matches.length) {
    if (trace) trace.unmatched++;
    if (step.missing === 'error') throw new InputError('Для ключа строки не найдено совпадение.');
    if (step.missing === 'drop') return;
  }
  if (step.matches === 'list') yield { ...row, [step.as]: matches };
  else if (step.matches === 'expand' && matches.length) {
    for (const match of matches) yield { ...row, [step.as]: match };
  } else yield { ...row, [step.as]: matches[0] ?? null };
}

function array(row, field) {
  const values = get(row, field);
  demand(values == null || Array.isArray(values), `Поле «${field}» должно быть массивом.`);
  return values ?? [];
}

function* nestedRows(value, parts, index = 0) {
  if (Array.isArray(value)) {
    for (const item of value) yield* nestedRows(item, parts, index);
  } else if (value != null) {
    if (index === parts.length) yield value;
    else yield* nestedRows(get(value, parts[index]), parts, index + 1);
  }
}

function numeric(value, field) {
  const result = value == null ? 0 : isLosslessNumber(value) ? Number(value.value) : value;
  demand(Number.isFinite(result), `Показатель «${field}» должен быть числом.`);
  return result;
}

function* allocate(row, step) {
  const labels = new Map();
  for (const item of array(row, step.items)) {
    const key = keyPart(get(item, step.itemKey), 'integer') ?? keyPart(get(item, step.itemKey), 'text');
    const label = scalarText(get(item, step.label)).trim() || step.unknown;
    if (key !== undefined) labels.set(key, labels.has(key) && labels.get(key) !== label ? step.unknown : label);
  }
  const groups = new Set(labels.values());
  const total = step.metrics.map(metric => numeric(get(row, metric.total), metric.total));
  const output = (group, values) => ({ ...row, [step.as]: { group,
    ...Object.fromEntries(step.metrics.map((metric, index) => [metric.name, values[index]])) } });
  if (groups.size <= 1) {
    yield output(groups.values().next().value ?? step.unknown, total);
    return;
  }
  if (step.multiple === 'reconcile') {
    const byGroup = new Map();
    const represented = total.map(() => 0);
    for (const detail of nestedRows(row, pathParts(step.details))) {
      const value = get(detail, step.detailKey);
      const key = keyPart(value, 'integer') ?? keyPart(value, 'text');
      const group = labels.get(key) ?? step.unknown;
      const values = byGroup.get(group) ?? total.map(() => 0);
      for (const [index, metric] of step.metrics.entries()) {
        const amount = numeric(get(detail, metric.detail), metric.detail);
        values[index] += amount;
        represented[index] += amount;
      }
      byGroup.set(group, values);
    }
    if (byGroup.size && total.every((value, index) => Math.abs(value - represented[index]) <= 1e-7 + 32 * Number.EPSILON * Math.abs(value))) {
      for (const [group, values] of byGroup) yield output(group, values);
      return;
    }
  }
  yield output([...groups].filter(group => group !== step.unknown).length > 1 ? step.mixed : step.unknown, total);
}

function* transform(row, step, context) {
  if (step.type === 'join') yield* joinRow(row, step, context.index, context.trace);
  else if (step.type === 'allocate') yield* allocate(row, step);
  else if (step.type === 'collect') {
    const values = array(row, step.path).map(item => scalarText(get(item, step.value)).trim() || step.missing);
    const collected = (step.unique ? [...new Set(values)] : values).filter(value => value !== '').join(step.separator);
    yield { ...row, [step.as]: collected || step.missing };
  } else if (step.type === 'distinct') {
    const key = recordKey(row, step.keys, 'path');
    if (key !== undefined && context.seen.has(key)) return;
    if (key !== undefined) context.seen.add(key);
    yield row;
  } else yield* stepRows(step, row);
}

async function* groupRows(rows, step, trace) {
  const groups = new Map();
  let common;
  for await (const row of rows) {
    if (trace) trace.input++;
    try {
      const uniform = step.uniform ? get(row, step.uniform) : null;
      const encoded = uniform == null ? undefined : stringify(uniform);
      demand(encoded === undefined || common === undefined || common === encoded, `Значения «${step.uniform}» должны совпадать.`);
      const keys = step.keys.map(field => get(row, field.path) ?? null);
      const key = stringify(keys);
      const values = step.metrics.map(metric => {
        if (metric.op === 'count') return 1;
        const value = get(row, metric.path);
        if (metric.op === 'countDistinct' || (metric.op !== 'sum' && value == null)) return value;
        return numeric(value, metric.path);
      });
      common ??= encoded;
      const group = groups.get(key) ?? { keys, totals: step.metrics.map(metric => metric.op === 'countDistinct' ? new Set() : undefined) };
      for (const [index, { op }] of step.metrics.entries()) {
        const value = values[index];
        if (value == null) continue;
        if (op === 'countDistinct') {
          group.totals[index].add(stringify(value));
        } else if (op === 'min') group.totals[index] = Math.min(group.totals[index] ?? value, value);
        else if (op === 'max') group.totals[index] = Math.max(group.totals[index] ?? value, value);
        else group.totals[index] = (group.totals[index] ?? 0) + value;
      }
      groups.set(key, group);
    } catch (error) { handleRowError(error, step, trace); }
  }
  const sortKeys = (left, right) => {
    for (let index = 0; index < left.keys.length; index++) {
      const compared = scalarText(left.keys[index]).localeCompare(scalarText(right.keys[index]), 'ru', { numeric: true });
      if (compared) return compared;
    }
    return 0;
  };
  for (const { keys, totals } of [...groups.values()].sort(sortKeys)) yield Object.fromEntries([
    ...step.keys.map((key, index) => [key.name, keys[index]]),
    ...step.metrics.map((metric, index) => [metric.name, metric.op === 'countDistinct' ? totals[index].size : totals[index]]),
  ]);
}

function handleRowError(error, step, trace) {
  if (!(error instanceof InputError)) throw error;
  if (trace) trace.errors++;
  if (step.onError !== 'skip') throw new InputError(`${step.output}. ${error.message}`);
}

function workbookExecutor(processing, readSource, preview) {
  const datasets = new Map();
  const stages = [];
  function add(alias, factory, type) {
    const trace = preview ? { alias, type, input: type === 'source' ? undefined : 0, rows: 0, errors: 0,
      unmatched: 0, conflicts: 0, samples: [], used: false } : null;
    if (trace) stages.push(trace);
    datasets.set(alias, async function* () {
      const observe = trace && !trace.used ? trace : null;
      if (observe) observe.used = true;
      for await (const row of factory(observe)) {
        if (observe) recordSample(observe, row);
        yield row;
      }
    });
  }
  for (const source of processing.sources) add(source.alias, () => readSource(source), 'source');
  for (const step of processing.steps) {
    let lookup;
    add(step.output, async function* (trace) {
      const input = datasets.get(step.input)();
      if (step.type === 'group') {
        yield* groupRows(input, step, trace);
        return;
      }
      if (step.type === 'join') lookup ??= indexRows(datasets.get(step.right)(), step.keys);
      const context = { index: await lookup, trace, seen: new Set() };
      for await (const row of input) {
        if (trace) trace.input++;
        try { yield* transform(row, step, context); }
        catch (error) { handleRowError(error, step, trace); }
      }
    }, step.type);
  }
  return { stages, rows: alias => datasets.get(alias)() };
}

module.exports = { validateWorkbook, workbookBindings, workbookExecutor };
