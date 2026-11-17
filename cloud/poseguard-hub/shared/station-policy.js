const modalities = {
  speech: {
    speech_code_handoff: [62, '口头索要或汇报验证码/密码'],
    speech_safe_account: [68, '要求转入所谓安全账户'],
    speech_remote_control: [36, '引导开启屏幕共享或远程控制'],
    speech_authority_pressure: [36, '冒充机构伴随威胁或保密要求'],
    speech_call_indicator: [4, '通话提示语'],
  },
  vision: {
    vision_phone: [30, '通话姿态'],
    vision_multi_person: [18, '多人同时出现'],
    vision_lingering: [14, '异常停留'],
  },
  transaction: {
    transaction_unfamiliar_payee: [36, '网点系统报告陌生收款方'],
    transaction_repeated_transfer: [28, '网点系统报告短时重复转账'],
  },
};

export const stationEvidence = Object.freeze(Object.fromEntries(
  Object.entries(modalities).flatMap(([modality, codes]) => Object.entries(codes).map(
    ([code, [weight, label]]) => [code, Object.freeze({ modality, weight, label })],
  )),
));

export const stationWindowMs = 90_000;

export function combineStationSignals(samples) {
  const strongest = new Map();
  for (const sample of samples) {
    if (!Object.hasOwn(stationEvidence, sample.code) || !Number.isFinite(sample.confidence) ||
        sample.confidence < .42 || sample.confidence > 1) continue;
    strongest.set(sample.code, Math.max(sample.confidence, strongest.get(sample.code) || 0));
  }
  const evidence = Array.from(strongest).map(([code, confidence]) => ({
    code, confidence, modality: stationEvidence[code].modality,
  })).sort((a, b) => a.code.localeCompare(b.code));
  const substantive = evidence.filter(({ code }) => code !== 'speech_call_indicator');
  const sources = new Set(substantive.map(({ modality }) => modality));
  const base = substantive.reduce((sum, row) =>
    sum + stationEvidence[row.code].weight * (.7 + .3 * row.confidence), 0);
  const score = Math.min(100, Math.round(base + (sources.size >= 2 ? 9 : 0)));
  const level = score >= 80 ? 3 : score >= 55 ? 2 : score >= 25 ? 1 : 0;
  return { score, level, evidence, modalities: [...sources].sort() };
}

export function displayRisk(kind) {
  return kind === 'fraud_risk' ? '疑似诈骗综合风险' : undefined;
}
