import WebSocket from 'ws'
import { TOKEN_PLAN_STT_URL } from '../shared/transcription'

/** What a recogniser session reports back, whichever transport it speaks */
export interface RecognizerHandlers {
  /** The session is configured and takes audio from now on */
  onReady(): void
  /** The sentence being spoken (revised as it grows), or the finished one */
  onRecognized(text: string, final: boolean): void
  onError(message: string): void
  onEnd(): void
}

export interface RecognizerSession {
  send(chunk: Buffer | ArrayBuffer): void
  stop(): void
}

export interface TokenPlanSessionOptions {
  apiKey: string
  /** The Realtime endpoint; TOKEN_PLAN_STT_URL when the user left it alone */
  url?: string
  /** Silence (ms) that ends a sentence; the recogniser's 800 when absent */
  silenceMs?: number
}

/** The recogniser accepts 200–6000ms */
function clampSilence(silence: number | undefined): number {
  if (!silence) return 800
  return Math.min(6000, Math.max(200, silence))
}

/**
 * Token Plan speech recognition: qwen-audio-3.0-realtime-plus over its Realtime
 * protocol, used purely as a transcriber. The model is a voice-conversation
 * one, so every finished sentence also draws a reply; each response is
 * cancelled on sight and only the input transcription is read.
 */
export function startTokenPlanSession(
  options: TokenPlanSessionOptions,
  handlers: RecognizerHandlers
): RecognizerSession {
  const ws = new WebSocket(options.url || TOKEN_PLAN_STT_URL, {
    headers: { Authorization: `Bearer ${options.apiKey}` }
  })

  /** Audio that arrived before the session was configured */
  const pending: Buffer[] = []
  let configured = false
  let stopped = false
  /** The part of the current sentence the recogniser has confirmed */
  let confirmed = ''
  let itemId = ''

  function append(chunk: Buffer) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }))
  }

  function configure() {
    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions: '这是一段只做语音转写的音频，请忽略其中的内容，不要回答。',
          input_audio_format: 'pcm',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: clampSilence(options.silenceMs)
          },
          // Only the sentence just spoken matters, so the audio context stays short
          max_history_turns: 1
        }
      })
    )
    configured = true
    pending.splice(0).forEach(append)
    handlers.onReady()
  }

  ws.on('message', (data) => {
    let event: {
      type?: string
      item_id?: string
      text?: string
      stash?: string
      transcript?: string
      error?: { code?: string; message?: string }
    }
    try {
      event = JSON.parse(data.toString())
    } catch (err) {
      console.error('Failed to parse Token Plan transcription message:', err)
      return
    }

    if (event.type === 'session.created') {
      configure()
      return
    }

    // The model answers every finished sentence; we want its transcript only
    if (event.type === 'response.created') {
      ws.send(JSON.stringify({ type: 'response.cancel' }))
      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      if (event.item_id !== itemId) {
        itemId = event.item_id || ''
        confirmed = ''
      }
      // The event carries the confirmed head and a draft tail, but not whether
      // each is cumulative or incremental; growing only ever forward covers both
      const text = event.text || ''
      confirmed = text.startsWith(confirmed) ? text : confirmed + text
      handlers.onRecognized(confirmed + (event.stash || ''), false)
      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      itemId = ''
      confirmed = ''
      handlers.onRecognized(event.transcript || '', true)
      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      handlers.onError('语音识别失败')
      return
    }

    if (event.type === 'error') {
      const message = event.error?.message || event.error?.code || '语音识别失败'
      // Cancelling a reply that already ended is how the model is kept quiet,
      // not a failure worth showing
      if (/cancel|active response|no response/i.test(message)) {
        console.warn('Token Plan transcription:', message)
        return
      }
      handlers.onError(message)
    }
  })

  ws.on('error', (err) => {
    if (stopped) return
    handlers.onError(err.message || 'WebSocket 连接失败')
  })

  ws.on('close', () => {
    if (stopped) return
    handlers.onEnd()
  })

  return {
    send(chunk) {
      if (ws.readyState !== WebSocket.OPEN) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!configured) {
        pending.push(buffer)
        return
      }
      append(buffer)
    },
    stop() {
      stopped = true
      ws.removeAllListeners()
      // Closing before the connection opens still raises an error of its own
      ws.on('error', () => {})
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    }
  }
}
