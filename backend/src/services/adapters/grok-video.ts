/**
 * Grok Imagine 视频生成 Adapter（xAI / OpenAI 兼容网关）
 * 提交: POST /v1/videos/generations → { request_id }
 * 轮询: GET  /v1/videos/{request_id} → { status: pending|done|failed, video: { url, duration } }
 *
 * 支持文生视频、图生视频（image）和参考图（reference_images）。
 * 时长 1–15 秒，分辨率 480p / 720p / 1080p（非 1.5 模型的 1080p 降到 720p）。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { snapAspectRatio } from './grok-aspect'

const DEFAULT_MODEL = 'grok-imagine-video-1.5'

const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'] as const

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class GrokVideoAdapter implements VideoProviderAdapter {
  provider = 'grok'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    const imageUrl = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)

    if (refVideos.length || record.referenceFileUrl || record.referenceLinkUrl) {
      throw new Error('Grok 视频目前只支持提示词、首尾帧和参考图片，不支持参考视频或外部文件')
    }
    if (!prompt && !imageUrl && !lastFrame) {
      throw new Error('Grok 视频需要提示词，或至少一张首帧/尾帧图片')
    }
    if (!prompt && refImages.length && !imageUrl && !lastFrame) {
      throw new Error('Grok 参考图生视频需要提示词')
    }

    const body: Record<string, unknown> = {
      model,
      duration: this.normalizeDuration(record.duration),
      aspect_ratio: snapAspectRatio(record.aspectRatio, VIDEO_RATIOS, '16:9'),
      resolution: this.normalizeResolution(model, record.resolution),
      generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
    }
    if (prompt) body.prompt = prompt
    if (imageUrl) body.image = { url: imageUrl }
    if (lastFrame) body.last_frame = { url: lastFrame }
    if (refImages.length) {
      body.reference_images = refImages.slice(0, 9).map((url) => ({ url }))
    }
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    if (refAudios.length) {
      body.reference_audios = refAudios.slice(0, 3).map((url) => ({ url }))
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl && !result?.request_id) return { isAsync: false, videoUrl }
    const taskId = result?.request_id || result?.id || result?.task_id
    if (taskId) return { isAsync: true, taskId: String(taskId) }
    if (videoUrl) return { isAsync: false, videoUrl }
    const message = result?.error?.message || 'No request_id or video url in response'
    throw new Error(typeof message === 'string' ? message : 'No request_id or video url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result?.status || '').toLowerCase()
    if (status === 'done' || status === 'completed' || status === 'succeeded') {
      const videoUrl = this.extractVideoUrl(result)
      if (!videoUrl) {
        return { status: 'failed', error: result?.error?.message || '视频已完成但没有返回地址' }
      }
      const duration = Number(result?.video?.duration)
      return {
        status: 'completed',
        videoUrl,
        duration: Number.isFinite(duration) ? duration : undefined,
      }
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      const err = result?.error
      const msg = typeof err === 'string' ? err : (err?.message || '视频生成失败')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result?.video?.url || result?.video_url || result?.data?.video_url || null
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    return Math.min(15, Math.max(1, parsed))
  }

  /** grok-imagine-video（非 1.5）最高 720p */
  private normalizeResolution(model: string, resolution?: string | null): '480p' | '720p' | '1080p' {
    const value = String(resolution || '720p').trim().toLowerCase()
    let out: '480p' | '720p' | '1080p' = value === '480p' ? '480p' : value === '1080p' || value === '2k' ? '1080p' : '720p'
    const supports1080 = /video-1\.5|grok-video-1\.5/i.test(model)
    if (out === '1080p' && !supports1080) out = '720p'
    return out
  }
}
