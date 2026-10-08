// ==UserScript==
// @name         네이버 예약 빈자리 감시·선점
// @namespace    https://soomini.github.io/
// @version      1.0.0
// @description  네이버 예약 상품 페이지를 주기적으로 새로고침하여 빈 시간이 생기면 자동으로 선택하고 '다음' 단계로 진입한 뒤 알림을 보냅니다.
// @match        https://booking.naver.com/booking/*/bizes/*/items/*
// @match        https://m.booking.naver.com/booking/*/bizes/*/items/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
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
    intervalSec: 30,         // 새로고침 간격(초). 서버 부하·차단 방지를 위해 최소 10초
    preferredTimes: '',      // 선호 시간(쉼표 구분, 예: "10:00, 14:30"). 비우면 아무 시간이나
    preferredOnly: false,    // true면 선호 시간 외에는 선택하지 않음
    autoNext: true,          // 시간 선택 후 '다음' 버튼까지 자동 클릭
    slotSelector: '',        // 자동 감지가 맞지 않을 때 직접 지정하는 시간 버튼 CSS 선택자
    stopAt: '',              // 감시 종료 시각(예: "2026-10-29T23:59"). 비우면 무제한
  };
  const MIN_INTERVAL = 10;
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

  function findNextButton() {
    return [...document.querySelectorAll('button, a[role="button"], a')]
      .filter((el) => !panel.contains(el))
      .find((el) => /^(다음|다음단계|다음 단계|예약하기|선택완료|선택 완료)$/.test(textOf(el)) && !isDisabled(el));
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

  function alertUser(msg) {
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
    <label><input id="nbw-autonext" type="checkbox"> '다음' 버튼까지 자동 진행</label><br>
    <label>종료 시각 <input id="nbw-stopat" type="datetime-local" style="width:170px"></label><br>
    <details><summary>고급: 시간 버튼 선택자</summary>
      <input id="nbw-selector" placeholder="비우면 자동 감지" style="width:100%"></details>
    <div style="margin-top:6px;display:flex;gap:6px">
      <button id="nbw-toggle" style="flex:1"></button>
      <button id="nbw-test">감지 테스트</button>
    </div>
    <div id="nbw-log" style="margin-top:6px;max-height:110px;overflow:auto;color:#555"></div>`;
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
  $('nbw-interval').onchange = (e) => save('intervalSec', Math.max(MIN_INTERVAL, Number(e.target.value) || DEFAULTS.intervalSec));
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
    const next = findNextButton();
    log(next ? `'다음' 버튼 감지: "${textOf(next)}"` : "'다음' 버튼 미감지(시간 선택 후 나타날 수 있음)");
  };

  // ---------------------------------------------------------------------------
  // 감시 루프 (페이지 로드마다 1회 검사 후 새로고침 예약)
  // ---------------------------------------------------------------------------
  async function run() {
    if (!running()) return;

    if (cfg.stopAt && Date.now() > new Date(cfg.stopAt).getTime()) {
      save('enabled', false);
      renderState();
      log('종료 시각이 지나 감시를 멈췄습니다.');
      return;
    }

    const rendered = await waitForRender();
    if (!rendered) log('시간 목록을 찾지 못했습니다. 감지 테스트로 확인하거나 선택자를 지정하십시오.');

    const slots = collectSlots();
    const pick = pickSlot(slots);

    if (pick) {
      // 중복 진입 방지를 위해 먼저 정지 상태로 전환합니다.
      save('enabled', false);
      renderState();
      pick.el.scrollIntoView({ block: 'center' });
      pick.el.click();
      log(`빈자리 발견: ${pick.time} 선택`);

      if (cfg.autoNext) {
        for (let i = 0; i < 20; i++) {
          await sleep(250);
          const next = findNextButton();
          if (next) {
            next.click();
            log(`"${textOf(next)}" 클릭`);
            break;
          }
        }
      }
      alertUser(`${pick.time} 빈자리를 선택했습니다. 즉시 예약을 완료하십시오.`);
      return;
    }

    const wait = (Math.max(MIN_INTERVAL, cfg.intervalSec) + Math.random() * 5) * 1000;
    log(`빈자리 없음 (후보 ${slots.length}개). ${Math.round(wait / 1000)}초 후 새로고침`);
    reloadTimer = setTimeout(() => location.reload(), wait);
  }

  run();
})();
