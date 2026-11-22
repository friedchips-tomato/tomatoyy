const noSample = '无适用样本';

function beijingMonth(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 7);
}

function validReportMonth(month, currentMonth) {
  return typeof month === 'string' && month.length === 7 &&
    /^[1-9][0-9]{3}-(?:0[1-9]|1[0-2])$/.test(month) && month < '9999-01' && month <= currentMonth;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid report count');
  return String(value);
}

function metric(value, unit = '', digits = 2, multiplier = 1) {
  if (value === null) return noSample;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid report measure');
  return Number((value * multiplier).toFixed(digits)) + unit;
}

function time(value) {
  if (typeof value !== 'string' || value.length !== 25 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid report timestamp');
  }
  return value.slice(0, 19).replace('T', ' ');
}

const row = (label, value) => ({ label, value });

function reportView(result, requestedMonth) {
  if (result.month !== requestedMonth || result.timeZone !== 'Asia/Shanghai' ||
      !['final', 'provisional'].includes(result.monthEnd.state) ||
      !['available', 'insufficient'].includes(result.monthEnd.deadlineData)) {
    throw new Error('Invalid report response');
  }
  const { firstResponse, completion, monthEnd, reopen, evaluation } = result;
  return {
    asOf: time(result.asOf),
    start: time(result.period.start),
    endExclusive: time(result.period.endExclusive),
    snapshot: time(monthEnd.cutoff),
    snapshotLabel: monthEnd.state === 'final' ? '月末快照' : '截至当前',
    deadlineWarning: monthEnd.deadlineData === 'insufficient'
      ? '有 ' + count(monthEnd.missingDeadlineEvidence) + ' 宗未完成工单缺少历史期限，超时数据不足。' : '',
    groups: [
      { title: '首次有效响应', rows: [
        row('当月首次提交', count(firstResponse.submitted)),
        row('已响应样本', count(firstResponse.responded)),
        row('待响应', count(firstResponse.pending)),
        row('中位数', metric(firstResponse.medianMinutes, ' 分钟')),
        row('1 小时内（含）', count(firstResponse.distribution.atMostOneHour)),
        row('超过 1 至 24 小时（含）', count(firstResponse.distribution.upTo24Hours)),
        row('超过 24 小时', count(firstResponse.distribution.over24Hours))
      ] },
      { title: '当月受理完成情况', rows: [
        row('受理样本', count(completion.accepted)), row('截至取数已完成', count(completion.completed)),
        row('完成率', metric(completion.rate, '%', 1, 100))
      ] },
      { title: monthEnd.state === 'final' ? '月末未完成与超时' : '截至当前未完成与超时', rows: [
        row('未完成', count(monthEnd.unfinished)), row('超时', count(monthEnd.overdue)),
        row('无历史期限', count(monthEnd.withoutDeadline))
      ] },
      { title: '补办', rows: [
        row('申请', count(reopen.applications)), row('审核通过', count(reopen.approved)),
        row('审核驳回', count(reopen.rejected)), row('新开轮次', count(reopen.newRounds))
      ] },
      { title: '评价覆盖', rows: [
        row('已发布轮次', count(evaluation.publishedRounds)), row('有效评价', count(evaluation.validEvaluations)),
        row('未评价轮次', count(evaluation.unevaluatedRounds)), row('覆盖率', metric(evaluation.coverage, '%', 1, 100))
      ] }
    ],
    ratings: [['speed', '处理速度'], ['effectiveness', '处理效果'], ['attitude', '服务态度']].map(([id, label]) => {
      const { mean, distribution } = evaluation.dimensions[id];
      return { label, mean: metric(mean, ' 分'), bins: [1, 2, 3, 4, 5].map(score => ({ score, count: count(distribution[score]) })) };
    }),
    duplicateMissing: result.duplicateComplaints?.status === 'unavailable',
    tourismMissing: result.tourism?.status === 'unavailable'
  };
}

module.exports = { beijingMonth, validReportMonth, reportView };
