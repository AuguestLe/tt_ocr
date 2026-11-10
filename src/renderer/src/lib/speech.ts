import { useSettingsStore } from './store/settings'
import {
  hasSpeechKey,
  TOKEN_PLAN_STT_URL,
  type StartTranscriptionConfig
} from '../../../shared/transcription'

export { hasSpeechKey }

/** What main needs to start recognition, or what the user must fill in first */
export function resolveSpeechConfig():
  | { config: StartTranscriptionConfig; missing?: undefined }
  | { config?: undefined; missing: string } {
  const state = useSettingsStore.getState()

  if (state.sttProvider === 'token-plan') {
    const apiKey = state.tokenPlanSttKey.trim()
    if (!apiKey) {
      return { missing: '请先在「设置 → 语音」填写 Token Plan API Key（sk-sp- 开头）' }
    }
    return {
      config: {
        provider: 'token-plan',
        apiKey,
        url: state.tokenPlanSttURL.trim() || TOKEN_PLAN_STT_URL
      }
    }
  }

  const apiKey = state.dashscopeApiKey.trim()
  if (!apiKey) {
    return { missing: '请先在「设置 → 语音」填写百炼平台 API Key' }
  }
  return { config: { provider: 'dashscope', apiKey } }
}
