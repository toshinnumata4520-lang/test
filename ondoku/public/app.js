'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const { compare } = window.OndokuCompare;
  const MAX_SEC = 60;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  let passages = [];
  let recorder = null, recognizer = null, stream = null;
  let chunks = [], finalText = '', interimText = '';
  let recording = false, startedAt = 0, tick = null;
  let lastBlob = null, lastUrl = null, lastText = '';

  // ---------- 見本文 ----------
  fetch('/api/passages').then((r) => r.json()).then((list) => {
    passages = list;
    $('passage').innerHTML = list.map((p, i) =>
      `<option value="${i}">${p.level}｜${escapeHtml(p.title)}</option>`).join('')
      + '<option value="custom">自分で入力する</option>';
    $('text').value = list[0] ? list[0].text : '';
  });
  $('passage').addEventListener('change', (e) => {
    if (e.target.value === 'custom') { $('text').value = ''; $('text').focus(); return; }
    $('text').value = passages[Number(e.target.value)].text;
  });

  function speak(text) {
    if (!('speechSynthesis' in window)) return warn('この端末では読み上げが使えません。');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = $('slow').checked ? 0.7 : 0.95;
    const v = speechSynthesis.getVoices().find((x) => x.lang === 'en-US') ||
      speechSynthesis.getVoices().find((x) => x.lang.startsWith('en'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  $('listen').addEventListener('click', () => speak($('text').value));

  // ---------- 録音と音声認識 ----------
  if (!SR) warn('この端末では、その場での判定（音声認識）が使えません。パソコンの Chrome か Edge をおすすめします。録音して「AI にくわしく見てもらう」は使えます。');

  $('rec').addEventListener('click', () => (recording ? stop() : start()));

  async function start() {
    const text = $('text').value.trim();
    if (!text) return warn('読む英文を入れてください。');
    hide($('warn'));
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return warn('マイクが使えません。ブラウザの設定でマイクを許可してください。');
    }
    lastText = text;
    chunks = []; finalText = ''; interimText = '';
    recorder = new MediaRecorder(stream, pickMime());
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = finish;
    recorder.start();

    if (SR) {
      recognizer = new SR();
      recognizer.lang = 'en-US';
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.onresult = (e) => {
        interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += ' ' + r[0].transcript;
          else interimText += ' ' + r[0].transcript;
        }
        $('live').textContent = (finalText + interimText).trim();
      };
      // 無音が続くと勝手に止まるので、録音中なら再開する
      recognizer.onend = () => { if (recording) try { recognizer.start(); } catch { /* 再開できないときはそのまま */ } };
      recognizer.onerror = (e) => {
        const msg = {
          'not-allowed': '音声認識が許可されていません。',
          'service-not-allowed': 'この端末では音声認識が使えません。',
          network: '音声認識の通信ができませんでした。インターネットにつながっているか確認してください。',
          'language-not-supported': 'この端末では英語の音声認識が使えません。',
        }[e.error];
        if (msg) warn(msg + '「AI にくわしく見てもらう」は使えます。');
      };
      try { recognizer.start(); } catch { /* 二重起動は無視 */ }
    }

    recording = true;
    startedAt = Date.now();
    $('rec').textContent = '■ おわり';
    $('rec').classList.add('recording');
    $('live').textContent = '聞いています…';
    hide($('resultCard')); hide($('aiCard'));
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      $('timer').textContent = `${s} 秒`;
      if (s >= MAX_SEC) stop();
    }, 250);
  }

  function stop() {
    if (!recording) return;
    recording = false;
    clearInterval(tick);
    $('timer').textContent = '';
    $('rec').textContent = '● 録音スタート';
    $('rec').classList.remove('recording');
    if (recognizer) try { recognizer.stop(); } catch { /* すでに止まっている */ }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  function pickMime() {
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return { mimeType: t };
    }
    return {};
  }

  function finish() {
    lastBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(lastBlob);
    // 認識の最後の結果が届くのを少し待ってから判定する
    setTimeout(showResult, SR ? 600 : 0);
  }

  // ---------- 結果 ----------
  function showResult() {
    const heard = (finalText + ' ' + interimText).trim();
    $('live').textContent = '';
    show($('resultCard'));
    $('ai').disabled = false;
    if (!SR) {
      $('score').textContent = '—';
      $('words').textContent = lastText;
      $('heard').textContent = 'この端末では、その場での判定ができません。「AI にくわしく見てもらう」を押してください。';
      hide($('extra'));
      return;
    }
    const r = compare(lastText, heard);
    $('score').textContent = r.score;
    const box = $('words');
    box.innerHTML = '';
    r.words.forEach((w) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `w ${w.status}`;
      b.textContent = w.word;
      if (w.status === 'close' || w.status === 'wrong') {
        const s = document.createElement('small');
        s.textContent = w.heard;
        b.appendChild(s);
      }
      b.title = { ok: '合っている', close: `おしい（${w.heard} に聞こえた）`, wrong: `ちがう（${w.heard} に聞こえた）`, missing: '聞き取れなかった' }[w.status];
      b.addEventListener('click', () => speak(w.word));
      box.appendChild(b);
      box.appendChild(document.createTextNode(' '));
    });
    if (r.extra.length) {
      $('extra').textContent = `英文にない言葉：${r.extra.join(', ')}`;
      show($('extra'));
    } else hide($('extra'));
    $('heard').textContent = heard ? `聞き取れた文：${heard}` : '声が聞き取れませんでした。マイクに近づいて、もう一度読んでみましょう。';
  }

  $('playMine').addEventListener('click', () => { if (lastUrl) new Audio(lastUrl).play(); });

  // ---------- AI の助言 ----------
  $('ai').addEventListener('click', async () => {
    if (!lastBlob || !lastBlob.size) return warn('先に録音してください。');
    $('ai').disabled = true;
    show($('aiCard'));
    $('aiBody').textContent = 'AI が聞いています…（10秒ほどかかります）';
    try {
      const audio = await toBase64(lastBlob);
      const res = await fetch('/api/advice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: lastText, audio, mimeType: lastBlob.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'うまくいきませんでした');
      renderAdvice(data);
    } catch (e) {
      $('aiBody').textContent = `エラー：${e.message}`;
      $('ai').disabled = false;
    }
  });

  function renderAdvice(a) {
    const items = a.words.map((w) =>
      `<li><b>${escapeHtml(w.word)}</b>：${escapeHtml(w.issue)}<br>→ ${escapeHtml(w.tip)}</li>`).join('');
    $('aiBody').innerHTML =
      `<div class="ai-score">${a.score}<small> 点</small></div>` +
      `<p>${escapeHtml(a.summary)}</p>` +
      (items ? `<h3>直すとよい単語</h3><ul class="ai-list">${items}</ul>` : '') +
      (a.good ? `<p>👍 ${escapeHtml(a.good)}</p>` : '') +
      (a.next ? `<p>📝 次の練習：${escapeHtml(a.next)}</p>` : '');
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('録音を読み込めませんでした'));
      fr.readAsDataURL(blob);
    });
  }

  // ---------- 小物 ----------
  function warn(msg) { $('warn').textContent = msg; show($('warn')); }
  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
