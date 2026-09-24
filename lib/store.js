'use strict';

// 下校時刻共有システムのデータ層。
// JSON ファイル 1 つに全データを保存するシンプルな実装（プロトタイプ用）。
// 本番運用では PostgreSQL などの DB に置き換える想定で、業務ロジックはここに集約している。
// ※ 児童の氏名など個人情報は一切扱わない（学年ごとの時刻と備考のみ）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateVapidKeys, validateSubscription } = require('./webpush');
const totp = require('./totp');

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

// council: 連絡協議会（全体の管理。事務局は幹事市町村の教育委員会を想定）
// board:   市町村の管理者（教育委員会・学童担当課）。自分の市町村の学校・学童だけを管理する
const ORG_TYPES = ['council', 'board', 'school', 'gakudo'];
const MANAGEABLE_BY_BOARD = ['school', 'gakudo'];
const ROLES = ['manager', 'staff']; // manager: 自組織の職員アカウントを管理できる（校長・教頭など）
const AUDIT_MAX = 100000;

function defaultSettings() {
  return { mfaRequired: { council: true, board: true, school: false, gakudo: false } };
}

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
    settings: defaultSettings(),
    audit: [], // 操作履歴（誰が・いつ・何をしたか）
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
  return {
    id: u.id,
    orgId: u.orgId,
    loginId: u.loginId,
    name: u.name,
    role: u.role,
    disabled: Boolean(u.disabled),
    lastLoginAt: u.lastLoginAt || null,
    mfaEnabled: Boolean(u.mfa),
  };
}

class Store {
  constructor(data = emptyData(), { file = null, now = () => new Date() } = {}) {
    this.data = data;
    if (!this.data.push) this.data.push = emptyPush();
    if (!this.data.settings) this.data.settings = defaultSettings();
    if (!this.data.audit) this.data.audit = [];
    // 旧形式（運営事務局 admin）のデータを読み込んだ場合の移行
    for (const o of this.data.orgs) if (o.type === 'admin') o.type = 'council';
    for (const u of this.data.users) if (!u.role) u.role = 'manager';
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

  // ---- 組織・ユーザー ----
  // アカウントは連絡協議会・市町村（教育委員会等）・各校の管理職が発行する。特定の民間事業者は管理権を持たない。

  createOrg({ type, name, municipality = '', phone = '', manages = [] }) {
    if (!ORG_TYPES.includes(type)) throw new AppError('組織の種類が正しくありません');
    name = String(name || '').trim();
    if (!name) throw new AppError('名前を入力してください');
    const org = { id: newId(), type, name, municipality: String(municipality || '').trim(), phone: String(phone || '').trim() };
    if (type === 'board') {
      if (!org.municipality) throw new AppError('市町村名を入力してください');
      const m = [...new Set(Array.isArray(manages) ? manages : [])];
      if (!m.length || m.some((t) => !MANAGEABLE_BY_BOARD.includes(t))) throw new AppError('管理対象（学校・学童）を選んでください');
      org.manages = m;
    }
    if ((type === 'school' || type === 'gakudo') && !org.municipality) throw new AppError('市町村名を入力してください');
    if (type === 'school') {
      org.viewCode = newViewCode();
      org.parentLinkEnabled = true;
      this.data.entries[org.id] = {};
    }
    this.data.orgs.push(org);
    return org;
  }

  createUser({ orgId, loginId, name, password, role = 'staff' }) {
    if (!this.org(orgId)) throw new AppError('組織が見つかりません', 404);
    if (!ROLES.includes(role)) throw new AppError('権限の指定が正しくありません');
    loginId = String(loginId || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(loginId)) throw new AppError('ログインIDは半角英数字3〜40文字にしてください');
    if (this.data.users.some((u) => u.loginId === loginId)) throw new AppError('そのログインIDは既に使われています');
    assertPassword(password);
    const { salt, hash } = hashPassword(password);
    const user = {
      id: newId(), orgId, loginId, name: String(name || loginId).trim(), role, salt, hash,
      disabled: false, createdAt: this.nowIso(), lastLoginAt: null, mfa: null, mfaPending: null,
    };
    this.data.users.push(user);
    return user;
  }

  // 停止中のアカウントは、パスワードが合っていてもログインできない
  verifyLogin(loginId, password) {
    const user = this.data.users.find((u) => u.loginId === loginId);
    if (!user) {
      hashPassword(String(password)); // 存在しないIDでも処理時間を揃える
      return null;
    }
    const { hash } = hashPassword(String(password), user.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
    return ok && !user.disabled ? user : null;
  }

  recordLogin(userId) {
    const user = this.user(userId);
    if (user) user.lastLoginAt = this.nowIso();
  }

  changePassword(userId, current, next) {
    const user = this.user(userId);
    if (!user || !this.verifyLogin(user.loginId, current)) throw new AppError('現在のパスワードが違います');
    assertPassword(next);
    Object.assign(user, hashPassword(next));
  }

  user(id) {
    return this.data.users.find((u) => u.id === id) || null;
  }

  requireUser(id) {
    const user = this.user(id);
    if (!user) throw new AppError('ユーザーが見つかりません', 404);
    return user;
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

  // ---- 管理権限 ----

  canManageOrg(actor, target) {
    const own = actor && !actor.disabled && this.org(actor.orgId);
    if (!own || !target) return false;
    if (own.type === 'council') return true;
    if (own.id === target.id) return actor.role === 'manager'; // 自組織の職員は管理職が管理
    if (own.type === 'board') return target.municipality === own.municipality && own.manages.includes(target.type);
    return false;
  }

  assertCanManageOrg(actor, target) {
    if (!this.canManageOrg(actor, target)) throw new AppError('この組織を管理する権限がありません', 403);
  }

  isAdministrator(actor) {
    const own = actor && this.org(actor.orgId);
    return Boolean(own && (own.type === 'council' || own.type === 'board' || actor.role === 'manager'));
  }

  // 管理できる組織と、その職員アカウントの一覧
  managedDirectory(actor) {
    return this.data.orgs
      .filter((o) => this.canManageOrg(actor, o))
      .map((o) => ({
        id: o.id,
        type: o.type,
        name: o.name,
        municipality: o.municipality,
        phone: o.phone,
        manages: o.manages,
        users: this.data.users.filter((u) => u.orgId === o.id).map(publicUser),
      }));
  }

  createOrgAs(actor, input) {
    const own = this.org(actor.orgId);
    if (input.type === 'council') throw new AppError('連絡協議会はここでは作成できません', 403);
    if (own.type === 'council') return this.createOrg(input);
    if (own.type === 'board' && own.manages.includes(input.type)) {
      return this.createOrg({ ...input, municipality: own.municipality }); // 自分の市町村にしか作れない
    }
    throw new AppError('この種類の組織を作成する権限がありません', 403);
  }

  updateOrgAs(actor, orgId, { name, phone }) {
    const org = this.org(orgId);
    if (!org) throw new AppError('組織が見つかりません', 404);
    this.assertCanManageOrg(actor, org);
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw new AppError('名前を入力してください');
      org.name = n;
    }
    if (phone !== undefined) org.phone = String(phone).trim();
    return org;
  }

  createUserAs(actor, input) {
    this.assertCanManageOrg(actor, this.org(input.orgId));
    return this.createUser(input);
  }

  managedUser(actor, userId) {
    const user = this.requireUser(userId);
    this.assertCanManageOrg(actor, this.org(user.orgId));
    return user;
  }

  // 削除ではなく停止にする（操作履歴に残る名前を保つため）。人事異動・退職時に使う
  setUserDisabledAs(actor, userId, disabled) {
    if (userId === actor.id) throw new AppError('自分自身のアカウントは停止できません');
    const user = this.managedUser(actor, userId);
    user.disabled = Boolean(disabled);
    return user;
  }

  resetPasswordAs(actor, userId, next) {
    const user = this.managedUser(actor, userId);
    assertPassword(next);
    Object.assign(user, hashPassword(next));
    return user;
  }

  // ---- 2段階認証 ----

  mfaRequired(user) {
    const org = this.org(user.orgId);
    return Boolean(org && this.data.settings.mfaRequired[org.type]);
  }

  startMfaSetup(userId) {
    const user = this.requireUser(userId);
    user.mfaPending = totp.generateSecret();
    return { secret: user.mfaPending, uri: totp.otpauthUri(user.mfaPending, user.loginId) };
  }

  enableMfa(userId, code) {
    const user = this.requireUser(userId);
    if (!user.mfaPending) throw new AppError('先に設定を開始してください');
    const step = totp.verify(user.mfaPending, code, { now: this.now().getTime() });
    if (step === null) throw new AppError('確認コードが違います。アプリに表示されている6桁の数字を入力してください');
    user.mfa = { secret: user.mfaPending, lastStep: step };
    user.mfaPending = null;
  }

  // 同じコードの使い回しはできない
  verifyMfa(userId, code) {
    const user = this.requireUser(userId);
    if (!user.mfa) return false;
    const step = totp.verify(user.mfa.secret, code, { now: this.now().getTime(), lastStep: user.mfa.lastStep });
    if (step === null) return false;
    user.mfa.lastStep = step;
    return true;
  }

  // スマホの紛失・機種変更時に、管理者が2段階認証を解除する（本人は次回ログイン時に再設定）
  resetMfaAs(actor, userId) {
    const user = this.managedUser(actor, userId);
    user.mfa = null;
    user.mfaPending = null;
    return user;
  }

  // ---- 全体設定（連絡協議会のみ） ----

  settings() {
    return JSON.parse(JSON.stringify(this.data.settings));
  }

  updateSettingsAs(actor, { mfaRequired }) {
    if (this.org(actor.orgId).type !== 'council') throw new AppError('全体設定は連絡協議会だけが変更できます', 403);
    if (mfaRequired && typeof mfaRequired === 'object') {
      for (const t of ORG_TYPES) if (typeof mfaRequired[t] === 'boolean') this.data.settings.mfaRequired[t] = mfaRequired[t];
    }
    return this.settings();
  }

  // 保存期間を過ぎた下校時刻・公開履歴を削除する（例：年度終了から1年後）
  purgeBeforeAs(actor, date) {
    if (this.org(actor.orgId).type !== 'council') throw new AppError('データの削除は連絡協議会だけが行えます', 403);
    assertDate(date);
    let days = 0;
    for (const entries of Object.values(this.data.entries)) {
      for (const d of Object.keys(entries)) {
        if (d < date) {
          delete entries[d];
          days++;
        }
      }
    }
    const before = this.data.releases.length;
    const cutoff = `${date}T00:00:00`;
    const kept = this.data.releases.filter((r) => r.publishedAt >= cutoff);
    for (const r of this.data.releases) if (r.publishedAt < cutoff) delete this.data.acks[r.id];
    this.data.releases = kept;
    return { days, releases: before - kept.length };
  }

  // ---- 操作履歴 ----

  audit(actor, action, { target = '', detail = '', ip = '', targetOrg = null } = {}) {
    const own = actor ? this.org(actor.orgId) : null;
    this.data.audit.push({
      id: newId(),
      at: this.nowIso(),
      userId: actor ? actor.id : null,
      userName: actor ? actor.name : '',
      loginId: actor ? actor.loginId : '',
      orgId: own ? own.id : null,
      orgName: own ? own.name : '',
      municipality: own ? own.municipality : '',
      targetOrgId: targetOrg ? targetOrg.id : null,
      targetMunicipality: targetOrg ? targetOrg.municipality : '',
      action,
      target,
      detail,
      ip,
    });
    if (this.data.audit.length > AUDIT_MAX) this.data.audit.splice(0, this.data.audit.length - AUDIT_MAX);
  }

  // 協議会は全体、市町村は自分の市町村、各校・学童の管理職は自組織の履歴だけを見られる
  auditFor(actor, { limit = 300 } = {}) {
    const own = this.org(actor.orgId);
    let list;
    if (own.type === 'council') list = this.data.audit;
    else if (own.type === 'board') {
      list = this.data.audit.filter((a) => a.orgId === own.id || a.municipality === own.municipality || a.targetMunicipality === own.municipality);
    } else if (actor.role === 'manager') {
      list = this.data.audit.filter((a) => a.orgId === own.id || a.targetOrgId === own.id);
    } else throw new AppError('操作履歴を見る権限がありません', 403);
    return list.slice(-Math.min(Math.max(Number(limit) || 300, 1), 2000)).reverse();
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
