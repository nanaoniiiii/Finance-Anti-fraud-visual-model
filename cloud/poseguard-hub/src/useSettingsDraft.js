import { useCallback, useEffect, useReducer } from 'react';
import { createSettingsDraft, settingsDraftDirty, settingsDraftReducer } from './settings-draft.js';

export default function useSettingsDraft(source) {
  const [state, dispatch] = useReducer(settingsDraftReducer, source, createSettingsDraft);
  const signature = JSON.stringify(source);
  useEffect(() => {
    dispatch({ type: 'sync', value: JSON.parse(signature) });
  }, [signature]);
  const setValue = useCallback(update => dispatch({ type: 'edit', update }), []);
  const saved = useCallback((value, submitted) => {
    dispatch({ type: 'saved', value, submitted });
  }, []);
  return [state.value, setValue, saved, settingsDraftDirty(state)];
}
