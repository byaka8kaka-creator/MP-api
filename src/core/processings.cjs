const { get, object } = require('./json.cjs');
const { columns, dateMs, demand, id, text } = require('./model.cjs');

const FUNNEL_PATH = '/api/analytics/v3/sales-funnel/products';
const FUNNEL_TYPE = 'wb-funnel-periods';
const FUNNEL_NAME = 'Воронка WB по периодам';

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

function isFunnel(template) {
  return template?.path === FUNNEL_PATH && template.response.rows === 'data.products';
}

function validateProcessing(value, template) {
  demand(isFunnel(template) && value.templateId === template.id, 'Выберите опубликованный шаблон воронки Wildberries с массивом data.products.');
  const output = columns(value.columns ?? FUNNEL_COLUMNS);
  demand(output.length > 0 && output.length <= 16_384, 'Для обработки нужна хотя бы одна колонка.');
  demand(new Set(output.map(column => column.name)).size === output.length, 'Названия колонок обработки должны различаться.');
  return { id: id(value.id), templateId: template.id, type: FUNNEL_TYPE,
    name: text(value.name, 'название обработки'), columns: output };
}

function* processingRows(processing, record) {
  demand(processing.type === FUNNEL_TYPE, 'Такой вид обработки не поддерживается.');
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

module.exports = { FUNNEL_COLUMNS, FUNNEL_NAME, FUNNEL_PATH, isFunnel, processingRows, validateProcessing };
