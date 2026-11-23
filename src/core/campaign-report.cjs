const { get, integer, isLosslessNumber, parseJson, pathParts } = require('./json.cjs');
const { dateMs, demand, initialPosition, requestFor } = require('./model.cjs');

const unknownBrand = 'Бренд не определён';
const mixedBrands = 'Несколько брендов';
const metrics = [
  ['views', 'Просмотры'], ['clicks', 'Клики'], ['atbs', 'Добавления в корзину'], ['orders', 'Заказы'],
  ['canceled', 'Отмены'], ['sum', 'Расходы'], ['sum_price', 'Сумма заказов'],
];
const campaignColumns = [
  { path: 'campaignReport.articles', name: 'Артикул WB' }, { path: 'campaignReport.brand', name: 'Бренд' },
];
const summaryHeaders = ['Бренд', 'Начало периода', 'Конец периода', ...metrics.map(([, name]) => name)];
const roles = [
  ['statistic', 'GET', '/adv/v3/fullstats', ''],
  ['adverts', 'GET', '/api/advert/v3/adverts', 'adverts'],
  ['products', 'POST', '/api/analytics/v3/sales-funnel/products', 'data.products'],
];

function matches(template, [, method, path, rows]) {
  return template?.method === method && template.path === path && pathParts(template.response.rows).join('.') === rows;
}

function dateFields(template) {
  return ['beginDate', 'endDate'].map(key => ({ name: key,
    path: template.parameters.find(parameter => parameter.where === 'query' && parameter.key === key)?.name }));
}

function campaignRecipe(templates) {
  const matched = roles.map(role => templates.find(template => matches(template, role)));
  if (matched.some(template => !template)) return null;
  const statistic = matched[0];
  const periods = dateFields(statistic);
  if (periods.some(period => !period.path)) return null;
  const sources = roles.map(([alias], index) => ({ alias, templateId: matched[index].id,
    ...(alias === 'statistic' ? { allRows: true, requestFields: periods } : {}) }));
  const readColumns = fields => fields.length ? fields : [{ path: '$', name: 'Запись' }];
  const main = readColumns(statistic.response.columns).filter(column => !campaignColumns.some(extra => extra.name === column.name));
  const steps = [
    { type: 'copy', input: 'products', output: 'productBrands', fields: [
      { from: 'product.nmId', to: 'nmId' }, { from: 'product.brandName', to: 'brand', trim: true },
    ] },
    { type: 'filter', input: 'productBrands', output: 'knownBrands', path: 'brand', operator: 'notBlank' },
    { type: 'expandArray', input: 'adverts', output: 'campaignItems', path: 'nms', as: 'item' },
    { type: 'copy', input: 'campaignItems', output: 'campaignItemIds', fields: [
      { from: 'advertId', to: 'advertId' }, { from: 'item.nmId', to: 'nmId' },
    ] },
    { type: 'validate', input: 'campaignItemIds', output: 'knownItems', onError: 'skip', checks: [{ path: 'nmId', kind: 'present' }] },
    { type: 'join', input: 'knownItems', output: 'itemsWithBrands', right: 'knownBrands', as: 'product', matches: 'unique',
      keys: [{ left: 'nmId', right: 'nmId', type: 'integer' }] },
    { type: 'join', input: 'statistic', output: 'campaignMatches', right: 'itemsWithBrands', as: 'items', matches: 'list',
      keys: [{ left: 'advertId', right: 'advertId', type: 'integer' }] },
    { type: 'collect', input: 'campaignMatches', output: 'campaignArticles', path: 'items', value: 'nmId', as: 'articles' },
    { type: 'collect', input: 'campaignArticles', output: 'campaignBrands', path: 'items', value: 'product.brand', as: 'brand',
      separator: ' / ', missing: unknownBrand },
    { type: 'validate', input: 'campaignBrands', output: 'datedCampaigns', checks: [{ path: 'advertId', kind: 'present' },
      { path: 'request.beginDate', kind: 'dateInterval', endPath: 'request.endDate' }] },
    { type: 'distinct', input: 'datedCampaigns', output: 'uniqueCampaigns', keys: [{ path: 'advertId', type: 'integer' },
      { path: 'request.beginDate' }, { path: 'request.endDate' }] },
    { type: 'allocate', input: 'uniqueCampaigns', output: 'brandMetrics', items: 'items', label: 'product.brand', itemKey: 'nmId',
      details: 'days.apps.nms', detailKey: 'nmId', as: 'allocated', multiple: 'reconcile', unknown: unknownBrand, mixed: mixedBrands,
      metrics: metrics.map(([key]) => ({ total: key, detail: key, name: key })) },
    { type: 'group', input: 'brandMetrics', output: 'summary', uniform: 'currency', keys: [
      { path: 'request.beginDate', name: 'begin' }, { path: 'request.endDate', name: 'end' }, { path: 'allocated.group', name: 'brand' },
    ], metrics: metrics.map(([key]) => ({ path: `allocated.${key}`, name: key, op: 'sum' })) },
  ];
  const sheets = [
    { name: statistic.name, input: 'campaignBrands', expand: statistic.response.expand, columns: [...main,
      { path: 'articles', name: 'Артикул WB' }, { path: 'brand', name: 'Бренд' }] },
    ...statistic.response.tables.map(table => ({ name: table.name, input: 'statistic', expand: table.path, separate: true, columns: readColumns(table.columns) })),
    { name: 'Свод РК', input: 'summary', columns: ['brand', 'begin', 'end', ...metrics.map(([key]) => key)]
      .map((path, index) => ({ path, name: summaryHeaders[index] })) },
  ];
  return { scope: 'workbook', name: 'Свод РК', sources, steps, sheets };
}

function validPeriod(begin, end) {
  return dateMs(begin) <= dateMs(end);
}

function planCampaignReport(sources) {
  const entries = sources.filter(source => !source.isDependency);
  const indices = Object.fromEntries(roles.map(role => [role[0], sources.findIndex(source =>
    !source.isDependency && matches(source.template, role))]));
  demand(entries.length === 3 && Object.values(indices).every(index => index >= 0),
    'Для «Свода РК» добавьте три шаблона: fullstats с путём $, adverts с путём adverts и воронку с путём data.products.');
  const statistic = sources[indices.statistic];
  const products = sources[indices.products];
  demand(!statistic.processing, 'У источника fullstats выберите «Без обработки», чтобы сохранить листы шаблона.');

  const [{ path: beginDate }, { path: endDate }] = dateFields(statistic.template);
  demand(beginDate && endDate && validPeriod(statistic.values[beginDate], statistic.values[endDate]),
    'Укажите начало и конец периода в источнике fullstats.');
  const { body } = requestFor(products, products.values, initialPosition(products.template.pagination));
  const period = get(parseJson(body ?? 'null'), 'selectedPeriod');
  demand(validPeriod(period?.start, period?.end), 'Укажите начало и конец selectedPeriod в источнике воронки.');

  const response = statistic.template.response;
  statistic.template.response = { ...response, deduplicateBy: undefined,
    requestFields: { ...response.requestFields, beginDate, endDate } };
  return indices;
}

function wbId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : integer(value);
  return id !== null && id > 0n ? id.toString() : '';
}

function arrayAt(row, path) {
  const values = get(row, path);
  demand(values == null || Array.isArray(values), `В ответе поле «${path}» должно быть массивом.`);
  return values ?? [];
}

async function campaignLookups(adverts, products) {
  const articles = new Map();
  for await (const row of adverts) {
    const id = wbId(row.advertId);
    if (!id) continue;
    const items = articles.get(id) ?? new Set();
    for (const product of arrayAt(row, 'nms')) {
      const article = wbId(product?.nmId);
      if (article) items.add(article);
    }
    articles.set(id, items);
  }
  const brands = new Map();
  for await (const row of products) {
    const article = wbId(get(row, 'product.nmId'));
    const value = get(row, 'product.brandName');
    if (!article || typeof value !== 'string' || !value.trim()) continue;
    const brand = value.trim();
    brands.set(article, !brands.has(article) || brands.get(article) === brand ? brand : null);
  }
  return { articles, brands };
}

function brandOf(lookups, article) {
  return lookups.brands.get(article) ?? unknownBrand;
}

async function* campaignRows(records, lookups) {
  for await (const row of records) {
    const articles = [...(lookups.articles.get(wbId(row.advertId)) ?? [])];
    const brands = new Set(articles.map(article => brandOf(lookups, article)));
    yield { ...row, campaignReport: { articles: articles.join(', '), brand: [...brands].join(' / ') || unknownBrand } };
  }
}

function metricValues(row) {
  return metrics.map(([path]) => {
    const value = get(row, path);
    if (value == null) return 0;
    const numeric = isLosslessNumber(value) ? Number(value.value) : value;
    demand(Number.isFinite(numeric), `Показатель «${path}» должен быть числом.`);
    return numeric;
  });
}

function addMetrics(totals, values) {
  for (const [index, value] of values.entries()) totals[index] += value;
}

function metricsByBrand(row, lookups) {
  const totals = metricValues(row);
  const articles = lookups.articles.get(wbId(row.advertId));
  const brands = new Set(Array.from(articles ?? [], article => brandOf(lookups, article)));
  if (brands.size <= 1) return [[brands.values().next().value ?? unknownBrand, totals]];
  const byBrand = new Map();
  const represented = metrics.map(() => 0);
  for (const day of arrayAt(row, 'days')) {
    for (const app of arrayAt(day, 'apps')) {
      for (const item of arrayAt(app, 'nms')) {
        const article = wbId(item?.nmId);
        const brand = articles?.has(article) ? brandOf(lookups, article) : unknownBrand;
        const values = metricValues(item);
        if (!byBrand.has(brand)) byBrand.set(brand, metrics.map(() => 0));
        addMetrics(byBrand.get(brand), values);
        addMetrics(represented, values);
      }
    }
  }
  const reconciled = totals.every((total, index) => Math.abs(total - represented[index]) <=
    1e-7 + 32 * Number.EPSILON * Math.abs(total));
  if (byBrand.size && reconciled) return byBrand;
  const distinctBrands = [...brands].filter(brand => brand !== unknownBrand).length;
  return [[distinctBrands > 1 ? mixedBrands : unknownBrand, totals]];
}

async function* campaignSummaryRows(records, lookups) {
  const groups = new Map();
  const seen = new Set();
  let currency;
  for await (const row of records) {
    const id = wbId(row.advertId);
    const begin = get(row, 'request.beginDate');
    const end = get(row, 'request.endDate');
    demand(id && validPeriod(begin, end), 'В строке fullstats отсутствует ID кампании или фактический период запроса.');
    if (row.currency) {
      demand(!currency || currency === row.currency, 'Для «Свода РК» суммы должны быть в одной валюте.');
      currency = row.currency;
    }
    const campaign = JSON.stringify([id, begin, end]);
    if (seen.has(campaign)) continue;
    seen.add(campaign);
    for (const [brand, values] of metricsByBrand(row, lookups)) {
      const key = JSON.stringify([brand, begin, end]);
      if (!groups.has(key)) groups.set(key, { brand, begin, end, totals: metrics.map(() => 0) });
      addMetrics(groups.get(key).totals, values);
    }
  }
  const sorted = [...groups.values()].sort((first, second) => first.begin.localeCompare(second.begin) ||
    first.end.localeCompare(second.end) || first.brand.localeCompare(second.brand, 'ru'));
  for (const { brand, begin, end, totals } of sorted) yield [brand, begin, end, ...totals];
}

module.exports = { campaignColumns, campaignLookups, campaignRecipe, campaignRows, campaignSummaryRows, planCampaignReport, summaryHeaders };
