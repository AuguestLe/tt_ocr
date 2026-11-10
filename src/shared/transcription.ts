/** Speech recognition source: 百炼's pay-as-you-go ASR, or a Token Plan Realtime model */
export type SpeechProvider = 'dashscope' | 'token-plan'

/**
 * Token Plan's Realtime endpoint, the model riding in the query. Speech does
 * not go through `compatible-mode/v1` (that is the text side of the plan).
 */
export const TOKEN_PLAN_STT_URL =
  'wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus'

export interface StartTranscriptionConfig {
  provider: SpeechProvider
  /** `sk-` for 百炼按量, `sk-sp-` for Token Plan */
  apiKey: string
  /** Token Plan only: the endpoint above, when the user has changed it */
  url?: string
}

/** The settings fields that decide whether recognition can start */
export interface SpeechKeySettings {
  sttProvider: SpeechProvider
  dashscopeApiKey: string
  tokenPlanSttKey: string
}

/** Whether the chosen provider has a key to run with */
export function hasSpeechKey(state: SpeechKeySettings): boolean {
  return state.sttProvider === 'token-plan'
    ? state.tokenPlanSttKey.trim() !== ''
    : state.dashscopeApiKey.trim() !== ''
}
