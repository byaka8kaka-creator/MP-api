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

function validPeriod(begin, end) {
  return dateMs(begin) <= dateMs(end);
}

function planCampaignReport(sources) {
  const entries = sources.filter(source => !source.isDependency);
  const roles = [
    ['statistic', 'GET', '/adv/v3/fullstats', ''],
    ['adverts', 'GET', '/api/advert/v3/adverts', 'adverts'],
    ['products', 'POST', '/api/analytics/v3/sales-funnel/products', 'data.products'],
  ];
  const indices = Object.fromEntries(roles.map(([role, method, path, rows]) => [role, sources.findIndex(source =>
    !source.isDependency && source.template.method === method && source.template.path === path &&
    pathParts(source.template.response.rows).join('.') === rows)]));
  demand(entries.length === 3 && Object.values(indices).every(index => index >= 0),
    'Для «Свода РК» добавьте три шаблона: fullstats с путём $, adverts с путём adverts и воронку с путём data.products.');
  const statistic = sources[indices.statistic];
  const products = sources[indices.products];
  demand(!statistic.processing, 'У источника fullstats выберите «Без обработки», чтобы сохранить листы шаблона.');

  const dateParameter = key => statistic.template.parameters.find(parameter => parameter.where === 'query' && parameter.key === key)?.name;
  const beginDate = dateParameter('beginDate');
  const endDate = dateParameter('endDate');
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

module.exports = { campaignColumns, campaignLookups, campaignRows, campaignSummaryRows, planCampaignReport, summaryHeaders };
