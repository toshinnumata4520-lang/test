'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');

const G = (...t) => ({ grades: [...t, '', '', '', '', '', ''].slice(0, 6), note: '' });

function setup(now = new Date('2026-10-05T00:00:00Z')) {
  const store = new Store(undefined, { now: () => now });
  const school = store.createOrg({ type: 'school', name: 'A小', municipality: '沼田市' });
  const teacher = store.createUser({ orgId: school.id, loginId: 'teacher', name: '先生', password: 'password1' });
  const g1 = store.createOrg({ type: 'gakudo', name: '学童1', municipality: '沼田市', phone: '0278-00-0001' });
  const g2 = store.createOrg({ type: 'gakudo', name: '学童2', municipality: '沼田市' });
  return { store, school, teacher, g1, g2 };
}

function approve(store, gakudo, school, teacher) {
  const link = store.requestLink(gakudo.id, school.id);
  store.decideLink(school.id, link.id, true, teacher.id);
}

test('下書きは公開するまで学童に見えない', () => {
  const { store, school, teacher, g1 } = setup();
  approve(store, g1, school, teacher);
  store.saveDrafts(school.id, { '2026-10-07': G('14:45', '14:45') });
  assert.deepEqual(store.gakudoSchedule(g1.id, '2026-10-01', '2026-10-31')[0].days, {});
  assert.equal(store.releasesForGakudo(g1.id).length, 0);

  const r = store.publish(school.id, teacher.id, '10月分');
  assert.equal(r.kind, 'new');
  assert.deepEqual(r.recipients, [g1.id]);
  const days = store.gakudoSchedule(g1.id, '2026-10-01', '2026-10-31')[0].days;
  assert.equal(days['2026-10-07'].grades[0], '14:45');
  assert.equal(days['2026-10-07'].version, 1);
});

test('承認されていない学童には届かない', () => {
  const { store, school, teacher, g1, g2 } = setup();
  approve(store, g1, school, teacher);
  store.requestLink(g2.id, school.id); // 承認待ちのまま
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  const r = store.publish(school.id, teacher.id);
  assert.deepEqual(r.recipients, [g1.id]);
  assert.equal(store.releasesForGakudo(g2.id).length, 0);
  assert.deepEqual(store.gakudoSchedule(g2.id, '2026-10-01', '2026-10-31'), []);
});

test('配信停止した学童には以後届かない', () => {
  const { store, school, teacher, g1 } = setup();
  approve(store, g1, school, teacher);
  const link = store.linksForSchool(school.id)[0];
  store.decideLink(school.id, link.id, false, teacher.id);
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  assert.deepEqual(store.publish(school.id, teacher.id).recipients, []);
});

test('修正公開では変更箇所だけが届き、版が上がる', () => {
  const { store, school, teacher, g1 } = setup();
  approve(store, g1, school, teacher);
  store.saveDrafts(school.id, { '2026-10-07': G('14:45', '14:45', '15:35'), '2026-10-08': G('14:45') });
  store.publish(school.id, teacher.id);

  store.saveDrafts(school.id, { '2026-10-07': G('14:45', '14:45', '13:30') });
  const r = store.publish(school.id, teacher.id, '校外学習のため');
  assert.equal(r.kind, 'revision');
  assert.deepEqual(r.changes, [{ date: '2026-10-07', grade: 3, before: '15:35', after: '13:30' }]);
  assert.equal(store.publishedBetween(school.id, '2026-10-07', '2026-10-07')['2026-10-07'].version, 2);
  assert.equal(store.publishedBetween(school.id, '2026-10-08', '2026-10-08')['2026-10-08'].version, 1);
});

test('公開済みと同じ内容に戻すと下書きは消える', () => {
  const { store, school, teacher } = setup();
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  store.publish(school.id, teacher.id);
  store.saveDrafts(school.id, { '2026-10-07': G('15:00') });
  assert.equal(store.pendingChanges(school.id).length, 1);
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  assert.equal(store.pendingChanges(school.id).length, 0);
  assert.throws(() => store.publish(school.id, teacher.id), /公開する変更がありません/);
});

test('下書きの破棄で公開中の内容に戻る', () => {
  const { store, school, teacher } = setup();
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  store.publish(school.id, teacher.id);
  store.saveDrafts(school.id, { '2026-10-07': G('15:00'), '2026-10-09': G('14:00') });
  store.discardDrafts(school.id);
  assert.equal(store.pendingChanges(school.id).length, 0);
  assert.deepEqual(Object.keys(store.schoolMonth(school.id, '2026-10')), ['2026-10-07']);
});

test('不正な時刻を含むと 1 件も保存されない', () => {
  const { store, school } = setup();
  assert.throws(() => store.saveDrafts(school.id, { '2026-10-07': G('14:45'), '2026-10-08': G('25:00') }), /時刻が正しくありません/);
  assert.deepEqual(store.schoolMonth(school.id, '2026-10'), {});
  assert.throws(() => store.saveDrafts(school.id, { '2026-13-01': G('14:45') }), /日付が正しくありません/);
});

test('入力ミスの疑い・過去日を検出する', () => {
  // 2026-10-05 09:00 JST
  const { store, school } = setup(new Date('2026-10-05T00:00:00Z'));
  const s = store.saveDrafts(school.id, {
    '2026-10-01': G('14:45'), // 過去
    '2026-10-05': G('09:15'), // 時刻が早すぎる
    '2026-10-20': G('14:45'),
  });
  assert.ok(s.warnings.some((w) => w.date === '2026-10-05' && /09:15/.test(w.message)));
  assert.ok(s.warnings.some((w) => w.date === '2026-10-01' && /過去/.test(w.message)));
  assert.ok(!s.warnings.some((w) => w.date === '2026-10-20'));
});

test('当日・翌日の「修正」だけを緊急扱いにする（新規公開は対象外）', () => {
  const { store, school, teacher } = setup(new Date('2026-10-05T00:00:00Z'));
  const first = store.saveDrafts(school.id, { '2026-10-05': G('14:45'), '2026-10-06': G('14:45'), '2026-10-20': G('14:45') });
  assert.deepEqual(first.urgentDates, []);
  assert.equal(store.publish(school.id, teacher.id).urgent, false);

  const s = store.saveDrafts(school.id, { '2026-10-05': G('13:30'), '2026-10-06': G('13:30'), '2026-10-20': G('13:30') });
  assert.deepEqual(s.urgentDates, ['2026-10-05', '2026-10-06']);
  const r = store.publish(school.id, teacher.id);
  assert.equal(r.urgent, true);
  assert.deepEqual(r.urgentDates, ['2026-10-05', '2026-10-06']);
});

test('確認状況：学校には学童ごとの確認時刻、学童には自分の分だけ', () => {
  const { store, school, teacher, g1, g2 } = setup();
  approve(store, g1, school, teacher);
  approve(store, g2, school, teacher);
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  const r = store.publish(school.id, teacher.id);
  store.acknowledge(r.id, g1.id);

  const forSchool = store.releasesForSchool(school.id)[0];
  assert.equal(forSchool.acks.find((a) => a.gakudoId === g1.id).ackedAt !== null, true);
  assert.equal(forSchool.acks.find((a) => a.gakudoId === g2.id).ackedAt, null);
  assert.equal(forSchool.publishedByName, '先生');

  const forG2 = store.releasesForGakudo(g2.id)[0];
  assert.equal(forG2.ackedAt, null);
  assert.equal(forG2.acks, undefined); // 他の学童の情報は見せない
});

test('届いていない学童は確認できない', () => {
  const { store, school, teacher, g1 } = setup();
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  const r = store.publish(school.id, teacher.id);
  assert.throws(() => store.acknowledge(r.id, g1.id), /見つかりません/);
});

test('保護者リンク：コードが違う・停止中・作り直し後の旧コードは見られない', () => {
  const { store, school, teacher } = setup();
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  store.publish(school.id, teacher.id);
  const { code } = store.parentLink(school.id);

  assert.equal(store.publicSchoolMonth(school.id, code, '2026-10').days['2026-10-07'].grades[0], '14:45');
  assert.throws(() => store.publicSchoolMonth(school.id, 'wrong', '2026-10'), /無効/);

  store.setParentLink(school.id, { enabled: false });
  assert.throws(() => store.publicSchoolMonth(school.id, code, '2026-10'), /無効/);
  store.setParentLink(school.id, { enabled: true });

  const { code: newCode } = store.setParentLink(school.id, { regenerate: true });
  assert.notEqual(newCode, code);
  assert.throws(() => store.publicSchoolMonth(school.id, code, '2026-10'), /無効/);
  assert.ok(store.publicSchoolMonth(school.id, newCode, '2026-10'));
});

test('保護者ページに下書きは出ない', () => {
  const { store, school, teacher } = setup();
  store.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  store.publish(school.id, teacher.id);
  store.saveDrafts(school.id, { '2026-10-07': G('10:00'), '2026-10-08': G('14:45') });
  const { code } = store.parentLink(school.id);
  const { days } = store.publicSchoolMonth(school.id, code, '2026-10');
  assert.deepEqual(Object.keys(days), ['2026-10-07']);
  assert.equal(days['2026-10-07'].grades[0], '14:45');
});

test('パスワード：短いものは拒否、変更後は新しいものだけ通る', () => {
  const { store, teacher } = setup();
  assert.throws(() => store.changePassword(teacher.id, 'password1', 'short'), /8文字以上/);
  assert.throws(() => store.changePassword(teacher.id, 'wrong-pass', 'newpassword'), /違います/);
  store.changePassword(teacher.id, 'password1', 'newpassword');
  assert.equal(store.verifyLogin('teacher', 'password1'), null);
  assert.equal(store.verifyLogin('teacher', 'newpassword').id, teacher.id);
  assert.ok(!('password' in teacher)); // 平文は保存しない
});

test('ファイルに保存して読み直せる', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  const a = Store.open(file);
  const school = a.createOrg({ type: 'school', name: 'A小', municipality: '沼田市' });
  a.saveDrafts(school.id, { '2026-10-07': G('14:45') });
  a.save();
  const b = Store.open(file);
  assert.equal(b.pendingChanges(school.id).length, 1);
});

// ---- 管理体制（連絡協議会・市町村・各校の管理職） ----

function governance() {
  const store = new Store(undefined, { now: () => new Date('2026-10-05T00:00:00Z') });
  const council = store.createOrg({ type: 'council', name: '協議会' });
  const cu = store.createUser({ orgId: council.id, loginId: 'council', name: '事務局', password: 'password1', role: 'manager' });
  const numataBoe = store.createOrg({ type: 'board', name: '沼田市教委', municipality: '沼田市', manages: ['school'] });
  const nb = store.createUser({ orgId: numataBoe.id, loginId: 'nboe', name: '沼田担当', password: 'password1', role: 'manager' });
  const numataKodomo = store.createOrg({ type: 'board', name: '沼田市学童担当', municipality: '沼田市', manages: ['gakudo'] });
  const nk = store.createUser({ orgId: numataKodomo.id, loginId: 'nkodomo', name: '学童担当', password: 'password1', role: 'manager' });
  const numataSchool = store.createOrg({ type: 'school', name: '沼田A小', municipality: '沼田市' });
  const principal = store.createUser({ orgId: numataSchool.id, loginId: 'kyoto', name: '教頭', password: 'password1', role: 'manager' });
  const staff = store.createUser({ orgId: numataSchool.id, loginId: 'kyomu', name: '教務', password: 'password1', role: 'staff' });
  const minakamiSchool = store.createOrg({ type: 'school', name: 'みなかみB小', municipality: 'みなかみ町' });
  const gakudo = store.createOrg({ type: 'gakudo', name: '沼田学童', municipality: '沼田市' });
  return { store, council, cu, numataBoe, nb, numataKodomo, nk, numataSchool, principal, staff, minakamiSchool, gakudo };
}

test('市町村は自分の市町村の、担当する種類の組織だけを管理できる', () => {
  const g = governance();
  const { store } = g;
  assert.equal(store.canManageOrg(g.nb, g.numataSchool), true);
  assert.equal(store.canManageOrg(g.nb, g.minakamiSchool), false); // 他の市町村
  assert.equal(store.canManageOrg(g.nb, g.gakudo), false); // 学童は学童担当課の管轄
  assert.equal(store.canManageOrg(g.nk, g.gakudo), true);
  assert.equal(store.canManageOrg(g.cu, g.minakamiSchool), true); // 協議会は全体
  // 市町村が作る組織は自分の市町村に固定される
  const created = store.createOrgAs(g.nb, { type: 'school', name: '沼田C小', municipality: 'みなかみ町' });
  assert.equal(created.municipality, '沼田市');
  assert.throws(() => store.createOrgAs(g.nb, { type: 'gakudo', name: 'X', municipality: '沼田市' }), /権限がありません/);
  assert.throws(() => store.createOrgAs(g.cu, { type: 'council', name: 'X' }), /作成できません/);
});

test('学校の管理職は自校の職員だけを管理でき、一般職員は管理できない', () => {
  const g = governance();
  const { store } = g;
  assert.equal(store.canManageOrg(g.principal, g.numataSchool), true);
  assert.equal(store.canManageOrg(g.principal, g.minakamiSchool), false);
  assert.equal(store.canManageOrg(g.staff, g.numataSchool), false);
  const newcomer = store.createUserAs(g.principal, { orgId: g.numataSchool.id, loginId: 'newteacher', name: '新任', password: 'password1' });
  assert.equal(newcomer.role, 'staff');
  assert.throws(() => store.createUserAs(g.staff, { orgId: g.numataSchool.id, loginId: 'x123', name: 'x', password: 'password1' }), /権限がありません/);
});

test('停止したアカウントはログインできず、再開すれば戻る。自分は停止できない', () => {
  const g = governance();
  const { store } = g;
  store.setUserDisabledAs(g.principal, g.staff.id, true);
  assert.equal(store.verifyLogin('kyomu', 'password1'), null);
  store.setUserDisabledAs(g.principal, g.staff.id, false);
  assert.ok(store.verifyLogin('kyomu', 'password1'));
  assert.throws(() => store.setUserDisabledAs(g.principal, g.principal.id, true), /自分自身/);
});

test('2段階認証：正しいコードで有効化、同じコードの使い回しは不可', () => {
  const totp = require('../lib/totp');
  const g = governance();
  const { store } = g;
  assert.equal(store.mfaRequired(g.cu), true);
  assert.equal(store.mfaRequired(g.principal), false);
  const { secret, uri } = store.startMfaSetup(g.cu.id);
  assert.match(uri, /^otpauth:\/\/totp\//);
  const step = totp.currentStep(store.now().getTime());
  assert.throws(() => store.enableMfa(g.cu.id, '000000'.replace(/0/g, (_, i) => String((Number(totp.codeAt(secret, step)[i]) + 1) % 10))), /確認コードが違います/);
  store.enableMfa(g.cu.id, totp.codeAt(secret, step));
  assert.equal(store.verifyMfa(g.cu.id, totp.codeAt(secret, step)), false); // 使用済み
  assert.equal(store.verifyMfa(g.cu.id, totp.codeAt(secret, step + 1)), true);
  store.resetMfaAs(g.cu, g.cu.id);
  assert.equal(store.user(g.cu.id).mfa, null);
});

test('操作履歴は協議会＝全体、市町村＝自分の市町村、管理職＝自組織だけ見える', () => {
  const g = governance();
  const { store } = g;
  store.audit(g.principal, '下校時刻の公開');
  const other = store.createUser({ orgId: g.minakamiSchool.id, loginId: 'mina', name: 'みなかみ教頭', password: 'password1', role: 'manager' });
  store.audit(other, '下校時刻の公開');
  assert.equal(store.auditFor(g.cu).length, 2);
  assert.deepEqual(store.auditFor(g.nb).map((a) => a.orgName), ['沼田A小']);
  assert.deepEqual(store.auditFor(g.principal).map((a) => a.orgName), ['沼田A小']);
  assert.throws(() => store.auditFor(g.staff), /権限がありません/);
});

test('全体設定とデータ削除は協議会だけ', () => {
  const g = governance();
  const { store } = g;
  assert.throws(() => store.updateSettingsAs(g.nb, { mfaRequired: { school: true } }), /連絡協議会だけ/);
  assert.equal(store.updateSettingsAs(g.cu, { mfaRequired: { school: true } }).mfaRequired.school, true);
  assert.equal(store.mfaRequired(g.principal), true);

  const t = g.principal;
  store.saveDrafts(g.numataSchool.id, { '2025-03-10': G('14:45'), '2026-10-07': G('14:45') });
  store.publish(g.numataSchool.id, t.id);
  assert.throws(() => store.purgeBeforeAs(g.nb, '2026-04-01'), /連絡協議会だけ/);
  const r = store.purgeBeforeAs(g.cu, '2026-04-01');
  assert.equal(r.days, 1);
  assert.deepEqual(Object.keys(store.schoolMonth(g.numataSchool.id, '2026-10')), ['2026-10-07']);
});
