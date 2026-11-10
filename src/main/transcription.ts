import { ipcMain } from 'electron'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { AudioSource } from '../shared/conversation'
import {
  TOKEN_PLAN_STT_URL,
  type SpeechProvider,
  type StartTranscriptionConfig
} from '../shared/transcription'
import { startTokenPlanSession, type RecognizerSession } from './transcription-tokenplan'

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
export type TranscriptionPurpose = 'screenshot' | 'conversation'
export interface TranscriptionOptions {
  /** Screenshot text or conversation sentences, without changing the other's text. */
  purpose?: TranscriptionPurpose
  /** Silence (ms) that ends a sentence; the recogniser's default (1300ms) when absent */
  maxSentenceSilence?: number
  sources?: AudioSource[]
}

/** A failure from `ws` / Node (`code` like `ENOTFOUND`), or a `task-failed` event's code and message */
type AsrFailure = Error & { code?: string }

/** What one source's recogniser reports, whichever provider it belongs to */
interface RecognizerHandlers {
  /** It takes audio from now on; what was held for it can go */
  onReady(): void
  onSentence(text: string, final: boolean): void
  onFailure(error: AsrFailure | string): void
  /** The recogniser finished the task itself: the answer a stop waits for */
  onFinished(): void
  /** The connection closed on its own */
  onClosed(): void
}

/** One source's connection to a recogniser */
interface Recognizer {
  write(chunk: Buffer): void
  /** Ask it to finish; the stop path resolves on `onFinished`, or its timeout */
  finish(): void
  /** Stop listening to it and close for good */
  detach(): void
}

interface Session {
  source: AudioSource
  provider: SpeechProvider
  started: boolean
  buffered: Buffer[]
  resolveStart: () => void
  rejectStart: (error: Error) => void
  resolveStop?: () => void
  recognizer: Recognizer
}
const sessions = new Map<AudioSource, Session>()
let purpose: TranscriptionPurpose = 'screenshot'
let stopping = false
let lifecycle = 0
let stopPromise: Promise<void> | undefined
let accumulatedText = ''
let currentPartial = ''
const sentenceListeners = new Set<(text: string, final: boolean, source: AudioSource) => void>()
const startListeners = new Set<(purpose: TranscriptionPurpose) => void>()
const errorListeners = new Set<(message: string) => void>()
const endListeners = new Set<() => void>()
/** Recognition started, for screenshot text or conversation sentences. */
export function onTranscriptionStart(listener: (purpose: TranscriptionPurpose) => void): void {
  startListeners.add(listener)
}
/** Recognition failed; it is reported stopped right after. */
export function onTranscriptionError(listener: (message: string) => void): void {
  errorListeners.add(listener)
}
export function onConversationSentence(
  listener: (text: string, final: boolean, source: AudioSource) => void
): void {
  sentenceListeners.add(listener)
}
export function onTranscriptionEnd(listener: () => void): void {
  endListeners.add(listener)
}
export function isTranscriptionRunning(wanted: TranscriptionPurpose): boolean {
  return sessions.size > 0 && purpose === wanted
}
function send(channel: string, ...args: unknown[]) {
  const window = global.mainWindow
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
}
function cleanup() {
  for (const session of sessions.values()) {
    session.rejectStart(new Error('语音识别已停止'))
    session.resolveStop?.()
    session.recognizer.detach()
  }
  sessions.clear()
}
function reportStopped() {
  send('transcription-stopped')
  endListeners.forEach((listener) => listener())
}

const NETWORK_CODES =
  /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$|CERT|SSL|TLS/

/**
 * A failure in words the user can act on, with the recogniser's own code (or
 * HTTP status) in brackets for anyone searching it. `shared` failures (the key,
 * the account, the network) hit every source alike, so they name none; the
 * others start with 语音识别, which `fail()` may prefix with the source
 */
function describeFailure(
  error: AsrFailure,
  provider: SpeechProvider
): { message: string; shared: boolean } {
  const platform = provider === 'token-plan' ? 'Token Plan' : '百炼平台'
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1]
  const code = error.code ?? (status ? `HTTP ${status}` : undefined)
  const said = `${error.code ?? ''} ${error.message}`
  const detail = `（${code ?? error.message}）`
  if (status === '401' || /InvalidApiKey|Invalid API-?key/i.test(said))
    return {
      message: `${platform} API Key 无效，请到「设置 → 语音」重新填写${detail}`,
      shared: true
    }
  if (status === '403' || /Arrearage|AccessDenied|good standing/i.test(said))
    return {
      message:
        provider === 'token-plan'
          ? `Token Plan 拒绝了语音识别，请到百炼控制台确认套餐有效、Credits 没有用尽${detail}`
          : `百炼平台拒绝了语音识别，请到百炼控制台确认账户没有欠费、能使用 Fun-ASR 实时语音识别${detail}`,
      shared: true
    }
  if (status === '429' || /Throttling/i.test(said))
    return { message: `${platform}的语音识别请求太频繁，请稍后再开始监听${detail}`, shared: true }
  if (error.code === 'ETIMEDOUT')
    return { message: `连接${platform}超时，请检查网络${detail}`, shared: true }
  if (error.code && NETWORK_CODES.test(error.code))
    return { message: `连不上${platform}，请检查网络${detail}`, shared: true }
  if (status) return { message: `${platform}语音识别连接失败${detail}`, shared: true }
  return {
    message: `语音识别失败：${error.message}${error.code ? `（${error.code}）` : ''}`,
    shared: false
  }
}

/**
 * `error` is a recogniser / connection failure to describe, or a message of
 * ours (starting with 语音识别) as it is
 */
function fail(session: Session, error: AsrFailure | string) {
  if (sessions.get(session.source) !== session) return
  const { message: text, shared } =
    typeof error === 'string'
      ? { message: error, shared: false }
      : describeFailure(error, session.provider)
  // Name the source only when two are running; 截图模式 and single-source listening have one
  const message =
    sessions.size > 1 && !shared
      ? `${session.source === 'microphone' ? '麦克风' : '对方音源'}的${text}`
      : text
  // The same words for a start still waiting on it (the page shows that one)
  session.rejectStart(new Error(message))
  if (stopping) {
    session.resolveStop?.()
    return
  }
  send('transcription-error', message)
  errorListeners.forEach((listener) => listener(message))
  cleanup()
  reportStopped()
}

/**
 * 百炼's pay-as-you-go real-time ASR (fun-asr-realtime): the audio streams up
 * and the recogniser cuts sentences itself
 */
function openDashScopeRecognizer(
  apiKey: string,
  silence: number | undefined,
  handlers: RecognizerHandlers
): Recognizer {
  const socket = new WebSocket(WS_URL, { headers: { Authorization: `bearer ${apiKey}` } })
  const taskId = randomUUID()
  let ready = false

  socket.on('open', () => {
    socket.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: 'fun-asr-realtime',
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            ...(silence
              ? {
                  max_sentence_silence: Math.min(
                    // The recogniser accepts 200–6000ms
                    6000,
                    Math.max(200, silence)
                  )
                }
              : {})
          },
          input: {}
        }
      })
    )
  })
  socket.on('message', (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(data.toString())
      const event = message.header?.event
      if (event === 'task-started') {
        ready = true
        handlers.onReady()
      } else if (event === 'result-generated') {
        const sentence = message.payload?.output?.sentence
        if (!sentence) return
        handlers.onSentence(sentence.text || '', sentence.sentence_end === true)
      } else if (event === 'task-failed')
        handlers.onFailure(
          Object.assign(new Error(message.header?.error_message || '未知错误'), {
            code: message.header?.error_code || undefined
          })
        )
      else if (event === 'task-finished') handlers.onFinished()
    } catch (error) {
      console.error('Failed to parse transcription message:', error)
    }
  })
  socket.on('error', (error) => handlers.onFailure(error))
  socket.on('close', () => handlers.onClosed())

  return {
    write(chunk) {
      if (ready && socket.readyState === WebSocket.OPEN) socket.send(chunk)
    },
    finish() {
      if (ready && socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} }
          })
        )
    },
    detach() {
      socket.removeAllListeners()
      // ws emits an asynchronous error when close() cancels a pending handshake.
      // This session is detached: consume shutdown errors without affecting a new start.
      socket.on('error', () => undefined)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close()
    }
  }
}

/**
 * Token Plan's Realtime voice model (qwen-audio-3.0-realtime-plus) used as a
 * transcriber: see `transcription-tokenplan.ts` for how its replies are kept out
 */
function openTokenPlanRecognizer(
  config: StartTranscriptionConfig,
  silence: number | undefined,
  handlers: RecognizerHandlers
): Recognizer {
  const session: RecognizerSession = startTokenPlanSession(
    { apiKey: config.apiKey, url: config.url || TOKEN_PLAN_STT_URL, silenceMs: silence },
    {
      onReady: handlers.onReady,
      onRecognized: handlers.onSentence,
      onError: handlers.onFailure,
      onEnd: handlers.onClosed
    }
  )
  return {
    write: (chunk) => session.send(chunk),
    finish() {
      session.stop()
      handlers.onFinished()
    },
    detach: () => session.stop()
  }
}

async function startTranscription(
  config: StartTranscriptionConfig,
  options: TranscriptionOptions = {}
) {
  stopping = false
  purpose = options.purpose ?? 'screenshot'
  const sources: AudioSource[] =
    purpose === 'conversation'
      ? [...new Set<AudioSource>(options.sources ?? ['system'])]
      : ['system']
  if (!sources.length || sources.some((source) => source !== 'system' && source !== 'microphone'))
    throw new Error('无效的录音来源')
  const owned = new Set<Session>()
  try {
    await Promise.all(
      sources.map(
        (source) =>
          new Promise<void>((resolve, reject) => {
            // Looked up by source rather than closed over: the session is built
            // with the handlers themselves, and nothing may fire before it exists
            const current = () => sessions.get(source)
            const timeout = setTimeout(() => {
              const session = current()
              if (session) fail(session, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
            }, 8000)
            const handlers: RecognizerHandlers = {
              onReady: () => {
                const session = current()
                if (!session) return
                session.started = true
                session.buffered.forEach((chunk) => session.recognizer.write(chunk))
                session.buffered = []
                session.resolveStart()
              },
              onSentence: (text, final) => {
                if (purpose === 'conversation')
                  sentenceListeners.forEach((listener) => listener(text, final, source))
                else {
                  if (final) {
                    accumulatedText += text
                    currentPartial = ''
                  } else currentPartial = text
                  send('transcription-text', { text: getTranscriptionText(), isPartial: !final })
                }
              },
              onFailure: (error) => {
                const session = current()
                if (session) fail(session, error)
              },
              onFinished: () => {
                const session = current()
                if (!session) return
                if (stopping) session.resolveStop?.()
                else fail(session, '语音识别连接已结束，请重新开始监听')
              },
              onClosed: () => {
                const session = current()
                if (!session) return
                if (stopping) session.resolveStop?.()
                else fail(session, '语音识别连接中断，请重新开始监听')
              }
            }
            const session: Session = {
              source,
              provider: config.provider,
              started: false,
              buffered: [],
              resolveStart: () => {
                clearTimeout(timeout)
                resolve()
              },
              rejectStart: (error) => {
                clearTimeout(timeout)
                reject(error)
              },
              recognizer:
                config.provider === 'token-plan'
                  ? openTokenPlanRecognizer(config, options.maxSentenceSilence, handlers)
                  : openDashScopeRecognizer(config.apiKey, options.maxSentenceSilence, handlers)
            }
            owned.add(session)
            sessions.set(source, session)
          })
      )
    )
    startListeners.forEach((listener) => listener(purpose))
  } catch (error) {
    if ([...owned].some((session) => sessions.get(session.source) === session)) {
      cleanup()
      reportStopped()
    }
    throw error
  }
}
function stopTranscription(): Promise<void> {
  if (stopPromise) return stopPromise
  if (!sessions.size) return Promise.resolve()
  stopPromise = (async () => {
    stopping = true
    await Promise.all(
      [...sessions.values()].map(
        (session) =>
          new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 700)
            session.resolveStop = () => {
              clearTimeout(timeout)
              resolve()
            }
            if (session.started) session.recognizer.finish()
            else session.resolveStop()
          })
      )
    )
    cleanup()
    stopping = false
    reportStopped()
  })().finally(() => {
    stopPromise = undefined
  })
  return stopPromise
}
async function requestStart(
  config: StartTranscriptionConfig,
  options?: TranscriptionOptions
): Promise<void> {
  const request = ++lifecycle
  await stopTranscription()
  if (request !== lifecycle) throw new Error('录音启动已取消')
  await startTranscription(config, options)
  if (request !== lifecycle) throw new Error('录音启动已取消')
}
function requestStop(): Promise<void> {
  lifecycle++
  return stopTranscription()
}

function handleAudioChunk(chunk: ArrayBuffer, source: AudioSource = 'system') {
  if (stopping) return
  const session = sessions.get(source)
  if (!session) return
  const buffer = Buffer.from(chunk)
  if (session.started) session.recognizer.write(buffer)
  else {
    session.buffered.push(buffer)
    if (session.buffered.length > 16) session.buffered.shift()
  }
}
export function getTranscriptionText(): string {
  return accumulatedText + currentPartial
}
export function clearTranscriptionText() {
  accumulatedText = ''
  currentPartial = ''
}
ipcMain.handle(
  'start-transcription',
  (_event, config: StartTranscriptionConfig, options?: TranscriptionOptions) =>
    requestStart(config, options)
)
ipcMain.handle('stop-transcription', () => requestStop())
ipcMain.on('transcription-audio-chunk', (_event, chunk: ArrayBuffer, source?: AudioSource) =>
  handleAudioChunk(chunk, source)
)
ipcMain.handle('get-transcription-text', () => getTranscriptionText())
ipcMain.handle('clear-transcription-text', () => clearTranscriptionText())
