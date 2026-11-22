// 人话理由（确定性字符串模板），与 Python src/pf/recommend.py 的 make_reasons 逐字一致。
// 每个数字来自 score_breakdown 的 raw（2.22）。

import { roundHalfUp, epochSec } from "./format.mjs";

export function ageSeconds(forecast) {
  if (!forecast.data_asof) return null;
  return epochSec(forecast.issued_at) - epochSec(forecast.data_asof);
}

export function fmtNum(x) {
  if (x === null || x === undefined) return "未知";
  const r = roundHalfUp(x);
  if (Math.abs(x - r) < 1e-9) return String(r);
  return x.toFixed(1);
}

function bdict(breakdown) {
  const d = {};
  for (const b of breakdown) d[b.factor] = b;
  return d;
}

export function makeReasons(lot, forecast, breakdown, caps) {
  const b = bdict(breakdown);
  const reasons = [];

  const af = b.arrive_free.raw;
  const fr = b.arrive_free_rate.raw;
  if (af !== null && af !== undefined) {
    const pct = roundHalfUp((fr !== null && fr !== undefined ? fr : 0.0) * 100.0);
    reasons.push(`到达时预计余位 ${Math.trunc(af)} 个（约 ${pct}% 空置率），有位可停。`);
  } else {
    reasons.push("该车场暂无可用余位预测，仅按步行距离与费用排序。");
  }

  const walkMin = Math.trunc(b.walk_cost.raw);
  const walkMeters = Math.trunc(lot.walk_to_street.meters);
  reasons.push(`停车后步行约 ${walkMin} 分钟（${walkMeters} 米）到街区入口。`);

  const totalTime = b.total_time.raw;
  const drive = Math.trunc(caps.drive_minutes_estimate);
  const park = Math.trunc(caps.park_minutes);
  reasons.push(`预计总时间约 ${Math.trunc(totalTime)} 分钟（驾车估算 ${drive} 分钟 + 步行 ${walkMin} 分钟 + 停车 ${park} 分钟）。`);

  const feeAmount = b.fee_cost.raw;
  if (feeAmount !== null && feeAmount !== undefined) {
    const feeMode = lot.fee.mode;
    if (feeMode === "hourly") {
      reasons.push(`费用 ${fmtNum(lot.fee.amount)} 元/小时，按 ${Math.trunc(caps.stay_hours)} 小时停留估算 ${roundHalfUp(feeAmount)} 元。`);
    } else {
      reasons.push(`停车费约 ${roundHalfUp(feeAmount)} 元。`);
    }
  } else {
    reasons.push("费用未知，建议以现场公示为准。");
  }

  const age = ageSeconds(forecast);
  const conf = b.confidence.raw;
  const level = conf >= 0.8 ? "较高" : (conf >= 0.5 ? "中等" : "较低");
  if (age !== null && age > 900) {
    reasons.push(`余位数据已过期（${Math.floor(age / 60)} 分钟前），以现场为准。`);
  } else if (age !== null) {
    reasons.push(`余位数据更新于 ${Math.floor(age / 60)} 分钟前，预测可信度${level}。`);
  } else {
    reasons.push(`余位数据更新时间未知，预测可信度${level}。`);
  }

  if (lot.notes) reasons.push(`注意：${lot.notes}`);
  const access = lot.access || {};
  if (access.one_way) {
    if (access.note) reasons.push(`注意：${access.note}`);
  }

  return reasons;
}
