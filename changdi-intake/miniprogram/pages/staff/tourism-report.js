const guideMetrics = [
  ['route_exposed', '路线推荐曝光'],
  ['route_adopted', '路线采纳'],
  ['route_completed_self_reported', '路线完成（游客自报）'],
  ['guide_played', '语音实播次数'],
  ['guide_played', '语音实播累计时长', 'durationSeconds', '秒']
];
const parkingMetrics = [
  ['parking_advice_adopted', '停车建议采纳'],
  ['parking_navigation_clicked', '停车导航点击']
];
const coverageLabel = {complete: '完整覆盖', partial: '部分覆盖'};
const unavailable = '暂无覆盖';
const row = (label, value) => ({label, value});

function fieldValue(metric, field, unit) {
  if (metric === undefined || metric?.status === 'unavailable') return unavailable;
  if (metric?.status !== 'complete' && metric?.status !== 'partial') throw new Error('Invalid tourism coverage');
  const amount = metric[field];
  const validCount = Number.isSafeInteger(amount) && amount >= 0;
  const validWideDuration = field === 'durationSeconds' && typeof amount === 'string' &&
    /^[1-9][0-9]{0,34}$/.test(amount);
  if (!validCount && !validWideDuration) throw new Error('Invalid tourism measure');
  return `${amount} ${unit}（${coverageLabel[metric.status]}）`;
}

function reportTime(value) {
  const match = typeof value === 'string' &&
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?\+08:00$/.exec(value);
  const ms = match ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) ||
      new Date(ms + 28_800_000).toISOString().slice(0, -1) !== match[1] + (match[2] || '.000')) {
    throw new Error('Invalid tourism report timestamp');
  }
  const fraction = match[2] && match[2] !== '.000' ? match[2] : '';
  return {ms, text: match[1].replace('T', ' ') + fraction};
}

function coverageNote(tourism, hasCoverage) {
  if (!hasCoverage && !tourism?.period && tourism?.asOf === undefined && tourism?.occurrenceCutoffExclusive === undefined) {
    return '所选期间暂无导览来源覆盖。';
  }
  const start = reportTime(tourism.period?.start);
  const end = reportTime(tourism.period?.endExclusive);
  const cutoff = reportTime(tourism.occurrenceCutoffExclusive);
  const asOf = reportTime(tourism.asOf);
  if (start.ms > cutoff.ms || cutoff.ms > end.ms || cutoff.ms > asOf.ms || start.ms >= end.ms) {
    throw new Error('Invalid tourism report interval');
  }
  return `以下导览指标按北京时间统计。发生区间 ${start.text} 至 ${cutoff.text}，录入截点 ${asOf.text}，两个结束时点均不含。导览截点保留毫秒，投诉指标按整秒取数。部分覆盖项只统计已覆盖范围。`;
}

function metricRows(section, definitions) {
  return definitions.map(([key, label, field = 'count', unit = '次']) =>
    row(label, fieldValue(section?.[key], field, unit)));
}

function tourismReportGroups(tourism) {
  const demo = metricRows(tourism?.demo, [
    ...guideMetrics, ['booking_demo_submitted', '预约演示提交'], ...parkingMetrics
  ]);
  const operational = metricRows(tourism?.operational, [
    ...guideMetrics,
    ['booking_requested', '预约发起'], ['booking_confirmed', '预约确认'], ['booking_cancelled', '预约取消'],
    ...parkingMetrics, ['parking_arrival_verified', '停车核验到达']
  ]);
  const booking = tourism?.operational?.bookingStatus;
  for (const [field, label] of [['requested', '待确认'], ['confirmed', '已确认'], ['cancelled', '已取消']]) {
    operational.push(row(`预约状态 · ${label}`, fieldValue(booking, field, '笔')));
  }
  const hasCoverage = [...demo, ...operational].some(item => item.value !== unavailable);
  return [
    {title: '导览行为 · 演示', rows: demo, note: coverageNote(tourism, hasCoverage)},
    {title: '导览行为 · 运营', rows: operational}
  ];
}

module.exports = { tourismReportGroups };
