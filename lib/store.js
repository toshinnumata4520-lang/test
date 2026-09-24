'use strict';

// 下校時刻共有システムのデータ層。
// JSON ファイル 1 つに全データを保存するシンプルな実装（プロトタイプ用）。
// 本番運用では PostgreSQL などの DB に置き換える想定で、業務ロジックはここに集約している。
// ※ 児童の氏名など個人情報は一切扱わない（学年ごとの時刻と備考のみ）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateVapidKeys, validateSubscription } = require('./webpush');

const GRADES = 6;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const NOTE_MAX = 200;
const MESSAGE_MAX = 500;
const PASSWORD_MIN = 8;
// この範囲外の下校時刻は入力ミスの可能性が高いので公開前に警告する
const USUAL_EARLIEST = '11:00';
const USUAL_LATEST = '17:00';

const ORG_TYPES = ['school', 'gakudo', 'admin'];

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function emptyData() {
  return {
    orgs: [],
    users: [],
    links: [], // 学童→学校の受信申請 { id, gakudoId, schoolId, status, requestedAt, decidedAt, decidedBy }
    entries: {}, // schoolId -> { date -> { published, draft } }
    releases: [],
    acks: {}, // releaseId -> { gakudoId -> ISO string }
    push: emptyPush(),
  };
}

function emptyPush() {
  // 通知の登録先。保護者分は学校ごとにまとめ、誰の登録かは記録しない（個人情報を持たない）
  return { vapid: null, gakudo: {}, parents: {} };
}

const PUSH_MAX_PER_OWNER = 5000;

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function newViewCode() {
  return crypto.randomBytes(12).toString('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new AppError(`パスワードは${PASSWORD_MIN}文字以上にしてください`);
  }
}

function emptyDay() {
  return { grades: Array(GRADES).fill(''), note: '' };
}

function normalizeDay(input) {
  const grades = input && Array.isArray(input.grades) ? input.grades : [];
  if (grades.length > GRADES) throw new AppError('学年の数が多すぎます');
  const out = [];
  for (let i = 0; i < GRADES; i++) {
    const v = String(grades[i] ?? '').trim();
    if (v && !TIME_RE.test(v)) throw new AppError(`${i + 1}年の時刻が正しくありません: ${v}`);
    out.push(v);
  }
  const note = String((input && input.note) ?? '').trim();
  if (note.length > NOTE_MAX) throw new AppError(`備考は${NOTE_MAX}文字以内で入力してください`);
  return { grades: out, note };
}

function sameDay(a, b) {
  return a.note === b.note && a.grades.every((g, i) => g === b.grades[i]);
}

function diffDay(date, before, after) {
  const changes = [];
  for (let i = 0; i < GRADES; i++) {
    if (before.grades[i] !== after.grades[i]) {
      changes.push({ date, grade: i + 1, before: before.grades[i], after: after.grades[i] });
    }
  }
  if (before.note !== after.note) {
    changes.push({ date, field: 'note', before: before.note, after: after.note });
  }
  return changes;
}

function assertDate(date) {
  if (!DATE_RE.test(date)) throw new AppError(`日付が正しくありません: ${date}`);
}

// 日本時間での日付（YYYY-MM-DD）。offsetDays で翌日などを求める
function jstDate(now, offsetDays = 0) {
  const d = new Date(now.getTime() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function publicUser(u) {
  return { id: u.id, orgId: u.orgId, loginId: u.loginId, name: u.name };
}

class Store {
  constructor(data = emptyData(), { file = null, now = () => new Date() } = {}) {
    this.data = data;
    if (!this.data.push) this.data.push = emptyPush();
    this.file = file;
    this.now = now;
  }

  static open(file, opts = {}) {
    let data = null;
    if (file && fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Store(data || emptyData(), { ...opts, file });
  }

  isEmpty() {
    return this.data.orgs.length === 0;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nowIso() {
    return this.now().toISOString();
  }

  // ---- 組織・ユーザー（運営事務局が発行する） ----

  createOrg({ type, name, municipality = '', phone = '' }) {
    if (!ORG_TYPES.includes(type)) throw new AppError('組織の種類が正しくありません');
    name = String(name || '').trim();
    if (!name) throw new AppError('名前を入力してください');
    const org = { id: newId(), type, name, municipality: String(municipality).trim(), phone: String(phone).trim() };
    if (type === 'school') {
      org.viewCode = newViewCode();
      org.parentLinkEnabled = true;
      this.data.entries[org.id] = {};
    }
    this.data.orgs.push(org);
    return org;
  }

  createUser({ orgId, loginId, name, password }) {
    if (!this.org(orgId)) throw new AppError('組織が見つかりません', 404);
    loginId = String(loginId || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(loginId)) throw new AppError('ログインIDは半角英数字3〜40文字にしてください');
    if (this.data.users.some((u) => u.loginId === loginId)) throw new AppError('そのログインIDは既に使われています');
    assertPassword(password);
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), orgId, loginId, name: String(name || loginId).trim(), salt, hash };
    this.data.users.push(user);
    return user;
  }

  verifyLogin(loginId, password) {
    const user = this.data.users.find((u) => u.loginId === loginId);
    if (!user) {
      hashPassword(String(password)); // 存在しないIDでも処理時間を揃える
      return null;
    }
    const { hash } = hashPassword(String(password), user.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
    return ok ? user : null;
  }

  changePassword(userId, current, next) {
    const user = this.user(userId);
    if (!user || !this.verifyLogin(user.loginId, current)) throw new AppError('現在のパスワードが違います');
    assertPassword(next);
    Object.assign(user, hashPassword(next));
  }

  resetPassword(userId, next) {
    const user = this.user(userId);
    if (!user) throw new AppError('ユーザーが見つかりません', 404);
    assertPassword(next);
    Object.assign(user, hashPassword(next));
  }

  deleteUser(userId) {
    const i = this.data.users.findIndex((u) => u.id === userId);
    if (i < 0) throw new AppError('ユーザーが見つかりません', 404);
    this.data.users.splice(i, 1);
  }

  user(id) {
    return this.data.users.find((u) => u.id === id) || null;
  }

  org(id) {
    return this.data.orgs.find((o) => o.id === id) || null;
  }

  schools() {
    return this.data.orgs.filter((o) => o.type === 'school');
  }

  requireOrg(id, type) {
    const org = this.org(id);
    if (!org || org.type !== type) throw new AppError(type === 'school' ? '学校が見つかりません' : '学童が見つかりません', 404);
    return org;
  }

  directory() {
    return this.data.orgs.map((o) => ({
      id: o.id,
      type: o.type,
      name: o.name,
      municipality: o.municipality,
      phone: o.phone,
      users: this.data.users.filter((u) => u.orgId === o.id).map(publicUser),
    }));
  }

  // ---- 受信申請（学童が申請 → 学校が承認した場合のみ情報が届く） ----

  requestLink(gakudoId, schoolId) {
    this.requireOrg(gakudoId, 'gakudo');
    this.requireOrg(schoolId, 'school');
    let link = this.data.links.find((l) => l.gakudoId === gakudoId && l.schoolId === schoolId);
    if (link && link.status !== 'rejected') return link;
    if (!link) {
      link = { id: newId(), gakudoId, schoolId };
      this.data.links.push(link);
    }
    Object.assign(link, { status: 'pending', requestedAt: this.nowIso(), decidedAt: null, decidedBy: null });
    return link;
  }

  cancelLink(gakudoId, schoolId) {
    const i = this.data.links.findIndex((l) => l.gakudoId === gakudoId && l.schoolId === schoolId);
    if (i < 0) throw new AppError('申請が見つかりません', 404);
    this.data.links.splice(i, 1);
  }

  // 学校による承認・却下・受信停止
  decideLink(schoolId, linkId, approve, userId) {
    const link = this.data.links.find((l) => l.id === linkId && l.schoolId === schoolId);
    if (!link) throw new AppError('申請が見つかりません', 404);
    Object.assign(link, { status: approve ? 'approved' : 'rejected', decidedAt: this.nowIso(), decidedBy: userId });
    return link;
  }

  linksForGakudo(gakudoId) {
    this.requireOrg(gakudoId, 'gakudo');
    return this.data.links
      .filter((l) => l.gakudoId === gakudoId)
      .map((l) => ({ ...l, schoolName: (this.org(l.schoolId) || {}).name }));
  }

  linksForSchool(schoolId) {
    this.requireOrg(schoolId, 'school');
    return this.data.links
      .filter((l) => l.schoolId === schoolId)
      .map((l) => {
        const g = this.org(l.gakudoId) || {};
        return { ...l, gakudoName: g.name, gakudoMunicipality: g.municipality, gakudoPhone: g.phone };
      });
  }

  subscriptionsOf(gakudoId) {
    return this.data.links.filter((l) => l.gakudoId === gakudoId && l.status === 'approved').map((l) => l.schoolId);
  }

  subscribersOf(schoolId) {
    return this.data.links.filter((l) => l.schoolId === schoolId && l.status === 'approved').map((l) => l.gakudoId);
  }

  // ---- 学校側：下書きの編集 ----

  schoolEntries(schoolId) {
    this.requireOrg(schoolId, 'school');
    if (!this.data.entries[schoolId]) this.data.entries[schoolId] = {};
    return this.data.entries[schoolId];
  }

  schoolMonth(schoolId, month) {
    if (!MONTH_RE.test(month)) throw new AppError('月の指定が正しくありません');
    const entries = this.schoolEntries(schoolId);
    const out = {};
    for (const [date, entry] of Object.entries(entries)) {
      if (date.startsWith(`${month}-`)) out[date] = entry;
    }
    return out;
  }

  // days: { 'YYYY-MM-DD': { grades, note } }
  saveDrafts(schoolId, days) {
    const entries = this.schoolEntries(schoolId);
    if (!days || typeof days !== 'object') throw new AppError('入力内容が正しくありません');
    const dates = Object.keys(days);
    if (dates.length > 400) throw new AppError('一度に保存できる日数を超えています');
    // 先に全件を検証してから反映する（途中まで保存される事故を防ぐ）
    const normalized = dates.map((date) => {
      assertDate(date);
      return [date, normalizeDay(days[date])];
    });
    for (const [date, day] of normalized) {
      const entry = entries[date] || { published: null, draft: null };
      const base = entry.published || emptyDay();
      entry.draft = sameDay(base, day) ? null : day;
      if (!entry.published && !entry.draft) delete entries[date];
      else entries[date] = entry;
    }
    return this.pendingSummary(schoolId);
  }

  discardDrafts(schoolId) {
    const entries = this.schoolEntries(schoolId);
    for (const [date, entry] of Object.entries(entries)) {
      entry.draft = null;
      if (!entry.published) delete entries[date];
    }
    return this.pendingSummary(schoolId);
  }

  pendingChanges(schoolId) {
    const entries = this.schoolEntries(schoolId);
    const changes = [];
    for (const date of Object.keys(entries).sort()) {
      const { published, draft } = entries[date];
      if (!draft) continue;
      changes.push(...diffDay(date, published || emptyDay(), draft));
    }
    return changes;
  }

  // 公開前に確認してもらう内容：変更一覧・入力ミスの疑い・当日/翌日の変更
  pendingSummary(schoolId) {
    const changes = this.pendingChanges(schoolId);
    const today = jstDate(this.now());
    const tomorrow = jstDate(this.now(), 1);
    const warnings = [];
    for (const c of changes) {
      if (c.grade && c.after && (c.after < USUAL_EARLIEST || c.after > USUAL_LATEST)) {
        warnings.push({ date: c.date, message: `${c.grade}年の下校時刻 ${c.after} は通常と大きく異なります。入力ミスではありませんか？` });
      }
    }
    const pastDates = [...new Set(changes.filter((c) => c.date < today).map((c) => c.date))];
    for (const date of pastDates) warnings.push({ date, message: '過去の日付を変更しようとしています' });
    // 「当日・翌日の変更」は公開済みの時刻を直した場合だけ（月初の新規公開などは対象外）
    const entries = this.schoolEntries(schoolId);
    const urgentDates = [...new Set(changes
      .filter((c) => (c.date === today || c.date === tomorrow) && entries[c.date].published)
      .map((c) => c.date))];
    return { changes, warnings, urgentDates };
  }

  // ---- 学校側：公開（リリース） ----

  publish(schoolId, userId, message = '') {
    const entries = this.schoolEntries(schoolId);
    const msg = String(message ?? '').trim();
    if (msg.length > MESSAGE_MAX) throw new AppError(`お知らせ文は${MESSAGE_MAX}文字以内で入力してください`);
    const { changes, urgentDates } = this.pendingSummary(schoolId);
    if (changes.length === 0) throw new AppError('公開する変更がありません');

    const publishedAt = this.nowIso();
    let isRevision = false;
    for (const entry of Object.values(entries)) {
      if (!entry.draft) continue;
      if (entry.published) isRevision = true;
      const version = entry.published ? entry.published.version + 1 : 1;
      entry.published = { ...entry.draft, version, publishedAt };
      entry.draft = null;
    }

    const release = {
      id: newId(),
      schoolId,
      kind: isRevision ? 'revision' : 'new',
      urgent: urgentDates.length > 0,
      urgentDates,
      message: msg,
      changes,
      publishedBy: userId,
      publishedAt,
      recipients: this.subscribersOf(schoolId),
    };
    this.data.releases.push(release);
    this.data.acks[release.id] = {};
    return release;
  }

  // ---- 公開履歴・確認状況 ----

  decorateRelease(release) {
    const school = this.org(release.schoolId);
    const author = this.user(release.publishedBy);
    const acks = this.data.acks[release.id] || {};
    return {
      ...release,
      schoolName: school ? school.name : '(削除された学校)',
      publishedByName: author ? author.name : '(削除されたユーザー)',
      acks: release.recipients.map((gakudoId) => {
        const g = this.org(gakudoId) || {};
        return { gakudoId, gakudoName: g.name || '(削除された学童)', gakudoPhone: g.phone || '', ackedAt: acks[gakudoId] || null };
      }),
    };
  }

  releasesForSchool(schoolId) {
    this.requireOrg(schoolId, 'school');
    return this.data.releases
      .filter((r) => r.schoolId === schoolId)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((r) => this.decorateRelease(r));
  }

  releasesForGakudo(gakudoId) {
    this.requireOrg(gakudoId, 'gakudo');
    return this.data.releases
      .filter((r) => r.recipients.includes(gakudoId))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((r) => {
        const d = this.decorateRelease(r);
        const mine = d.acks.find((a) => a.gakudoId === gakudoId);
        // 学童には他の学童の名前・電話番号を見せない
        return { ...d, acks: undefined, ackedAt: mine ? mine.ackedAt : null };
      });
  }

  acknowledge(releaseId, gakudoId) {
    const release = this.data.releases.find((r) => r.id === releaseId);
    if (!release || !release.recipients.includes(gakudoId)) throw new AppError('お知らせが見つかりません', 404);
    const acks = (this.data.acks[releaseId] = this.data.acks[releaseId] || {});
    if (!acks[gakudoId]) acks[gakudoId] = this.nowIso();
    return release;
  }

  // ---- 閲覧（学童・保護者） ----

  publishedBetween(schoolId, from, to) {
    assertDate(from);
    assertDate(to);
    const entries = this.schoolEntries(schoolId);
    const out = {};
    for (const [date, entry] of Object.entries(entries)) {
      if (entry.published && date >= from && date <= to) out[date] = entry.published;
    }
    return out;
  }

  gakudoSchedule(gakudoId, from, to) {
    this.requireOrg(gakudoId, 'gakudo');
    return this.subscriptionsOf(gakudoId).map((schoolId) => {
      const school = this.org(schoolId);
      return { id: school.id, name: school.name, municipality: school.municipality, days: this.publishedBetween(schoolId, from, to) };
    });
  }

  // ---- 保護者向けリンク ----

  parentLink(schoolId) {
    const school = this.requireOrg(schoolId, 'school');
    return { enabled: school.parentLinkEnabled, code: school.viewCode };
  }

  setParentLink(schoolId, { enabled, regenerate }) {
    const school = this.requireOrg(schoolId, 'school');
    if (typeof enabled === 'boolean') school.parentLinkEnabled = enabled;
    if (regenerate) {
      school.viewCode = newViewCode(); // 古いリンクは即座に無効になる
      delete this.data.push.parents[schoolId]; // 古いリンクから登録された通知も解除する
    }
    return this.parentLink(schoolId);
  }

  assertParentCode(schoolId, code) {
    const school = this.org(schoolId);
    const valid =
      school && school.type === 'school' && school.parentLinkEnabled && typeof code === 'string' &&
      code.length === school.viewCode.length &&
      crypto.timingSafeEqual(Buffer.from(code), Buffer.from(school.viewCode));
    if (!valid) throw new AppError('このリンクは無効です。学校から配布された最新のリンクをご確認ください', 404);
    return school;
  }

  parentPushCount(schoolId) {
    return (this.data.push.parents[schoolId] || []).length;
  }

  // ---- プッシュ通知の登録 ----

  vapid() {
    if (!this.data.push.vapid) this.data.push.vapid = generateVapidKeys();
    return this.data.push.vapid;
  }

  addPush(kind, ownerId, subscription) {
    const sub = validateSubscription(subscription);
    if (!sub) throw new AppError('通知の登録情報が正しくありません');
    const bucket = this.data.push[kind];
    const list = (bucket[ownerId] = (bucket[ownerId] || []).filter((s) => s.endpoint !== sub.endpoint));
    if (list.length >= PUSH_MAX_PER_OWNER) throw new AppError('通知の登録数が上限に達しています');
    list.push({ ...sub, createdAt: this.nowIso() });
  }

  removePush(kind, ownerId, endpoint) {
    const bucket = this.data.push[kind];
    if (bucket[ownerId]) bucket[ownerId] = bucket[ownerId].filter((s) => s.endpoint !== endpoint);
  }

  pushSubs(kind, ownerId) {
    return [...(this.data.push[kind][ownerId] || [])];
  }

  publicSchoolMonth(schoolId, code, month) {
    const school = this.assertParentCode(schoolId, code);
    if (!MONTH_RE.test(month)) throw new AppError('月の指定が正しくありません');
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // 今日以降の日付に関わる最近の「修正」（保護者が見落としやすいので上に出す）
    const today = jstDate(this.now());
    const updates = this.data.releases
      .filter((r) => r.schoolId === schoolId && r.kind === 'revision')
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((r) => ({ publishedAt: r.publishedAt, message: r.message, urgent: r.urgent, changes: r.changes.filter((c) => c.date >= today) }))
      .filter((r) => r.changes.length)
      .slice(0, 5);
    return {
      school: { name: school.name, municipality: school.municipality },
      days: this.publishedBetween(schoolId, `${month}-01`, `${month}-${String(last).padStart(2, '0')}`),
      updates,
    };
  }
}

module.exports = { Store, AppError, GRADES, emptyDay, normalizeDay, jstDate };
