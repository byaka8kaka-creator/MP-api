const { demand } = require('./model.cjs');

const DEFER_MS = 10 * 60_000;

function validateSchedule(value) {
  if (value === null || value === undefined) return null;
  demand(value && Array.isArray(value.days) && value.days.length > 0 &&
    value.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6), 'Выберите дни недели для расписания.');
  demand(typeof value.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time), 'Укажите время расписания.');
  return { days: [...new Set(value.days)].sort(), time: value.time };
}

function latestSlot(schedule, now) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const local = new Date(now);
  for (let previous = 0; previous <= 7; previous++) {
    const day = new Date(local.getFullYear(), local.getMonth(), local.getDate() - previous, 12);
    if (!schedule.days.includes(day.getDay())) continue;
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).valueOf();
    if (candidate <= now) return candidate;
  }
  return null;
}

function scheduleDecision(job, active, now) {
  if (!job.value.schedule) return null;
  const slot = latestSlot(job.value.schedule, now);
  let cursor = job.schedule_cursor;
  let pendingAt = job.pending_at;
  let pendingSlot = job.pending_slot;
  if (slot !== null && slot > cursor) {
    cursor = slot;
    pendingSlot = slot;
    pendingAt ??= active ? now + DEFER_MS : now;
  }
  if (pendingAt !== null && pendingAt <= now) {
    if (active) return { cursor, pendingAt: now + DEFER_MS, pendingSlot, start: false };
    return { cursor, pendingAt: null, pendingSlot: null, scheduledFor: pendingSlot, start: true };
  }
  if (cursor !== job.schedule_cursor || pendingAt !== job.pending_at || pendingSlot !== job.pending_slot) {
    return { cursor, pendingAt, pendingSlot, start: false };
  }
  return null;
}

module.exports = { DEFER_MS, latestSlot, scheduleDecision, validateSchedule };
