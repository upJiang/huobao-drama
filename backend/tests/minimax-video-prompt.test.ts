import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MiniMaxVideoAdapter } from '../src/services/adapters/minimax-video'
import {
  HARD_ADDRESS_NIUNIU,
  HARD_BLOCK_MARK,
  HARD_CLEANUP_CALM,
  HARD_NARRATION,
  HARD_NO_BGM,
  HARD_NO_BGM_FIELD,
  HARD_NO_BURNED_SUBTITLES,
  sanitizeActingAndDialogue,
} from '../src/services/adapters/minimax-video'

const adapter = new MiniMaxVideoAdapter()
const config = {
  provider: 'minimax',
  baseUrl: 'https://api.minimaxi.com',
  apiKey: 'sk-test',
  model: 'MiniMax-H3',
}

function spoken(prompt: string): string {
  const at = prompt.indexOf(HARD_BLOCK_MARK)
  return at === -1 ? prompt : prompt.slice(0, at)
}

function herQuote(prompt: string): string {
  const matched = spoken(prompt).match(/牛妹(?:（[^）]*）)?说：「([^」]*)」/)
  assert.ok(matched, `没有找到牛妹的台词：${spoken(prompt)}`)
  return matched[1]
}

test('牛妹称呼对方时改成牛牛，并禁止把对方叫成牛妹', () => {
  const prompt = sanitizeActingAndDialogue('0-3秒：@图片1牛妹说：「牛妹，你回来了。」')

  assert.equal(herQuote(prompt), '牛牛，你回来了。')
  assert.match(prompt, /禁止把对方叫成牛妹/)
  assert.equal(prompt.includes(HARD_ADDRESS_NIUNIU), true)
  assert.doesNotMatch(HARD_ADDRESS_NIUNIU, /[A-Za-z]/)
  assert.doesNotMatch(spoken(prompt), /Niumei|Niuniu|never say|do not call/i)
  assert.equal(prompt.split(HARD_ADDRESS_NIUNIU).length - 1, 1)
})

test('近音错名和英文错称都改成牛牛，英文指令不留在台词里', () => {
  const prompt = sanitizeActingAndDialogue([
    '牛妹说：「牛美，过来。」',
    '牛妹说：「Niumei, come here」',
    '牛妹说：「Never say Niumei」',
    'Do not call him Niumei.',
    'Address him as Niuniu.',
  ].join('\n'))

  const quotes = [...spoken(prompt).matchAll(/牛妹说：「([^」]*)」/g)].map((match) => match[1])
  assert.deepEqual(quotes, ['牛牛，过来。', '牛牛, come here', '牛牛'])
  assert.doesNotMatch(spoken(prompt), /Niumei|Niuniu|Never say|Do not call|Address him/i)
  assert.match(prompt, /禁止把对方叫成牛妹/)
})

test('不改牛妹的自我介绍，也不改牛牛对她的称呼', () => {
  const prompt = sanitizeActingAndDialogue([
    '牛妹说：「我是牛妹，牛妹你听好。」',
    '牛妹说：「叫我牛妹。」',
    '牛牛说：「牛妹，慢点。」',
    '牛妹转身。牛牛说：「牛妹，早上好。」',
  ].join('\n'))

  const quotes = [...spoken(prompt).matchAll(/(牛妹|牛牛)说：「([^」]*)」/g)].map((match) => `${match[1]}:${match[2]}`)
  assert.deepEqual(quotes, [
    '牛妹:我是牛妹，牛牛你听好。',
    '牛妹:叫我牛妹。',
    '牛牛:牛妹，慢点。',
    '牛牛:牛妹，早上好。',
  ])
})

test('没有牛妹的片子不注入称呼锁', () => {
  const prompt = sanitizeActingAndDialogue('0-3秒：小明说：「你好。」')

  assert.equal(prompt.includes(HARD_ADDRESS_NIUNIU), false)
  assert.match(spoken(prompt), /小明说：「你好。」/)
  assert.match(prompt, new RegExp(HARD_NO_BGM))
  assert.match(prompt, new RegExp(HARD_NO_BURNED_SUBTITLES))
  assert.match(prompt, new RegExp(HARD_NARRATION))
})

test('禁 BGM、禁烧字、旁白消毒仍然生效', () => {
  const prompt = sanitizeActingAndDialogue([
    '0-3秒：轻快的背景音乐。背景音乐：钢琴。',
    '旁白说：「夜深了。」',
    '画面底部烧录字幕：你好世界',
    '小明说：「走吧。」',
  ].join('\n'))
  const body = spoken(prompt)

  assert.match(prompt, new RegExp(HARD_NO_BGM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, new RegExp(HARD_NO_BGM_FIELD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, new RegExp(HARD_NO_BURNED_SUBTITLES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, new RegExp(HARD_NARRATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(prompt.split(HARD_NO_BGM).length - 1, 1)
  assert.doesNotMatch(body, /轻快的背景音乐|钢琴|你好世界|旁白说/)
  assert.match(body, /画外音（不出镜、不上字幕）：夜深了。/)
  assert.match(body, /小明说：「走吧。」/)
  assert.match(body, /环境声/)
})

test('收拾场面把惊讶、愣住、包落地收成平静，其他场面不动', () => {
  const cleanup = sanitizeActingAndDialogue('牛妹收拾桌子，表情惊讶，愣住，包落地。牛妹说：「牛妹，没事。」')
  assert.match(spoken(cleanup), /表情平静/)
  assert.match(spoken(cleanup), /照常动作/)
  assert.match(spoken(cleanup), /把包拿稳/)
  assert.doesNotMatch(spoken(cleanup), /惊讶|愣住|包落地/)
  assert.equal(herQuote(cleanup), '牛牛，没事。')
  assert.equal(cleanup.includes(HARD_CLEANUP_CALM), true)

  const surprise = sanitizeActingAndDialogue('牛妹表情惊讶。牛妹说：「牛妹？」')
  assert.match(spoken(surprise), /表情惊讶/)
  assert.equal(surprise.includes(HARD_CLEANUP_CALM), false)
  assert.equal(herQuote(surprise), '牛牛？')
})

test('剧本行和重复消毒都稳定', () => {
  const once = sanitizeActingAndDialogue('牛妹：（愣住）牛妹，等等。')
  assert.match(spoken(once), /牛妹：（愣住）牛牛，等等。/)
  assert.equal(sanitizeActingAndDialogue(once), once)
})

test('生成请求带上称呼锁，且不把英文称呼写进台词', () => {
  const request = adapter.buildGenerateRequest(config, {
    id: 1,
    model: 'MiniMax-H3',
    prompt: 'Niumei说：「Niumei，听我说。」',
    duration: 5,
    aspectRatio: '9:16',
  })

  const text = request.body.content[0].text as string
  assert.equal(text, sanitizeActingAndDialogue('Niumei说：「Niumei，听我说。」'))
  assert.equal(herQuote(text), '牛牛，听我说。')
  assert.match(text, /禁止把对方叫成牛妹/)
  assert.match(text, new RegExp(HARD_NO_BGM))
  assert.match(text, new RegExp(HARD_NO_BURNED_SUBTITLES))
  assert.match(text, new RegExp(HARD_NARRATION))
  assert.doesNotMatch(spoken(text), /Niumei|Niuniu/)
  assert.equal(request.body.ratio, '9:16')
})
