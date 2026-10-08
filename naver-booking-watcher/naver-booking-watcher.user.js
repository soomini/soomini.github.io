// ==UserScript==
// @name         네이버 예약 빈자리 감시·선점
// @namespace    https://soomini.github.io/
// @version      1.4.0
// @description  네이버 예약 상품 페이지를 주기적으로 새로고침하여 빈 시간이 생기면 자동으로 선택하고, 좌석 선택 화면에서 빈 좌석까지 고른 뒤 알림을 보냅니다.
// @match        https://booking.naver.com/booking/*/bizes/*/items/*
// @match        https://m.booking.naver.com/booking/*/bizes/*/items/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @connect      api.telegram.org
// @run-at       document-idle
// @downloadURL  https://soomini.github.io/naver-booking-watcher/naver-booking-watcher.user.js
// @updateURL    https://soomini.github.io/naver-booking-watcher/naver-booking-watcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    enabled: false,          // 감시 실행 여부
    intervalSec: 30,         // 새로고침 간격(초). 최소 5초
    preferredTimes: '',      // 선호 시간(쉼표 구분, 예: "10:00, 14:30"). 비우면 아무 시간이나
    preferredOnly: false,    // true면 선호 시간 외에는 선택하지 않음
    autoNext: true,          // 시간 선택 후 '좌석 선택하기'(또는 '다음') 버튼까지 자동 클릭
    slotSelector: '',        // 자동 감지가 맞지 않을 때 직접 지정하는 시간 버튼 CSS 선택자
    autoSeat: true,          // 좌석 선택 화면에서 빈 좌석 자동 선택 후 '적용' 클릭
    seatSelector: '',        // 자동 감지가 맞지 않을 때 직접 지정하는 '빈 좌석' CSS 선택자
    ntfyTopic: '',           // 휴대폰 알림: ntfy 주제 이름
    tgToken: '',             // 휴대폰 알림: 텔레그램 봇 토큰
    tgChatId: '',            // 휴대폰 알림: 텔레그램 채팅 ID(비우면 알림 테스트 시 자동 조회)
    stopAt: '',              // 감시 종료 시각(예: "2026-10-29T23:59"). 비우면 무제한
  };
  const MIN_INTERVAL = 5;
  const SAFE_INTERVAL = 10;
  const RENDER_TIMEOUT_MS = 15000;

  const cfg = {};
  for (const [k, v] of Object.entries(DEFAULTS)) cfg[k] = GM_getValue(k, v);
  const save = (k, v) => { cfg[k] = v; GM_setValue(k, v); };

  // 감시 대상 URL을 고정하여, 다른 상품 페이지에서 오작동하지 않도록 합니다.
  const pageKey = location.pathname + location.search;
  const targetKey = GM_getValue('targetKey', '');

  // ---------------------------------------------------------------------------
  // 유틸
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const TIME_RE = /^(오전|오후)?\s*(\d{1,2}):(\d{2})/;
  const DISABLED_CLASS_RE = /disabled|unselectable|unavailable|soldout|sold_out|dimmed|closed|is_off|\boff\b/i;
  const DISABLED_TEXT_RE = /마감|매진|불가|종료|대기/;

  function to24h(text) {
    const m = text.match(TIME_RE);
    if (!m) return null;
    let h = parseInt(m[2], 10);
    if (m[1] === '오후' && h < 12) h += 12;
    if (m[1] === '오전' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + m[3];
  }

  function isDisabled(el) {
    for (let n = el, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
      if (n.disabled || n.getAttribute('aria-disabled') === 'true') return true;
      if (DISABLED_CLASS_RE.test(n.getAttribute('class') || '')) return true;
    }
    if (DISABLED_TEXT_RE.test(textOf(el))) return true;
    const style = getComputedStyle(el);
    return style.pointerEvents === 'none' || style.visibility === 'hidden' || style.display === 'none';
  }

  // 페이지 내 시간 슬롯 후보를 수집합니다.
  function collectSlots() {
    let nodes;
    if (cfg.slotSelector.trim()) {
      nodes = [...document.querySelectorAll(cfg.slotSelector)];
    } else {
      nodes = [...document.querySelectorAll('button, a[role="button"], [role="button"], [role="option"], li > a')]
        .filter((el) => TIME_RE.test(textOf(el)));
    }
    return nodes
      .filter((el) => !panel.contains(el))
      .map((el) => ({ el, time: to24h(textOf(el)) || textOf(el), available: !isDisabled(el) }));
  }

  function pickSlot(slots) {
    const available = slots.filter((s) => s.available);
    if (!available.length) return null;
    const prefs = cfg.preferredTimes.split(',').map((s) => s.trim()).filter(Boolean)
      .map((p) => to24h(p) || p);
    for (const p of prefs) {
      const hit = available.find((s) => s.time === p);
      if (hit) return hit;
    }
    return cfg.preferredOnly && prefs.length ? null : available[0];
  }

  // 실제 사용자 클릭처럼 포인터·마우스 이벤트를 순서대로 발생시킵니다.
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    }
    el.click();
  }

  // 문구가 일치하는 진행 버튼을 찾습니다. button 태그가 아닌 div·span 버튼도 포함하고,
  // 활성 여부는 버튼 자신의 상태만으로 판단합니다(상위 요소의 클래스는 보지 않음).
  function findActionButton(re) {
    const matches = [...document.querySelectorAll('button, a, [role="button"], div, span, p')]
      .filter((el) => !panel.contains(el) && re.test(textOf(el)));
    // 같은 문구를 가진 요소가 중첩된 경우 가장 안쪽 요소를 기준으로 합니다.
    const leaves = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
    const found = leaves.map((leaf) => {
      const el = leaf.closest('button, a, [role="button"]') ||
        leaf.closest('[class*="btn" i], [class*="button" i]') || leaf;
      // 문구 요소부터 버튼 요소까지 사이에 비활성 표시가 있는지 확인합니다.
      let disabled = false;
      for (let n = leaf; n; n = n.parentElement) {
        if (n.disabled === true || n.getAttribute('aria-disabled') === 'true' ||
          /disabled|dimmed/i.test(n.getAttribute('class') || '') ||
          getComputedStyle(n).pointerEvents === 'none') disabled = true;
        if (n === el) break;
      }
      return { el, disabled };
    });
    return found.find((b) => !b.disabled) || found[0] || null;
  }

  const NEXT_RE = /^(다음|다음단계|다음 단계|예약하기|좌석 ?선택하기|좌석선택|예매하기|선택완료|선택 완료)$/;
  const APPLY_RE = /^(적용|선택 ?완료|좌석 ?선택 ?완료|다음|예매하기)$/;

  // 버튼이 활성화될 때까지 기다렸다가 누릅니다. 끝까지 비활성으로 보여도 마지막에 한 번 눌러 봅니다.
  async function clickWhenReady(re, label, timeoutMs = 10000) {
    const start = Date.now();
    let b = null;
    while (Date.now() - start < timeoutMs) {
      b = findActionButton(re);
      if (b && !b.disabled) {
        realClick(b.el);
        log(`"${textOf(b.el)}" 클릭`);
        return true;
      }
      await sleep(200);
    }
    if (b) {
      realClick(b.el);
      log(`"${textOf(b.el)}"이(가) 비활성으로 보였지만 클릭을 시도했습니다. [${b.el.tagName.toLowerCase()} class="${b.el.getAttribute('class') || ''}"]`);
      return true;
    }
    log(`${label} 버튼을 찾지 못했습니다. 직접 누르십시오.`);
    return false;
  }

  // ---------------------------------------------------------------------------
  // 좌석 선택 화면
  // ---------------------------------------------------------------------------
  const SEAT_CANDIDATE_SEL = '[class*="seat" i], [data-seat], [data-seat-id], [data-seatid], [aria-label*="석"]';
  const SEAT_TAKEN_RE = /sold|reserved|occupied|taken|unable|impossible|blocked|selected|disabled|unavailable|dimmed/i;

  // 좌석 하나하나에 해당하는 작은 요소만 남깁니다(범례·컨테이너 제외).
  function collectSeats() {
    if (cfg.seatSelector.trim()) {
      return [...document.querySelectorAll(cfg.seatSelector)]
        .filter((el) => !panel.contains(el))
        .map((el) => ({ el, available: !isDisabled(el) }));
    }
    return [...document.querySelectorAll(SEAT_CANDIDATE_SEL)]
      .filter((el) => !panel.contains(el) && !el.querySelector(SEAT_CANDIDATE_SEL))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.width < 80 && r.height < 80 && textOf(el).length <= 6;
      })
      .map((el) => {
        const cls = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('aria-label') || '');
        return { el, available: !isDisabled(el) && !SEAT_TAKEN_RE.test(cls) };
      });
  }

  async function seatPhase() {
    GM_setValue('seatPhaseUntil', 0);
    log('좌석 화면 대기 중…');
    let seats = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      seats = collectSeats();
      if (seats.some((s) => s.available)) break;
    }
    const seat = seats.find((s) => s.available);
    if (!seat) {
      log(`빈 좌석을 자동으로 찾지 못했습니다(후보 ${seats.length}개). 직접 선택하십시오.`);
      return false;
    }
    seat.el.scrollIntoView({ block: 'center' });
    realClick(seat.el);
    log('빈 좌석 클릭');
    return clickWhenReady(APPLY_RE, "'적용'");
  }

  // 페이지(SPA)가 시간 목록을 렌더링할 때까지 기다립니다.
  async function waitForRender() {
    const start = Date.now();
    while (Date.now() - start < RENDER_TIMEOUT_MS) {
      if (collectSlots().length) return true;
      if (/예약 가능한 (시간|날짜)이 없|선택 가능한 시간이 없/.test(document.body.innerText)) return true;
      await sleep(500);
    }
    return false;
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35, 0.7].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.value = 0.2;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.25);
      });
    } catch (e) { /* 자동재생 정책으로 차단될 수 있음 */ }
  }

  // 휴대폰 알림. 네이버 페이지의 보안 정책(CSP)을 피하기 위해 GM_xmlhttpRequest를 사용합니다.
  function request(opts) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      ...opts,
      onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error('HTTP ' + r.status))),
      onerror: () => reject(new Error('네트워크 오류')),
      ontimeout: () => reject(new Error('시간 초과')),
      timeout: 10000,
    }));
  }

  async function findTelegramChatId() {
    // 이전의 빈 응답이 브라우저 캐시에서 재사용되지 않도록 매번 새로 조회합니다.
    const r = await request({ method: 'GET', nocache: true, url: `https://api.telegram.org/bot${cfg.tgToken.trim()}/getUpdates?t=${Date.now()}` });
    const updates = JSON.parse(r.responseText).result || [];
    const last = updates.reverse().map((u) => u.message || u.edited_message || u.my_chat_member).find((m) => m && m.chat);
    if (!last) throw new Error(`봇에게 먼저 아무 메시지나 보내십시오 (수신 기록 ${updates.length}건)`);
    save('tgChatId', String(last.chat.id));
    return cfg.tgChatId;
  }

  async function pushRemote(msg) {
    const text = msg + '\n' + location.href;
    const jobs = [];
    if (cfg.ntfyTopic.trim()) {
      jobs.push(request({
        method: 'POST',
        url: 'https://ntfy.sh/',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ topic: cfg.ntfyTopic.trim(), title: '네이버 예약 빈자리', message: text, priority: 5, tags: ['rotating_light'] }),
      }).then(() => 'ntfy'));
    }
    if (cfg.tgToken.trim()) {
      jobs.push((async () => {
        const chatId = cfg.tgChatId.trim() || await findTelegramChatId();
        await request({
          method: 'POST',
          url: `https://api.telegram.org/bot${cfg.tgToken.trim()}/sendMessage`,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ chat_id: chatId, text: '🚨 ' + text }),
        });
        return '텔레그램';
      })());
    }
    if (!jobs.length) return;
    for (const r of await Promise.allSettled(jobs)) {
      log(r.status === 'fulfilled' ? `${r.value} 알림 전송 완료` : `휴대폰 알림 실패: ${r.reason.message}`);
    }
  }

  function alertUser(msg) {
    pushRemote(msg);
    GM_notification({ title: '네이버 예약 빈자리', text: msg, timeout: 0, onclick: () => window.focus() });
    beep();
    let on = false;
    const orig = document.title;
    setInterval(() => { document.title = (on = !on) ? '★ 빈자리 선점 ★' : orig; }, 800);
  }

  // ---------------------------------------------------------------------------
  // 패널 UI
  // ---------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:280px;' +
    'background:#fff;color:#222;border:2px solid #03c75a;border-radius:10px;padding:10px;' +
    'font:12px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)';
  panel.innerHTML = `
    <div style="font-weight:bold;margin-bottom:6px">빈자리 감시 <span id="nbw-state"></span></div>
    <label>새로고침 간격(초) <input id="nbw-interval" type="number" min="${MIN_INTERVAL}" style="width:60px"></label><br>
    <label>선호 시간 <input id="nbw-prefs" placeholder="예: 10:00, 14:30" style="width:150px"></label><br>
    <label><input id="nbw-prefonly" type="checkbox"> 선호 시간만 선택</label><br>
    <label><input id="nbw-autonext" type="checkbox"> '좌석 선택하기' 버튼까지 자동 진행</label><br>
    <label>종료 시각 <input id="nbw-stopat" type="datetime-local" style="width:170px"></label><br>
    <label><input id="nbw-autoseat" type="checkbox"> 빈 좌석 자동 선택 후 '적용'</label><br>
    <details><summary>고급: 선택자 직접 지정</summary>
      시간 버튼 <input id="nbw-selector" placeholder="비우면 자동 감지" style="width:100%">
      빈 좌석 <input id="nbw-seatselector" placeholder="비우면 자동 감지" style="width:100%"></details>
    <details><summary>휴대폰 알림</summary>
      ntfy 주제 <input id="nbw-ntfy" placeholder="예: soomin-nfesta-7351" style="width:100%">
      텔레그램 봇 토큰 <input id="nbw-tgtoken" placeholder="123456:ABC..." style="width:100%">
      텔레그램 채팅 ID <input id="nbw-tgchat" placeholder="비우면 자동 조회" style="width:100%">
      <button id="nbw-pushtest" style="margin-top:4px">알림 테스트</button></details>
    <div style="margin-top:6px;display:flex;gap:6px">
      <button id="nbw-toggle" style="flex:1"></button>
      <button id="nbw-test">감지 테스트</button>
    </div>
    <div id="nbw-log" style="margin-top:6px;max-height:110px;overflow:auto;color:#555"></div>`;
  // 네이버 페이지의 CSS 초기화로 입력칸·체크박스가 보이지 않는 문제를 막습니다.
  const style = document.createElement('style');
  style.textContent = `
    #nbw-panel input, #nbw-panel button { all: revert; font: 12px sans-serif; }
    #nbw-panel input:not([type=checkbox]) { border: 1px solid #bbb; border-radius: 4px; padding: 2px 4px; margin: 2px 0; background: #fff; color: #222; }
    #nbw-panel input[type=checkbox] { appearance: auto; width: 14px; height: 14px; vertical-align: middle; margin: 0 4px 0 0; }
    #nbw-panel button { border: 1px solid #03c75a; border-radius: 6px; padding: 5px 8px; background: #fff; color: #03c75a; cursor: pointer; }
    #nbw-panel #nbw-toggle { background: #03c75a; color: #fff; font-weight: bold; }`;
  document.head.appendChild(style);
  panel.id = 'nbw-panel';
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector('#' + id);
  const log = (msg) => {
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + ' ' + msg;
    $('nbw-log').prepend(line);
    console.log('[빈자리 감시]', msg);
  };

  $('nbw-interval').value = cfg.intervalSec;
  $('nbw-prefs').value = cfg.preferredTimes;
  $('nbw-prefonly').checked = cfg.preferredOnly;
  $('nbw-autonext').checked = cfg.autoNext;
  $('nbw-stopat').value = cfg.stopAt;
  $('nbw-selector').value = cfg.slotSelector;
  $('nbw-autoseat').checked = cfg.autoSeat;
  $('nbw-seatselector').value = cfg.seatSelector;
  $('nbw-autoseat').onchange = (e) => save('autoSeat', e.target.checked);
  $('nbw-seatselector').onchange = (e) => save('seatSelector', e.target.value);
  $('nbw-ntfy').value = cfg.ntfyTopic;
  $('nbw-tgtoken').value = cfg.tgToken;
  $('nbw-tgchat').value = cfg.tgChatId;
  $('nbw-ntfy').onchange = (e) => save('ntfyTopic', e.target.value.trim());
  $('nbw-tgtoken').onchange = (e) => { save('tgToken', e.target.value.trim()); save('tgChatId', ''); $('nbw-tgchat').value = ''; };
  $('nbw-tgchat').onchange = (e) => save('tgChatId', e.target.value.trim());
  $('nbw-pushtest').onclick = async () => {
    // 입력 직후 바로 누른 경우에도 값이 반영되도록 다시 저장합니다.
    save('ntfyTopic', $('nbw-ntfy').value.trim());
    save('tgToken', $('nbw-tgtoken').value.trim());
    save('tgChatId', $('nbw-tgchat').value.trim());
    if (!cfg.ntfyTopic && !cfg.tgToken) return log('ntfy 주제나 텔레그램 봇 토큰을 먼저 입력하십시오.');
    await pushRemote('알림 테스트입니다.');
    $('nbw-tgchat').value = cfg.tgChatId;
  };
  $('nbw-interval').onchange = (e) => {
    const v = Math.max(MIN_INTERVAL, Number(e.target.value) || DEFAULTS.intervalSec);
    e.target.value = v;
    save('intervalSec', v);
    if (v < SAFE_INTERVAL) log(`간격 ${v}초: 접속 제한(일시 차단·보안문자)이 걸릴 가능성이 커집니다.`);
  };
  $('nbw-prefs').onchange = (e) => save('preferredTimes', e.target.value);
  $('nbw-prefonly').onchange = (e) => save('preferredOnly', e.target.checked);
  $('nbw-autonext').onchange = (e) => save('autoNext', e.target.checked);
  $('nbw-stopat').onchange = (e) => save('stopAt', e.target.value);
  $('nbw-selector').onchange = (e) => save('slotSelector', e.target.value);

  const running = () => cfg.enabled && targetKey === pageKey;
  function renderState() {
    $('nbw-state').textContent = running() ? '● 실행 중' : '○ 정지';
    $('nbw-state').style.color = running() ? '#03c75a' : '#999';
    $('nbw-toggle').textContent = running() ? '정지' : '이 페이지 감시 시작';
  }
  renderState();

  let reloadTimer = null;
  $('nbw-toggle').onclick = () => {
    if (running()) {
      save('enabled', false);
      clearTimeout(reloadTimer);
      log('정지했습니다.');
    } else {
      GM_setValue('targetKey', pageKey);
      save('enabled', true);
      // 알림 권한·오디오 재생 권한을 사용자 클릭 시점에 미리 확보합니다.
      if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
      beep();
      location.reload();
    }
    renderState();
  };

  $('nbw-test').onclick = () => {
    const slots = collectSlots();
    slots.forEach((s) => { s.el.style.outline = s.available ? '3px solid #03c75a' : '3px dashed #e33'; });
    const pick = pickSlot(slots);
    log(`감지 ${slots.length}개 (가능 ${slots.filter((s) => s.available).length}개)` +
      (pick ? `, 선택 예정: ${pick.time}` : ', 선택 대상 없음'));
    const next = findActionButton(NEXT_RE);
    log(next ? `진행 버튼 감지: "${textOf(next.el)}" (${next.disabled ? '현재 비활성' : '활성'}) [${next.el.tagName.toLowerCase()} class="${next.el.getAttribute('class') || ''}"]`
      : "진행 버튼('좌석 선택하기' 등) 미감지");
    const seats = collectSeats();
    if (seats.length) {
      seats.forEach((s) => { s.el.style.outline = s.available ? '2px solid #03c75a' : '1px dashed #e33'; });
      log(`좌석 감지 ${seats.length}개 (빈 좌석 ${seats.filter((s) => s.available).length}개)`);
    }
  };

  // ---------------------------------------------------------------------------
  // 감시 루프 (페이지 로드마다 1회 검사 후 새로고침 예약)
  // ---------------------------------------------------------------------------
  async function run() {
    // 좌석 화면이 새 페이지로 열린 경우 이어서 좌석을 선택합니다.
    if (GM_getValue('seatPhaseUntil', 0) > Date.now()) {
      const ok = await seatPhase();
      alertUser(ok ? '빈 좌석을 선택했습니다. 즉시 결제를 완료하십시오.' : '좌석 화면에 진입했습니다. 좌석을 직접 선택하십시오.');
      return;
    }
    if (!running()) return;

    if (cfg.stopAt && Date.now() > new Date(cfg.stopAt).getTime()) {
      save('enabled', false);
      renderState();
      log('종료 시각이 지나 감시를 멈췄습니다.');
      return;
    }

    const rendered = await waitForRender();
    if (!rendered) {
      log('시간 목록을 찾지 못했습니다. 감지 테스트로 확인하거나 선택자를 지정하십시오.');
      // 로그아웃·접속 제한·보안문자 등으로 감시가 헛돌고 있을 가능성을 한 번 알립니다.
      const fails = GM_getValue('renderFails', 0) + 1;
      GM_setValue('renderFails', fails);
      if (fails === 3) pushRemote('3회 연속 예약 화면을 읽지 못했습니다. 로그인·접속 제한 여부를 확인하십시오.');
    } else {
      GM_setValue('renderFails', 0);
    }

    const slots = collectSlots();
    const pick = pickSlot(slots);

    if (pick) {
      // 중복 진입 방지를 위해 먼저 정지 상태로 전환합니다.
      save('enabled', false);
      renderState();
      pick.el.scrollIntoView({ block: 'center' });
      realClick(pick.el);
      log(`빈자리 발견: ${pick.time} 선택`);

      let seatResult = null;
      if (cfg.autoNext) {
        // 좌석 화면이 새 페이지로 열려도 이어서 처리하도록 표시해 둡니다.
        if (cfg.autoSeat) GM_setValue('seatPhaseUntil', Date.now() + 40000);
        const clicked = await clickWhenReady(NEXT_RE, "'좌석 선택하기'");
        if (clicked && cfg.autoSeat) seatResult = await seatPhase();
        else GM_setValue('seatPhaseUntil', 0);
      }
      alertUser(seatResult ? `${pick.time} 빈 좌석을 선택했습니다. 즉시 결제를 완료하십시오.`
        : `${pick.time} 빈자리를 선택했습니다. 즉시 예약을 완료하십시오.`);
      return;
    }

    const base = Math.max(MIN_INTERVAL, cfg.intervalSec);
    const wait = (base + Math.random() * Math.max(2, base * 0.5)) * 1000;
    log(`빈자리 없음 (후보 ${slots.length}개). ${Math.round(wait / 1000)}초 후 새로고침`);
    reloadTimer = setTimeout(() => location.reload(), wait);
  }

  run();
})();
