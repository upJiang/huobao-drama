import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GrsaiImageAdapter } from '../src/services/adapters/grsai-image'
import { GrsaiVideoAdapter } from '../src/services/adapters/grsai-video'
import {
  buildMinimaxTimelinePrompt,
  collectGrsaiImages,
  pickPreviousLastFrame,
} from '../src/services/adapters/grsai-prompt'
import { readGrsaiEnv } from '../src/services/grsai-env'

const config = {
  provider: 'grsai',
  baseUrl: 'https://grsaiapi.com',
  apiKey: 'sk-test',
  model: '',
}

test('Grsai video request uses minimax-h3 generate contract', () => {
  const adapter = new GrsaiVideoAdapter()
  const request = adapter.buildGenerateRequest(config, {
    id: 1,
    model: 'minimax-h3',
    prompt: '@图片1小明 走进雨里\n@图片2小红 还在门口',
    aspectRatio: '9:16',
    resolution: '720p',
    duration: 12,
    firstFrameUrl: 'https://cdn.example/last.jpg',
    referenceImageUrls: JSON.stringify([
      'https://cdn.example/hero.png',
      'https://cdn.example/last.jpg',
      'https://cdn.example/room.png',
    ]),
    referenceAudioUrls: JSON.stringify([
      'https://cdn.example/a.mp3',
      'https://cdn.example/b.mp3',
      'https://cdn.example/c.mp3',
      'https://cdn.example/d.mp3',
    ]),
    seed: 7,
  })

  assert.equal(request.url, 'https://grsaiapi.com/v1/api/generate')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer sk-test')
  assert.equal(request.body.model, 'minimax-h3')
  assert.equal(request.body.aspectRatio, 'portrait')
  assert.equal(request.body.resolution, '768p')
  assert.equal(request.body.duration, 12)
  assert.equal(request.body.replyType, 'async')
  assert.equal(request.body.promptSkill, false)
  assert.equal(request.body.seed, 7)
  assert.deepEqual(request.body.images, [
    'https://cdn.example/last.jpg',
    'https://cdn.example/hero.png',
    'https://cdn.example/room.png',
  ])
  assert.equal(request.body.audios.length, 3)
  assert.match(request.body.prompt, /视频时长：12秒/)
  assert.match(request.body.prompt, /0-\d+秒：/)
  assert.match(request.body.prompt, /无故消失/)
  assert.match(request.body.prompt, /上一镜末帧/)
  assert.doesNotMatch(request.body.prompt, /@图片/)
  assert.equal(JSON.stringify(request.body).includes('sk-'), false)
})

test('Grsai 1080p duration is capped at 10 seconds and landscape stays landscape', () => {
  const adapter = new GrsaiVideoAdapter()
  const request = adapter.buildGenerateRequest({ ...config, model: 'minimax-h3' }, {
    id: 2,
    prompt: '0-3秒：推门\n3-12秒：对视',
    aspectRatio: '16:9',
    resolution: '1080p',
    duration: 12,
  })
  assert.equal(request.body.aspectRatio, 'landscape')
  assert.equal(request.body.resolution, '1080p')
  assert.equal(request.body.duration, 10)
  assert.match(request.body.prompt, /视频时长：10秒/)
  assert.match(request.body.prompt, /可见钩子/)
})

test('Grsai video parses async, success, and violation payloads', () => {
  const adapter = new GrsaiVideoAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'task-1', status: 'running' }), {
    isAsync: true,
    taskId: 'task-1',
    videoUrl: undefined,
  })
  assert.deepEqual(adapter.parseGenerateResponse({
    data: { id: 'task-2', status: 'succeeded', results: [{ url: 'https://cdn.example/out.mp4' }] },
  }), {
    isAsync: false,
    taskId: undefined,
    videoUrl: 'https://cdn.example/out.mp4',
  })
  assert.throws(() => adapter.parseGenerateResponse({ id: 'task-3', status: 'violation', error: 'blocked' }), /blocked/)

  const poll = adapter.buildPollRequest(config, 'task-1')
  assert.equal(poll.method, 'GET')
  assert.equal(poll.url, 'https://grsaiapi.com/v1/api/result?id=task-1')
  assert.deepEqual(adapter.parsePollResponse({
    status: 'succeeded',
    results: [{ url: 'https://cdn.example/out.mp4' }],
  }), {
    status: 'completed',
    videoUrl: 'https://cdn.example/out.mp4',
    error: undefined,
  })
  assert.equal(adapter.parsePollResponse({ status: 'running', progress: 40 }).status, 'processing')
  assert.equal(adapter.parsePollResponse({ status: 'failed', error: 'generate failed' }).status, 'failed')
})

test('Grsai image request uses gpt-image-2.5 and reference images', () => {
  const adapter = new GrsaiImageAdapter()
  const request = adapter.buildGenerateRequest(config, {
    id: 3,
    prompt: '角色定妆，正面',
    size: '1080x1920',
    referenceImages: JSON.stringify(['https://cdn.example/ref.png', '']),
  })
  assert.equal(request.url, 'https://grsaiapi.com/v1/api/generate')
  assert.equal(request.body.model, 'gpt-image-2.5')
  assert.equal(request.body.aspectRatio, '9:16')
  assert.equal(request.body.replyType, 'async')
  assert.equal(request.body.quality, 'auto')
  assert.deepEqual(request.body.images, ['https://cdn.example/ref.png'])
  assert.equal(adapter.parsePollResponse({
    id: 'img-1',
    status: 'succeeded',
    results: [{ url: 'https://cdn.example/pic.png' }],
  }).imageUrl, 'https://cdn.example/pic.png')
})

test('timeline prompt is idempotent and reference order keeps the continuity frame first', () => {
  const once = buildMinimaxTimelinePrompt({
    prompt: '出场人物：小明。\n0-3秒：回头\n3-6秒：站住',
    duration: 6,
    portrait: true,
    hasContinuityFrame: true,
  })
  const twice = buildMinimaxTimelinePrompt({
    prompt: once,
    duration: 8,
    portrait: true,
    hasContinuityFrame: true,
  })
  assert.equal(twice.split('连贯约束').length, 2)
  assert.match(twice, /视频时长：8秒/)
  assert.deepEqual(collectGrsaiImages({
    firstFrame: 'last',
    references: ['hero', 'last', 'room'],
    lastFrame: 'end',
  }), ['last', 'hero', 'room', 'end'])
})

test('previous-shot last frame skips deleted shots and later shots', () => {
  const frame = pickPreviousLastFrame([
    { id: 1, number: 1, lastFrame: 'static/videos/a_last.jpg' },
    { id: 2, number: 2, lastFrame: 'static/videos/b_last.jpg', deleted: true },
    { id: 3, number: 3, lastFrame: null },
    { id: 4, number: 4, lastFrame: 'static/videos/d_last.jpg' },
  ], 3)
  assert.equal(frame, 'static/videos/a_last.jpg')
})

test('Grsai env reader ignores a Grok-only environment', () => {
  const previous = {
    GRSAI_API_KEY: process.env.GRSAI_API_KEY,
    GRSAI_BASE_URL: process.env.GRSAI_BASE_URL,
    GRSAI_IMAGE_MODEL: process.env.GRSAI_IMAGE_MODEL,
    GRSAI_VIDEO_MODEL: process.env.GRSAI_VIDEO_MODEL,
    GROK_API_KEY: process.env.GROK_API_KEY,
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    process.env.GROK_API_KEY = 'grok-secret'
    delete process.env.GRSAI_API_KEY
    delete process.env.GRSAI_BASE_URL
    assert.equal(readGrsaiEnv(), null)

    process.env.GRSAI_API_KEY = 'grsai-secret'
    process.env.GRSAI_BASE_URL = 'https://grsai.dakka.com.cn/'
    delete process.env.GRSAI_IMAGE_MODEL
    delete process.env.GRSAI_VIDEO_MODEL
    assert.deepEqual(readGrsaiEnv(), {
      apiKey: 'grsai-secret',
      baseUrl: 'https://grsai.dakka.com.cn',
      imageModel: 'gpt-image-2.5',
      videoModel: 'minimax-h3',
    })
  } finally {
    restore()
  }
})
