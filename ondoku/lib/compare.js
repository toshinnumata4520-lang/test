'use strict';
// 見本の英文と、音声認識で聞き取れた文を単語ごとに突き合わせる。
// ブラウザ（public/app.js）とサーバー側テストの両方で使う。

const CONTRACTIONS = {
  "i'm": 'i am', "you're": 'you are', "he's": 'he is', "she's": 'she is',
  "it's": 'it is', "we're": 'we are', "they're": 'they are', "that's": 'that is',
  "there's": 'there is', "what's": 'what is', "let's": 'let us',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "can't": 'can not', "cannot": 'can not', "won't": 'will not', "couldn't": 'could not',
  "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "they'll": 'they will',
  "i've": 'i have', "we've": 'we have', "they've": 'they have', "i'd": 'i would',
};

const NUMBERS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
};

// 表示用の単語（句読点つき）と、比べる用の形（小文字・記号なし）を作る
function tokenize(text) {
  const out = [];
  for (const raw of String(text || '').split(/\s+/)) {
    if (!raw) continue;
    const norm = normalizeWord(raw);
    if (!norm) continue;
    // 短縮形は2語に分けて比べる（表示は元の1語にまとめる）
    const parts = (CONTRACTIONS[norm] || norm).split(' ');
    parts.forEach((p, i) => out.push({ text: raw, norm: p, part: i, parts: parts.length }));
  }
  return out;
}

function normalizeWord(w) {
  let s = String(w).toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9']/g, '');
  s = s.replace(/^'+|'+$/g, '');
  if (/^\d+$/.test(s) && NUMBERS[s]) s = NUMBERS[s];
  return s;
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// 日本人に多い音の取り違え（th→s、r→l、v→b、f→h）をそろえる
function fold(w) {
  return w.replace(/th/g, 's').replace(/sh/g, 's').replace(/r/g, 'l').replace(/v/g, 'b').replace(/f/g, 'h');
}

// 綴りが近い、または上の取り違え（例：think と sink、light と right）なら「おしい」とみなす
function isClose(a, b) {
  if (!a || !b) return false;
  if (fold(a) === fold(b)) return true;
  const d = editDistance(a, b);
  const len = Math.max(a.length, b.length);
  return d <= Math.max(1, Math.floor(len / 3)) && d < len;
}

// 結果：words（見本の単語ごとに ok / close / wrong / missing と聞き取れた語）、extra（余計に言った語）、score（0〜100）
function compare(expectedText, heardText) {
  const exp = tokenize(expectedText);
  const got = tokenize(heardText);
  const m = exp.length, n = got.length;

  // 最小コストの対応づけ（一致0・おしい1・違う2・抜け/余分2）
  const cost = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) cost[i][0] = i * 2;
  for (let j = 0; j <= n; j++) cost[0][j] = j * 2;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const a = exp[i - 1].norm, b = got[j - 1].norm;
      const sub = a === b ? 0 : isClose(a, b) ? 1 : 2.5;
      cost[i][j] = Math.min(cost[i - 1][j - 1] + sub, cost[i - 1][j] + 2, cost[i][j - 1] + 2);
    }
  }

  const tokStatus = new Array(m);
  const tokHeard = new Array(m).fill('');
  const extra = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const a = exp[i - 1].norm, b = got[j - 1].norm;
      const sub = a === b ? 0 : isClose(a, b) ? 1 : 2.5;
      if (cost[i][j] === cost[i - 1][j - 1] + sub) {
        tokStatus[i - 1] = sub === 0 ? 'ok' : sub === 1 ? 'close' : 'wrong';
        tokHeard[i - 1] = got[j - 1].norm;
        i--; j--; continue;
      }
    }
    if (i > 0 && cost[i][j] === cost[i - 1][j] + 2) {
      tokStatus[i - 1] = 'missing';
      i--; continue;
    }
    extra.unshift(got[j - 1].norm);
    j--;
  }

  // 短縮形で分けた語を、表示用の1語にまとめ直す（一番悪い判定を採る）
  const rank = { ok: 0, close: 1, wrong: 2, missing: 3 };
  const words = [];
  for (let k = 0; k < m; k++) {
    const t = exp[k];
    if (t.part === 0) words.push({ word: t.text, status: tokStatus[k], heard: tokHeard[k] });
    else {
      const w = words[words.length - 1];
      if (rank[tokStatus[k]] > rank[w.status]) w.status = tokStatus[k];
      w.heard = [w.heard, tokHeard[k]].filter(Boolean).join(' ');
    }
  }

  const points = { ok: 1, close: 0.5, wrong: 0, missing: 0 };
  const total = words.length;
  const got100 = words.reduce((s, w) => s + points[w.status], 0);
  const penalty = Math.min(extra.length * 0.25, got100);
  const score = total ? Math.round(((got100 - penalty) / total) * 100) : 0;
  return { words, extra, score };
}

const api = { compare, tokenize, normalizeWord, editDistance, isClose };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.OndokuCompare = api;
