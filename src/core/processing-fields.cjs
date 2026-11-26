const { readSample } = require('./datasets.cjs');
const { InputError, integer, isLosslessNumber, object, parseJson, pathParts } = require('./json.cjs');
const { id, responseRows } = require('./model.cjs');

const sampleItems = 50;
const sampleDepth = 20;
const sampleValues = 12_000;
const maxChoices = 3000;

function shape(type, fields = new Map(), item) {
  return { types: new Set(type ? [type] : []), fields, item };
}

function paths(path) {
  try { return pathParts(path); }
  catch (error) {
    if (!(error instanceof InputError)) throw error;
    return null;
  }
}

function observe(node, value, scan, depth = 0) {
  if (!scan.remaining) {
    scan.limited = true;
    return;
  }
  scan.remaining--;
  if (Array.isArray(value)) {
    node.types.add('array');
    if (depth === sampleDepth) { scan.limited ||= value.length > 0; return; }
    scan.limited ||= value.length > sampleItems;
    if (value.length) node.item ??= shape();
    for (const item of value.slice(0, sampleItems)) observe(node.item, item, scan, depth + 1);
  } else if (object(value)) {
    node.types.add('object');
    if (depth === sampleDepth) { scan.limited = true; return; }
    for (const name in value) {
      if (!scan.remaining) { scan.limited = true; break; }
      if (!Object.hasOwn(value, name) || !name || name.includes('.') || !paths(`$.${name}`)) continue;
      if (!node.fields.has(name)) node.fields.set(name, shape());
      observe(node.fields.get(name), value[name], scan, depth + 1);
    }
  } else {
    node.types.add(isLosslessNumber(value) ? (integer(value) === null ? 'number' : 'int64')
      : value === null ? 'null' : typeof value);
  }
}

function union(nodes) {
  const defined = nodes.filter(Boolean);
  if (defined.length < 2) return defined[0];
  const merged = shape();
  for (const node of defined) {
    for (const type of node.types) merged.types.add(type);
    for (const [name, child] of node.fields) merged.fields.set(name, union([merged.fields.get(name), child]));
    merged.item = union([merged.item, node.item]);
  }
  return merged;
}

function unwrapArrays(node) {
  if (!node?.types.has('array')) return node;
  const otherTypes = new Set([...node.types].filter(type => type !== 'array'));
  return union([otherTypes.size && { ...node, types: otherTypes, item: undefined }, unwrapArrays(node.item)]);
}

function at(node, path, nested = false) {
  const parts = paths(path);
  if (!parts) return undefined;
  for (const name of parts) {
    if (nested) node = unwrapArrays(node);
    node = node?.fields.get(name) ?? (/^(0|[1-9]\d*)$/.test(name) ? node?.item : undefined);
  }
  return nested ? unwrapArrays(node) : node;
}

function namedFields(row, entries) {
  const fields = new Map(row?.fields);
  for (const [name, node] of entries) {
    if (typeof name === 'string' && /^[a-zA-Z0-9_-]{1,90}$/.test(name) && paths(name)) {
      fields.set(name, node ?? shape('unknown'));
    }
  }
  return shape('object', fields);
}

function project(step, row, right) {
  switch (step.type) {
    case 'expandArray':
      return namedFields(row, [[step.as, at(row, step.path)?.item]]);
    case 'expandObjects':
      return namedFields(row, [[step.as, union((step.variants ?? []).map(variant => at(row, variant.path)))], [step.labelAs, shape('string')]]);
    case 'copy':
      return namedFields(step.keepOriginal ? row : undefined, (step.fields ?? []).map(field => [field.to, at(row, field.from)]));
    case 'join':
      return namedFields(row, [[step.as, (step.matches ?? 'list') === 'list' ? shape('array', undefined, right) : right]]);
    case 'collect':
      return namedFields(row, [[step.as, shape('string')]]);
    case 'allocate':
      return namedFields(row, [[step.as, namedFields(undefined, [
        ['group', shape('string')], ...(step.metrics ?? []).map(metric => [metric.name, shape('number')]),
      ])]]);
    case 'group':
      return namedFields(undefined, [...(step.keys ?? []).map(key => [key.name, at(row, key.path)]),
        ...(step.metrics ?? []).map(metric => [metric.name, shape('number')])]);
    default:
      return row;
  }
}

function parameterShape(spec) {
  const fields = new Map(Object.entries(spec.properties ?? {}).map(([name, child]) => [name, parameterShape(child)]));
  return shape(spec.type, fields, spec.items && parameterShape(spec.items));
}

function addRequestFields(row, parameters, requestFields) {
  if (!requestFields?.length) return row;
  const request = namedFields(row?.fields.get('request'), requestFields.map(field => [field.name, at(parameters, field.path)]));
  return namedFields(row, [['request', request]]);
}

function fieldChoices(row, selection) {
  const { kind, path } = selection;
  const requiredTypes = kind === 'details' ? ['array', 'object'] : ['array', 'object'].includes(kind) ? [kind] : [];
  const choices = [];
  let limited = false;
  function visit(node, prefix) {
    if (!node?.types.size) return;
    if (choices.length >= maxChoices) { limited = true; return; }
    if (!requiredTypes.length || requiredTypes.some(type => node.types.has(type))) {
      choices.push({ path: prefix, types: [...node.types] });
    }
    const children = kind === 'details' ? unwrapArrays(node)?.fields : node.fields;
    if (children) for (const [name, child] of children) {
      visit(child, prefix === '$' && !name.startsWith('$') ? name : `${prefix}.${name}`);
    }
  }
  if (kind === 'column' && path !== undefined) {
    visit(at(row, path)?.item, '$item');
    visit(row, '$parent');
  } else {
    const node = kind === 'item' ? at(row, path)?.item : kind === 'member' ? at(row, path)
      : kind === 'detail' ? at(row, path, true) : row;
    visit(node, '$');
  }
  return { choices, limited };
}

function currentSample(tested, template, endpoint) {
  const previous = tested?.template;
  if (!previous || !['id', 'connectionId', 'endpointId', 'method', 'path'].every(key => previous[key] === template[key])) return false;
  const address = tested.environment === 'sandbox' ? 'sandbox' : 'url';
  const testEndpoint = tested.connection?.endpoints.find(item => item.id === previous.endpointId);
  return Boolean(endpoint?.[address] && endpoint[address] === testEndpoint?.[address]);
}

async function sampleShape(store, record, endpoint) {
  const template = record.published;
  const name = `«${template.name}»`;
  if (!record.sample_run_id) return { notice: `Для ${name} пока нет сохранённого образца. Выполните тест шаблона.` };
  const tested = store.run(record.sample_run_id)?.snapshot?.sources?.[0];
  if (!currentSample(tested, template, endpoint)) return { notice: `Повторите тест ${name}. Образец получен с другими настройками запроса.` };
  const raw = await readSample(store, record.sample_run_id, 0);
  if (raw === null) return { notice: `Файл образца ${name} недоступен. Повторите тест шаблона.` };
  let rows;
  try {
    // Поля запроса добавляются по настройкам шаблона. В образце хранится исходный ответ.
    rows = responseRows({ ...template.response, requestFields: undefined }, parseJson(raw), 200, {});
  } catch (error) {
    if (!(error instanceof InputError || error instanceof SyntaxError)) throw error;
    return { notice: `В образце ${name} не удалось выделить записи. Проверьте путь к строкам или повторите тест.` };
  }
  if (!rows.length) return { notice: `Сохранённый образец ${name} содержит 0 записей.` };
  const sample = shape();
  const scan = { remaining: sampleValues, limited: rows.length > sampleItems };
  for (const row of rows.slice(0, sampleItems)) observe(sample, row, scan);
  return { row: sample, notice: scan.limited ? `Из образца ${name} прочитана часть записей или вложенных элементов.` : undefined };
}

class ProcessingFieldLists {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }

  async source(source) {
    if (!source.templateId) return { notices: ['Выберите шаблон запроса в источнике.'] };
    const record = this.store.template(id(source.templateId));
    if (!record?.published) return { notices: ['Опубликованный шаблон недоступен.'] };
    const template = record.published;
    const endpoint = this.store.connection(template.connectionId)?.endpoints.find(item => item.id === template.endpointId);
    const key = JSON.stringify([record.sample_run_id, record.version, endpoint?.url, endpoint?.sandbox]);
    let entry = this.cache.get(record.id);
    if (entry?.key !== key) {
      this.cache.delete(record.id);
      entry = { key, data: sampleShape(this.store, record, endpoint) };
      if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(record.id, entry);
    }
    let sample;
    try { sample = await entry.data; }
    catch (error) {
      if (this.cache.get(record.id) === entry) this.cache.delete(record.id);
      throw error;
    }
    const parameters = shape('object', new Map(template.parameters.map(spec => [spec.name, parameterShape(spec)])));
    const metadata = Object.entries(template.response.requestFields ?? {}).map(([name, path]) => ({ name, path }));
    return { row: addRequestFields(sample.row, parameters, [...metadata, ...(source.requestFields ?? [])]),
      notices: sample.notice ? [sample.notice] : [] };
  }

  async workbook(sources, steps, alias) {
    const datasets = new Map();
    for (const source of sources) {
      if (!source.alias || datasets.has(source.alias)) continue;
      let result;
      datasets.set(source.alias, () => result ??= this.source(source));
    }
    for (const step of steps) {
      if (!step.output || datasets.has(step.output)) continue;
      const input = datasets.get(step.input);
      const right = step.type === 'join' ? datasets.get(step.right) : undefined;
      let result;
      datasets.set(step.output, () => result ??= Promise.all([input?.(), right?.()]).then(([main, lookup]) => ({
        row: project(step, main?.row, lookup?.row),
        notices: [...(main?.notices ?? []), ...(lookup?.notices ?? [])],
      })));
    }
    return datasets.get(alias)?.() ?? { notices: ['Выберите входной набор.'] };
  }

  async choices({ templateId, sources, steps = [], alias, selection = {} }) {
    let dataset;
    if (sources) dataset = await this.workbook(sources, steps, alias);
    else {
      const input = await this.source({ templateId });
      dataset = { ...input, row: steps.reduce((row, step) => project(step, row), input.row) };
    }
    const result = fieldChoices(dataset.row, selection);
    const notices = [...new Set(dataset.notices)];
    if (result.limited) notices.push('Доступна часть путей из большого набора.');
    return { choices: result.choices, notices };
  }
}

module.exports = { ProcessingFieldLists };
