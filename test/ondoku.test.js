'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compare, normalizeWord } = require('../ondoku/lib/compare');
const { parseAdvice, askGemini } = require('../ondoku/lib/gemini');
const { createServer, validateAdvice } = require('../ondoku/server');

test('照合：全部合っていれば100点', () => {
  const r = compare('Hello, everyone. My name is Ken.', 'hello everyone my name is ken');
  assert.strictEqual(r.score, 100);
  assert.ok(r.words.every((w) => w.status === 'ok'));
  assert.strictEqual(r.words[0].word, 'Hello,');
});

test('照合：おしい・ちがう・ぬけ・余分を見分ける', () => {
  const r = compare('I think three of them are thirsty', 'I sink three them are very hungry');
  const st = Object.fromEntries(r.words.map((w) => [w.word, w.status]));
  assert.strictEqual(st.think, 'close');
  assert.strictEqual(st.of, 'missing');
  assert.strictEqual(st.thirsty, 'wrong');
  assert.deepStrictEqual(r.extra, ['very']);
  assert.ok(r.score < 100 && r.score > 0);
});

test('照合：短縮形・数字・記号の違いは同じとみなす', () => {
  assert.strictEqual(compare("I don't have 3 dogs.", 'I do not have three dogs').score, 100);
  assert.strictEqual(compare("It's fine", "it’s fine").score, 100);
  assert.strictEqual(normalizeWord('"Ken!"'), 'ken');
});

test('照合：何も聞き取れなければ0点・全部ぬけ', () => {
  const r = compare('Nice to meet you', '');
  assert.strictEqual(r.score, 0);
  assert.ok(r.words.every((w) => w.status === 'missing'));
});

test('AIの返事：形を整え、範囲外の値をおさえる', () => {
  const a = parseAdvice('```json\n{"score": 140, "summary": "よい", "words": [{"word":"think","issue":"sink","tip":"舌を歯ではさむ"}]}\n```');
  assert.strictEqual(a.score, 100);
  assert.strictEqual(a.words[0].word, 'think');
  assert.strictEqual(a.good, '');
  assert.throws(() => parseAdvice('ごめんなさい'));
});

test('AI呼び出し：録音と英文を送り、鍵があれば付ける', async () => {
  let sent;
  const fakeFetch = async (url, init) => {
    sent = { url, init };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"score":80,"summary":"OK","words":[]}' }] } }] }) };
  };
  const a = await askGemini({ text: 'Hi', audio: 'AAAA', mimeType: 'audio/webm' }, { fetch: fakeFetch, apiKey: 'k', model: 'm1' });
  assert.strictEqual(a.score, 80);
  assert.match(sent.url, /models\/m1:generateContent$/);
  assert.strictEqual(sent.init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(sent.init.body);
  assert.strictEqual(body.contents[0].parts[1].inline_data.mime_type, 'audio/webm');
  assert.match(body.contents[0].parts[0].text, /Hi/);

  const bad = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(askGemini({ text: 'Hi', audio: 'AAAA', mimeType: 'audio/webm' }, { fetch: bad }), { status: 502 });
});

test('入力チェック', () => {
  assert.strictEqual(typeof validateAdvice({ text: '', audio: 'AA==', mimeType: 'audio/webm' }), 'string');
  assert.strictEqual(typeof validateAdvice({ text: 'x'.repeat(1001), audio: 'AA==', mimeType: 'audio/webm' }), 'string');
  assert.strictEqual(typeof validateAdvice({ text: 'Hi', audio: 'AA==', mimeType: 'video/mp4' }), 'string');
  assert.strictEqual(typeof validateAdvice({ text: 'Hi', audio: '<script>', mimeType: 'audio/webm' }), 'string');
  assert.deepStrictEqual(validateAdvice({ text: ' Hi ', audio: 'AA==', mimeType: 'audio/webm;codecs=opus' }),
    { text: 'Hi', audio: 'AA==', mimeType: 'audio/webm' });
});

test('サーバー：画面・見本文・助言・不正な要求', async (t) => {
  const server = createServer({ askGemini: async (v) => ({ score: 90, summary: v.text, words: [], good: '', next: '' }) });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /音読チェック/);
  assert.match(await (await fetch(base + '/compare.js')).text(), /OndokuCompare/);
  const list = await (await fetch(base + '/api/passages')).json();
  assert.ok(list.length >= 3 && list[0].text);

  const ok = await fetch(base + '/api/advice', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', audio: 'AAAA', mimeType: 'audio/webm' }),
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).summary, 'Hello');

  const ng = await fetch(base + '/api/advice', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }),
  });
  assert.strictEqual(ng.status, 400);
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
  assert.strictEqual((await fetch(base + '/%2e%2e/server.js')).status, 404);
});

test('サーバー：合言葉と回数制限', async (t) => {
  const server = createServer({ accessCode: 'さくら', limitPerHour: 2, askGemini: async () => ({ score: 1, summary: '', words: [], good: '', next: '' }) });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepStrictEqual(await (await fetch(base + '/api/config')).json(), { needCode: true });
  const post = (code) => fetch(base + '/api/advice', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-access-code': encodeURIComponent(code) },
    body: JSON.stringify({ text: 'Hi', audio: 'AAAA', mimeType: 'audio/webm' }),
  });
  assert.strictEqual((await post('ちがう')).status, 401);
  assert.strictEqual((await post('さくら')).status, 200);
  assert.strictEqual((await post('さくら')).status, 200);
  assert.strictEqual((await post('さくら')).status, 429);
});
