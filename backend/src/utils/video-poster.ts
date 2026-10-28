/**
 * 视频海报帧提取 — 供 <video poster> 使用，避免列表页为显示首帧而缓冲整个视频
 */
import path from 'path'
import { getAbsolutePath } from './storage.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** 由视频相对路径推导海报帧路径：static/videos/x.mp4 → static/videos/x_poster.jpg */
export function posterPathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_poster.jpg')
}

/** 末帧路径：static/videos/x.mp4 → static/videos/x_last.jpg，供下一镜衔接 */
export function lastFramePathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_last.jpg')
}

/**
 * 抽取视频 0.5s 处画面作为海报帧（宽 640，等比缩放，与原视频同目录）。
 * 失败返回 null，不阻断主流程。
 */
export async function extractVideoPoster(relativePath: string): Promise<string | null> {
  try {
    // ffmpeg 二进制损坏（跨平台拷贝 node_modules / 下载不完整）时静默跳过，
    // 避免 fluent-ffmpeg 延迟回调里的同步 EFTYPE 崩掉整个进程
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const posterRel = posterPathFor(relativePath)
    const posterAbs = getAbsolutePath(posterRel)
    await new Promise<void>((resolve, reject) => {
      ffmpeg(getAbsolutePath(relativePath))
        .screenshots({
          timestamps: ['0.5'],
          filename: path.basename(posterAbs),
          folder: path.dirname(posterAbs),
          size: '640x?',
        })
        .on('end', () => resolve())
        .on('error', reject)
    })
    return posterRel
  } catch (err) {
    console.warn(`[video-poster] 海报帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}

function probeDuration(input: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(input, (err, data) => {
      if (err) resolve(null)
      else resolve(Number(data?.format?.duration) || null)
    })
  })
}

/**
 * 抽取临近结尾的一帧，作为下一镜的衔接参考。
 * 宽度 1280，让人脸和服装还能被视频模型认出来。失败返回 null，不阻断成片。
 */
export async function extractVideoLastFrame(relativePath: string): Promise<string | null> {
  try {
    const { ffmpeg: ffmpegOk, ffprobe: ffprobeOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const lastRel = lastFramePathFor(relativePath)
    const lastAbs = getAbsolutePath(lastRel)
    const input = getAbsolutePath(relativePath)
    let timestamp = '95%'
    if (ffprobeOk) {
      const duration = await probeDuration(input)
      if (duration && duration > 0.3) timestamp = String(Math.max(0, duration - 0.12))
    }
    await new Promise<void>((resolve, reject) => {
      ffmpeg(input)
        .screenshots({
          timestamps: [timestamp],
          filename: path.basename(lastAbs),
          folder: path.dirname(lastAbs),
          size: '1280x?',
        })
        .on('end', () => resolve())
        .on('error', reject)
    })
    return lastRel
  } catch (err) {
    console.warn(`[video-poster] 末帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}
