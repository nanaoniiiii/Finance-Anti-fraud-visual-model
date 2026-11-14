const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createSettingsDraft(value) {
  return { baseline: value, value };
}

// Merge saved values only into fields the user has not changed. The same rule
// preserves input typed while a save request was in flight.
export function settingsDraftReducer(state, action) {
  if (action.type === 'edit') {
    const value = typeof action.update === 'function'
      ? action.update(state.value) : action.update;
    return { ...state, value };
  }
  if (action.type === 'sync' && same(state.baseline, action.value)) return state;
  const baseline = action.type === 'saved' ? action.submitted : state.baseline;
  const value = Object.fromEntries(Object.entries(action.value).map(([key, next]) => [
    key, same(state.value[key], baseline[key]) ? next : state.value[key],
  ]));
  return { baseline: action.value, value };
}

export function settingsDraftDirty(state) {
  return !same(state.value, state.baseline);
}

export function mailDraft(mail) {
  return {
    provider: mail.provider || 'smtp',
    from: mail.from || '',
    host: mail.host || '',
    port: mail.port ?? 465,
    security: mail.security || (mail.port === 587 ? 'starttls' : 'tls'),
    auth: mail.auth || 'auto',
    username: mail.username || '',
    enabled: !!mail.enabled,
    password: '',
    recipientText: (mail.recipients || []).join('\n'),
  };
}
