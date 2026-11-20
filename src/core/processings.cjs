const { InputError, get, object, pathParts, stringify } = require('./json.cjs');
const { columns, dateMs, demand, id, text } = require('./model.cjs');

const FUNNEL_PATH = '/api/analytics/v3/sales-funnel/products';
const FUNNEL_TYPE = 'wb-funnel-periods';
const CLUSTERS_PATH = '/adv/v1/normquery/stats';
const CLUSTERS_TYPE = 'wb-search-clusters-by-day';

const FUNNEL_COLUMNS = [
  ['product.nmId', 'Артикул WB'],
  ['product.title', 'Название'],
  ['product.vendorCode', 'Артикул продавца'],
  ['product.brandName', 'Бренд'],
  ['product.stocks.balanceSum', 'Суммарный остаток'],
  ['periodType', 'Тип периода'],
  ['statistic.period.start', 'Начало периода'],
  ['statistic.period.end', 'Конец периода'],
  ['statistic.openCount', 'Переходы в карточку'],
  ['statistic.cartCount', 'Добавления в корзину'],
  ['statistic.orderCount', 'Заказы, шт.'],
  ['statistic.orderSum', 'Сумма заказов'],
  ['statistic.buyoutCount', 'Выкупы, шт.'],
  ['statistic.buyoutSum', 'Сумма выкупов'],
  ['statistic.cancelCount', 'Отмены, шт.'],
  ['statistic.cancelSum', 'Сумма отмен'],
  ['statistic.avgPrice', 'Средняя цена'],
  ['statistic.avgOrdersCountPerDay', 'Среднее число заказов в день'],
  ['statistic.shareOrderPercent', 'Доля заказов, %'],
  ['statistic.addToWishlist', 'Добавления в избранное'],
  ['statistic.timeToReady.days', 'Время до готовности, дни'],
  ['statistic.timeToReady.hours', 'Время до готовности, часы'],
  ['statistic.timeToReady.mins', 'Время до готовности, минуты'],
  ['statistic.localizationPercent', 'Локализация, %'],
  ['statistic.wbClub.orderCount', 'WB Клуб · Заказы, шт.'],
  ['statistic.wbClub.orderSum', 'WB Клуб · Сумма заказов'],
  ['statistic.wbClub.buyoutCount', 'WB Клуб · Выкупы, шт.'],
  ['statistic.wbClub.buyoutSum', 'WB Клуб · Сумма выкупов'],
  ['statistic.wbClub.cancelCount', 'WB Клуб · Отмены, шт.'],
  ['statistic.wbClub.cancelSum', 'WB Клуб · Сумма отмен'],
  ['statistic.wbClub.avgPrice', 'WB Клуб · Средняя цена'],
  ['statistic.wbClub.buyoutPercent', 'WB Клуб · Выкуп, %'],
  ['statistic.wbClub.avgOrderCountPerDay', 'WB Клуб · Среднее число заказов в день'],
  ['statistic.conversions.addToCartPercent', 'Конверсия в корзину, %'],
  ['statistic.conversions.cartToOrderPercent', 'Конверсия из корзины в заказ, %'],
  ['statistic.conversions.buyoutPercent', 'Выкуп, %'],
].map(([path, name]) => ({ path, name }));

const CLUSTERS_COLUMNS = [
  ...['advertId', 'nmId', 'date'].map(name => ({ path: name, name })),
  ...['atbs', 'avgPos', 'clicks', 'cpc', 'cpm', 'ctr', 'currency', 'normQuery', 'orders', 'shks', 'spend', 'views']
    .map(name => ({ path: `stat.${name}`, name })),
];

const kinds = {
  [FUNNEL_TYPE]: {
    path: FUNNEL_PATH, rows: 'data.products',
    name: 'Воронка WB по периодам',
    steps: [
      { type: 'validate', checks: [{ path: 'product.nmId', kind: 'present' }, { path: 'statistic', kind: 'object' }] },
      { type: 'expandObjects', as: 'statistic', labelAs: 'periodType', variants: [
        { path: 'statistic.selected', label: 'Текущий' },
        { path: 'statistic.past', label: 'Предыдущий', optional: true, ifPresent: 'period' },
      ] },
      { type: 'validate', checks: [
        { path: 'statistic.period.start', kind: 'dateInterval', endPath: 'statistic.period.end' },
      ] },
      { type: 'copy', fields: ['product', 'periodType', 'statistic'].map(name => ({ from: name, to: name })) },
    ],
    columns: FUNNEL_COLUMNS,
  },
  [CLUSTERS_TYPE]: {
    path: CLUSTERS_PATH, rows: 'items',
    name: 'Поисковые кластеры WB по дням',
    steps: [
      { type: 'filter', path: 'dailyStats', operator: 'arrayNotEmpty' },
      { type: 'validate', checks: ['advertId', 'nmId'].map(path => ({ path, kind: 'present' })) },
      { type: 'expandArray', path: 'dailyStats', as: 'day' },
      { type: 'validate', checks: [{ path: 'day.date', kind: 'date' }, { path: 'day.stat', kind: 'object' }] },
      { type: 'copy', fields: [
        { from: 'advertId', to: 'advertId' }, { from: 'nmId', to: 'nmId' },
        { from: 'day.date', to: 'date' }, { from: 'day.stat', to: 'stat' },
      ] },
    ],
    columns: CLUSTERS_COLUMNS,
  },
};

function processingDefaults(template) {
  const preset = Object.values(kinds).find(spec => template.path === spec.path && template.response.rows === spec.rows);
  if (preset) return { name: preset.name, steps: preset.steps, columns: preset.columns };
  return { name: template.name, steps: [],
    columns: template.response.columns.length ? template.response.columns : [{ path: '$', name: 'Запись' }] };
}

function fieldPath(value) {
  pathParts(value);
  return value;
}

function stepList(items, label, read) {
  demand(Array.isArray(items) && items.length > 0, label);
  return items.map(item => {
    demand(object(item), label);
    return read(item);
  });
}

function validateStep(step) {
  demand(object(step), 'Укажите настройки шага.');
  const onError = step.onError ?? 'stop';
  demand(['stop', 'skip'].includes(onError), 'Выберите действие при ошибке.');
  const config = { type: step.type, onError };
  switch (step.type) {
    case 'filter': {
      const { operator, value } = step;
      demand(['present', 'arrayNotEmpty', 'equals', 'notEquals'].includes(operator), 'Укажите условие фильтра.');
      const comparison = operator === 'equals' || operator === 'notEquals';
      demand(!comparison || value !== undefined, 'Укажите значение для сравнения.');
      return { ...config, path: fieldPath(step.path), operator, ...(comparison ? { value } : {}) };
    }
    case 'validate':
      return { ...config, checks: stepList(step.checks, 'Добавьте проверку поля.', check => {
        demand(['present', 'object', 'array', 'date', 'dateInterval'].includes(check.kind), 'Выберите вид проверки.');
        return { path: fieldPath(check.path), kind: check.kind,
          ...(check.kind === 'dateInterval' ? { endPath: fieldPath(check.endPath) } : {}) };
      }) };
    case 'expandArray':
      return { ...config, path: fieldPath(step.path), as: id(step.as), keepEmpty: step.keepEmpty === true };
    case 'expandObjects': {
      const as = id(step.as);
      const labelAs = step.labelAs ? id(step.labelAs) : '';
      demand(as !== labelAs, 'Выберите разные имена для объекта и подписи.');
      return { ...config, as, labelAs, variants: stepList(step.variants, 'Добавьте объект для разворота.', variant => ({
        path: fieldPath(variant.path), optional: variant.optional === true,
        ...(labelAs ? { label: text(variant.label, 'подпись объекта') } : {}),
        ...(variant.ifPresent ? { ifPresent: fieldPath(variant.ifPresent) } : {}),
      })) };
    }
    case 'copy': {
      const fields = stepList(step.fields, 'Добавьте поле для переноса.', field => ({
        from: fieldPath(field.from), to: id(field.to),
      }));
      demand(new Set(fields.map(field => field.to)).size === fields.length, 'Имена выходных полей должны различаться.');
      return { ...config, fields, keepOriginal: step.keepOriginal === true };
    }
    default:
      throw new InputError('Выберите поддерживаемый тип шага.');
  }
}

function validateProcessing(value, template) {
  demand(template && value.templateId === template.id, 'Выберите опубликованный шаблон запроса.');
  const preset = processingDefaults(template);
  const steps = value.steps ?? (Object.hasOwn(kinds, value.type) ? kinds[value.type].steps : preset.steps);
  demand(Array.isArray(steps), 'Шаги обработки должны быть массивом.');
  const output = columns(value.columns ?? preset.columns);
  demand(output.length > 0 && output.length <= 16_384, 'Для обработки нужна хотя бы одна колонка.');
  demand(new Set(output.map(column => column.name)).size === output.length, 'Названия колонок обработки должны различаться.');
  return { id: id(value.id), templateId: template.id, name: text(value.name, 'название обработки'),
    steps: steps.map((step, index) => {
      try { return validateStep(step); }
      catch (error) { throw new InputError(`Шаг ${index + 1}. ${error.message}`); }
    }), columns: output };
}

function processingSteps(processing) {
  if (processing.steps) return processing.steps;
  demand(Object.hasOwn(kinds, processing.type), 'Такой вид обработки не поддерживается.');
  return kinds[processing.type].steps;
}

function matchesFilter(row, step) {
  const value = get(row, step.path);
  if (step.operator === 'present') return value != null;
  if (step.operator === 'arrayNotEmpty') {
    demand(value == null || Array.isArray(value), `Поле «${step.path}» должно быть массивом.`);
    return Boolean(value?.length);
  }
  const equal = value !== undefined && stringify(value) === stringify(step.value);
  return step.operator === 'equals' ? equal : !equal;
}

function validField(row, check) {
  const value = get(row, check.path);
  switch (check.kind) {
    case 'present': return value != null;
    case 'object': return object(value);
    case 'array': return Array.isArray(value);
    case 'date': return Number.isFinite(dateMs(value));
    case 'dateInterval': return dateMs(value) <= dateMs(get(row, check.endPath));
  }
}

function* stepRows(step, row) {
  switch (step.type) {
    case 'filter':
      if (matchesFilter(row, step)) yield row;
      break;
    case 'validate':
      for (const check of step.checks) {
        const description = check.endPath ? `«${check.path}» и «${check.endPath}»` : `«${check.path}»`;
        demand(validField(row, check), `Проверка поля ${description} не пройдена.`);
      }
      yield row;
      break;
    case 'expandArray': {
      const values = get(row, step.path);
      demand(values == null || Array.isArray(values), `Поле «${step.path}» должно быть массивом.`);
      if (!values?.length && step.keepEmpty) yield { ...row, [step.as]: null };
      for (const item of values ?? []) yield { ...row, [step.as]: item };
      break;
    }
    case 'expandObjects': {
      const found = [];
      for (const variant of step.variants) {
        const value = get(row, variant.path);
        if (variant.optional && value == null) continue;
        demand(object(value), `Поле «${variant.path}» должно быть объектом.`);
        if (variant.ifPresent && get(value, variant.ifPresent) == null) continue;
        found.push({ ...row, [step.as]: value, ...(step.labelAs ? { [step.labelAs]: variant.label } : {}) });
      }
      yield* found;
      break;
    }
    case 'copy': {
      const result = step.keepOriginal ? { ...row } : {};
      for (const field of step.fields) {
        const value = get(row, field.from);
        if (value !== undefined) result[field.to] = value;
      }
      yield result;
      break;
    }
  }
}

function recordSample(stage, row) {
  stage.rows++;
  if (stage.samples.length < 3) {
    const text = stringify(row, null, 2);
    stage.samples.push(text.length > 2400 ? `${text.slice(0, 2400)}\n…` : text);
  }
}

function* applyStep(rows, step, index, stage) {
  for (const row of rows) {
    if (stage) stage.input++;
    try {
      for (const output of stepRows(step, row)) {
        if (stage) recordSample(stage, output);
        yield output;
      }
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      if (stage) stage.errors++;
      if (step.onError !== 'skip') throw new InputError(`Шаг ${index + 1}. ${error.message}`);
    }
  }
}

function processingRows(steps, record, trace) {
  return steps.reduce((rows, step, index) => applyStep(rows, step, index, trace?.[index]), [record]);
}

module.exports = { CLUSTERS_COLUMNS, CLUSTERS_PATH, FUNNEL_COLUMNS, FUNNEL_PATH, processingDefaults,
  processingRows, processingSteps, recordSample, validateProcessing };
