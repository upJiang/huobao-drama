/**
 * Grsai 视频 Adapter — MiniMax H3
 * POST /v1/api/generate  { model: minimax-h3, replyType: async, ... }
 * GET  /v1/api/result?id=
 *
 * 与官方 MiniMax /v2/video_generation 不是同一套协议，配置 provider=grsai。
 * promptSkill 固定 false：时间轴和「角色不得无故消失」由本适配器写入，不再交给网关改写。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import {
  buildMinimaxTimelinePrompt,
  collectGrsaiAudios,
  collectGrsaiImages,
  grsaiVideoAspect,
  grsaiVideoDuration,
  grsaiVideoResolution,
} from './grsai-prompt'
import { grsaiBearerHeaders, grsaiGenerateUrl, grsaiResultUrl, parseGrsaiGenerate, parseGrsaiPoll } from './grsai-http'

const DEFAULT_MODEL = 'minimax-h3'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((url) => typeof url === 'string' && url.trim()) : []
  } catch {
    return []
  }
}

export class GrsaiVideoAdapter implements VideoProviderAdapter {
  provider = 'grsai'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = (record.model || config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL
    const resolution = grsaiVideoResolution(record.resolution)
    const duration = grsaiVideoDuration(record.duration, resolution)
    const aspectRatio = grsaiVideoAspect(record.aspectRatio)
    const images = collectGrsaiImages({
      firstFrame: record.firstFrameUrl || record.imageUrl,
      lastFrame: record.lastFrameUrl,
      references: parseUrlArray(record.referenceImageUrls),
    })
    const audios = collectGrsaiAudios(parseUrlArray(record.referenceAudioUrls))
    const promptSource = (record.prompt || '').trim()
    if (!promptSource && !images.length) {
      throw new Error('Grsai MiniMax H3 需要提示词，或至少一张参考图')
    }

    const body: Record<string, unknown> = {
      model,
      prompt: buildMinimaxTimelinePrompt({
        prompt: promptSource,
        duration,
        portrait: aspectRatio === 'portrait',
        hasContinuityFrame: Boolean((record.firstFrameUrl || record.imageUrl || '').trim()),
      }),
      aspectRatio,
      resolution,
      duration,
      replyType: 'async',
      // 提示词已经是时间轴；打开网关优化会改掉连贯约束。
      promptSkill: false,
    }
    if (images.length) body.images = images
    if (audios.length) body.audios = audios
    if (record.seed != null && Number.isFinite(Number(record.seed))) body.seed = Math.round(Number(record.seed))

    return {
      url: grsaiGenerateUrl(config.baseUrl),
      method: 'POST',
      headers: grsaiBearerHeaders(config.apiKey),
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const parsed = parseGrsaiGenerate(result)
    return { isAsync: parsed.isAsync, taskId: parsed.taskId, videoUrl: parsed.mediaUrl }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: grsaiResultUrl(config.baseUrl, taskId),
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const parsed = parseGrsaiPoll(result)
    return { status: parsed.status, videoUrl: parsed.mediaUrl, error: parsed.error }
  }

  extractVideoUrl(result: any): string | null {
    return parseGrsaiPoll(result).mediaUrl || null
  }
}
