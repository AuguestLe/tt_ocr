import { useEffect, useState } from 'react'
import { Mic } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/lib/store/settings'
import { TOKEN_PLAN_STT_URL, type SpeechProvider } from '../../../../shared/transcription'
import { Advanced, Field, SecretInput, SettingsCard } from '../components'

/** Speech recognition, shared by both modes: 截图模式 attaches it, 对话模式 is built on it */
export function VoiceSection() {
  const {
    dashscopeApiKey,
    sttProvider,
    tokenPlanSttKey,
    tokenPlanSttURL,
    audioInputDeviceId,
    audioOutputDeviceId,
    updateSetting
  } = useSettingsStore()
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setAudioDevices(devices)
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err)
      }
    }
    loadDevices()
  }, [])

  return (
    <SettingsCard Icon={Mic} title="语音">
      <div className="space-y-4">
        <Field
          label="语音识别方案"
          note="百炼按量按音频时长计费，约 1.2 元/小时；Token Plan 从套餐 Credits 里扣，用实时语音模型转写，本应用只取它听出的文字"
        >
          <Select
            value={sttProvider}
            onValueChange={(value) => updateSetting('sttProvider', value as SpeechProvider)}
          >
            <SelectTrigger className="w-60 shrink-0 bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dashscope">百炼按量（fun-asr-realtime）</SelectItem>
              <SelectItem value="token-plan">Token Plan（实时语音模型）</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {sttProvider === 'token-plan' ? (
          <>
            <Field
              label="Token Plan API Key"
              note={
                <>
                  以 sk-sp- 开头，在百炼控制台「我的订阅」获取；该套餐官方限定供编程 / Agent
                  工具交互使用，应用内调用能否正常抵扣以你的账号为准
                </>
              }
            >
              <SecretInput
                value={tokenPlanSttKey}
                onChange={(value) => updateSetting('tokenPlanSttKey', value)}
                placeholder="sk-sp-…"
              />
            </Field>

            <Advanced>
              <Field
                label="识别地址"
                note="Token Plan 的实时语音接口与文本接口（compatible-mode）不同，模型名写在地址的查询参数里"
              >
                <Input
                  value={tokenPlanSttURL}
                  onChange={(e) => updateSetting('tokenPlanSttURL', e.target.value)}
                  placeholder={TOKEN_PLAN_STT_URL}
                  className="bg-white"
                />
              </Field>
            </Advanced>
          </>
        ) : (
          <Field
            label="百炼平台 API Key"
            note={
              <>
                从阿里云
                <a
                  href="https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-0.5 text-blue-700 hover:underline"
                >
                  百炼平台
                </a>
                获取；对话模式必填，截图模式不用语音转录可跳过
              </>
            }
          >
            <SecretInput
              value={dashscopeApiKey}
              onChange={(value) => updateSetting('dashscopeApiKey', value)}
              placeholder="输入百炼平台 API Key"
            />
          </Field>
        )}

        <Field
          label="对方音源"
          note="默认捕获系统音频，即会议里对方的声音；也可以选虚拟声卡等输入设备。截图模式的语音转录也用它。自己的麦克风在「设置 → 对话模式」单独选"
        >
          <Select
            value={audioInputDeviceId || 'system'}
            onValueChange={(val) =>
              updateSetting('audioInputDeviceId', val === 'system' ? '' : val)
            }
          >
            <SelectTrigger className="w-60 shrink-0 bg-white">
              <SelectValue placeholder="系统音频（默认）" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">系统音频（默认）</SelectItem>
              {audioDevices
                .filter((d) => d.kind === 'audioinput' && d.deviceId)
                .map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </SelectItem>
                ))}
              {audioInputDeviceId &&
                !audioDevices.some((d) => d.deviceId === audioInputDeviceId) && (
                  <SelectItem value={audioInputDeviceId}>{audioInputDeviceId}（已保存）</SelectItem>
                )}
            </SelectContent>
          </Select>
        </Field>

        <Advanced defaultOpen={!!audioOutputDeviceId}>
          <Field label="音频输出设备" note="识别时不播放声音，这一项不影响识别">
            <Select
              value={audioOutputDeviceId || 'default'}
              onValueChange={(val) =>
                updateSetting('audioOutputDeviceId', val === 'default' ? '' : val)
              }
            >
              <SelectTrigger className="w-60 shrink-0 bg-white">
                <SelectValue placeholder="默认设备" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认设备</SelectItem>
                {audioDevices
                  .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
                  .map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label || d.deviceId}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
        </Advanced>
      </div>
    </SettingsCard>
  )
}
