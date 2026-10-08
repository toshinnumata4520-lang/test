'use strict';
// 録音を Gemini に送り、発音の助言を日本語でもらう。

const DEFAULT_MODEL = 'gemini-flash-latest';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

function buildPrompt(text) {
  return [
    'あなたは日本の中高生に英語の発音を教える先生です。',
    '添付の音声は、生徒が次の英文を音読したものです。',
    '---',
    text,
    '---',
    '音声をよく聞き、見本の英文と比べて発音を評価してください。',
    '・英文にない内容を聞き取れたことにしない。聞き取れない語は「聞き取れない」と書く。',
    '・日本人がつまずきやすい音（th / r と l / v と b / f と h / 語末の子音に母音を足す / アクセントの位置）に特に注意する。',
    '・助言は短く、具体的に、やさしい日本語で。カタカナ読みの例を使ってよい。',
    '・音声が無音や雑音だけなら score を 0 にして summary でそう伝える。',
    '次の形の JSON だけを返す：',
    '{"score": 0〜100の整数, "summary": "全体の講評（2文以内）",',
    ' "words": [{"word": "英文中の単語", "issue": "どう聞こえたか", "tip": "直し方"}],',
    ' "good": "よくできた点（1文）", "next": "次に練習すること（1文）"}',
    'words は直したほうがよい単語だけ、多くても6個。',
  ].join('\n');
}

function parseAdvice(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const obj = JSON.parse(s);
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const score = Math.max(0, Math.min(100, Math.round(Number(obj.score) || 0)));
  const words = (Array.isArray(obj.words) ? obj.words : []).slice(0, 6).map((w) => ({
    word: str(w && w.word, 60), issue: str(w && w.issue, 200), tip: str(w && w.tip, 200),
  }));
  return {
    score, words,
    summary: str(obj.summary, 400), good: str(obj.good, 200), next: str(obj.next, 200),
  };
}

async function askGemini({ text, audio, mimeType }, opts = {}) {
  const model = opts.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const key = opts.apiKey || process.env.GEMINI_API_KEY;
  const doFetch = opts.fetch || fetch;
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-goog-api-key'] = key;

  const res = await doFetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: buildPrompt(text) },
          { inline_data: { mime_type: mimeType, data: audio } },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const err = new Error(`Gemini の呼び出しに失敗しました（${res.status}）`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts) || [];
  const raw = parts.map((p) => p.text || '').join('');
  try {
    return parseAdvice(raw);
  } catch {
    const err = new Error('AI の返事を読み取れませんでした。もう一度試してください。');
    err.status = 502;
    throw err;
  }
}

module.exports = { askGemini, buildPrompt, parseAdvice, DEFAULT_MODEL };
