const { get, object } = require('./json.cjs');
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

function* funnelRows(record) {
  const article = get(record, 'product.nmId');
  const statistic = get(record, 'statistic');
  demand(article !== undefined && article !== null && object(statistic),
    'В карточке воронки отсутствует артикул WB или статистика.');
  for (const [key, periodType] of [['selected', 'Текущий'], ['past', 'Предыдущий']]) {
    const metrics = get(statistic, key);
    if (key === 'past' && metrics == null) continue;
    demand(object(metrics), 'Ответ Wildberries содержит неверную структуру статистики периода.');
    const period = get(metrics, 'period');
    if (key === 'past' && period == null) continue;
    const start = dateMs(get(period, 'start'));
    const end = dateMs(get(period, 'end'));
    demand(Number.isFinite(start) && Number.isFinite(end) && start <= end,
      key === 'selected' ? 'В карточке указан неверный текущий период.' : 'В карточке указан неверный предыдущий период.');
    yield { product: record.product, periodType, statistic: metrics };
  }
}

function* clusterRows(record) {
  const dailyStats = get(record, 'dailyStats');
  if (dailyStats == null) return;
  demand(Array.isArray(dailyStats), 'Поле dailyStats должно быть массивом.');
  if (dailyStats.length === 0) return;
  const { advertId, nmId } = record;
  demand(advertId != null && nmId != null, 'В записи статистики отсутствует advertId или nmId.');
  for (const day of dailyStats) {
    demand(object(day) && Number.isFinite(dateMs(day.date)) && object(day.stat),
      'Элемент dailyStats должен содержать дату и объект stat.');
    yield { advertId, nmId, date: day.date, stat: day.stat };
  }
}

const kinds = {
  [FUNNEL_TYPE]: {
    path: FUNNEL_PATH, rows: 'data.products', transform: funnelRows,
    name: 'Воронка WB по периодам',
    description: 'Для каждой карточки создаёт строку текущего периода и строку предыдущего периода, если он есть.',
    columns: FUNNEL_COLUMNS,
  },
  [CLUSTERS_TYPE]: {
    path: CLUSTERS_PATH, rows: 'items', transform: clusterRows,
    name: 'Поисковые кластеры WB по дням',
    description: 'Для каждого элемента dailyStats создаёт строку с ID кампании, артикулом, датой и показателями stat.',
    columns: CLUSTERS_COLUMNS,
  },
};

const processingDefaults = Object.fromEntries(Object.entries(kinds).map(([type, spec]) => [
  type, { name: spec.name, description: spec.description, columns: spec.columns },
]));

function processingType(template) {
  return Object.keys(kinds).find(type => template?.path === kinds[type].path && template.response?.rows === kinds[type].rows) ?? null;
}

function validateProcessing(value, template) {
  const type = processingType(template);
  demand(type && value.templateId === template.id, 'Выберите опубликованный шаблон воронки или статистики кластеров Wildberries.');
  demand(value.type === undefined || value.type === type, 'Текущий шаблон запроса несовместим с сохранённой обработкой.');
  const output = columns(value.columns ?? kinds[type].columns);
  demand(output.length > 0 && output.length <= 16_384, 'Для обработки нужна хотя бы одна колонка.');
  demand(new Set(output.map(column => column.name)).size === output.length, 'Названия колонок обработки должны различаться.');
  return { id: id(value.id), templateId: template.id, type,
    name: text(value.name, 'название обработки'), columns: output };
}

function* processingRows(processing, record) {
  demand(Object.hasOwn(kinds, processing.type), 'Такой вид обработки не поддерживается.');
  yield* kinds[processing.type].transform(record);
}

module.exports = { CLUSTERS_COLUMNS, CLUSTERS_PATH, FUNNEL_COLUMNS, FUNNEL_PATH, processingDefaults,
  processingRows, processingType, validateProcessing };
