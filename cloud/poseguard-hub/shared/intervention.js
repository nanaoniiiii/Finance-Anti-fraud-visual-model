export function defaultInterventionNote(event) {
  if (event.risk_kind === 'phone_to_ear')
    return '疑似手机电诈（检测到通话姿态，需现场核查），请工作人员到场协助核查并反馈处置情况。';
  if (event.risk_kind === 'multi_person')
    return '疑似多人进入，请工作人员到场核查人员情况并协助处置。';
  return '检测到长时间停留，请工作人员到场了解情况并反馈处置结果。';
}
export function interventionBasics(event) {
  const risk =
    {
      phone_to_ear: '疑似通话姿态 / 疑似手机电诈待核查',
      multi_person: '疑似多人进入',
      lingering: '长时间停留',
    }[event.risk_kind] || '待核查风险';
  return `设备：${event.device_name || event.device_id}\n位置：${event.location || '未设置'}\n风险情况：${risk}\n风险等级：${['候选', '关注', '高风险', '紧急介入'][event.severity] || '待核查'}\n累计帧数：${event.observed_frames}\n说明：`;
}
