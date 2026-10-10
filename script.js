/* ==========================================================
   Рядом — логика приложения
   Карта (Leaflet + OpenStreetMap), GPS, пешие маршруты,
   голос (SpeechSynthesis), Рядом-Бот, Домой, Звонок, СОС.
   ========================================================== */
(() => {
  'use strict';

  /* ---------- Настройки и константы ---------- */
  const DEFAULT_CENTER = [51.1694, 71.4491];           // запасной центр карты (Астана)
  const STORE_KEY = 'ryadom.v1';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const ROUTE_API = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/'; // пешеходный профиль OSRM
  const NET_MSG = 'Нет связи с интернетом. Проверьте Wi-Fi или мобильную сеть и попробуйте ещё раз.';
  const FONT_SIZES = [20, 23, 26];                      // шаги размера текста, px

  // Что умеет искать бот по ключевым словам
  const PLACES = [
    { re: /аптек|лекарств/,                       q: 'аптека',       title: 'аптеку' },
    { re: /больниц|поликлиник|врач|госпитал/,     q: 'поликлиника',  title: 'поликлинику' },
    { re: /магазин|продукт|супермаркет|хлеб/,     q: 'магазин',      title: 'магазин' },
    { re: /остановк|автобус|трамвай/,             q: 'остановка',    title: 'остановку' },
    { re: /туалет/,                               q: 'туалет',       title: 'туалет' },
    { re: /банкомат|банк\b|банк$/,                q: 'банк',         title: 'банк' },
    { re: /почт/,                                 q: 'почта',        title: 'почту' },
    { re: /парк|сквер|погулять/,                  q: 'парк',         title: 'парк' },
    { re: /кафе|поесть|столов|ресторан/,          q: 'кафе',         title: 'кафе' },
  ];

  /* ---------- Элементы страницы ---------- */
  const el = {};
  [
    'topbar', 'fontBtn', 'voiceBtn', 'searchForm', 'searchInput', 'panel', 'panelHandle', 'status',
    'routeCard', 'routeTitle', 'routeStats', 'routeNote', 'routeSteps', 'routeSpeak', 'routeClear',
    'homeBtn', 'callBtn', 'whereBtn', 'sosBtn', 'settingsBtn',
    'chat', 'botForm', 'botInput', 'micBtn',
    'settingsOverlay', 'settingsForm', 'homeInput', 'useHereBtn', 'relNameInput', 'relPhoneInput',
    'settingsHint', 'settingsClose',
    'callOverlay', 'callName', 'callPhone', 'callStatus', 'callGo', 'callEnd',
    'sosOverlay', 'sosAddress', 'sosCall103', 'sosCall112', 'sosSms', 'sosMute', 'sosCancel',
  ].forEach((id) => { el[id] = document.getElementById(id); });

  /* ---------- Состояние ---------- */
  const defaults = { homeAddress: '', homeCoords: null, relName: '', relPhone: '', voiceOn: true, fontStep: 0 };

  const state = {
    map: null,
    userPos: null,        // {lat, lng, accuracy, manual?}
    userMarker: null,
    accCircle: null,
    routeGroup: null,
    currentRoute: null,
    manual: false,        // ждём, пока человек сам ткнёт в карту
    pending: null,        // действие, которое выполним после ручного выбора места
    firstFix: true,
    geoDenied: false,
    settings: loadSettings(),
  };

  const wideMQ = window.matchMedia('(min-width: 900px)');

  /* ---------- Хранилище ---------- */
  function loadSettings() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
    catch { return { ...defaults }; }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch { /* ничего страшного */ }
  }

  /* ---------- Мелкие помощники ---------- */
  const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

  function plural(n, [one, few, many]) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function fmtDist(m, spoken = false) {
    if (m < 1000) {
      const v = Math.max(10, Math.round(m / 10) * 10);
      return spoken ? `${v} ${plural(v, ['метр', 'метра', 'метров'])}` : `${v} м`;
    }
    const km = m / 1000;
    const frac = Math.round(km * 10) % 10 !== 0;
    const txt = km.toFixed(1).replace('.', ',');
    if (!spoken) return `${txt} км`;
    return frac ? `${txt} километра` : `${Math.round(km)} ${plural(Math.round(km), ['километр', 'километра', 'километров'])}`;
  }

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function fetchJson(url, timeout = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /* ---------- Сообщение-подсказка над кнопками ---------- */
  let statusTimer;
  function setStatus(text, kind = 'info') {
    clearTimeout(statusTimer);
    if (!text) { el.status.hidden = true; el.status.textContent = ''; return; }
    el.status.hidden = false;
    el.status.className = 'status status--' + kind;
    el.status.textContent = text;
    if (kind === 'ok' || kind === 'info') statusTimer = setTimeout(() => setStatus(''), 14000);
  }

  /* ---------- Голос (синтез речи) ---------- */
  function speak(text, { force = false } = {}) {
    if (!('speechSynthesis' in window)) return;
    if (!state.settings.voiceOn && !force) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      u.rate = 0.88;
      u.pitch = 1;
      const v = window.speechSynthesis.getVoices().find((x) => /^ru/i.test(x.lang));
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch { /* голос недоступен — не страшно, текст на экране остаётся */ }
  }

  function applyVoiceButton() {
    const on = state.settings.voiceOn;
    el.voiceBtn.textContent = on ? '🔊' : '🔇';
    el.voiceBtn.setAttribute('aria-pressed', String(on));
    el.voiceBtn.setAttribute('aria-label', on ? 'Голос включён' : 'Голос выключен');
  }

  /* ---------- Звуки (WebAudio): гудки и сирена ---------- */
  let audioCtx = null;
  function ctx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function beep(freq, dur, vol = 0.18, type = 'sine') {
    const c = ctx(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur);
  }

  let siren = null;
  function startSiren() {
    stopSiren();
    const c = ctx(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth'; g.gain.value = 0.12;
    o.connect(g).connect(c.destination); o.start();
    let hi = false;
    const tick = () => { o.frequency.setTargetAtTime(hi ? 600 : 900, c.currentTime, 0.05); hi = !hi; };
    tick();
    siren = { o, id: setInterval(tick, 600) };
  }
  function stopSiren() {
    if (!siren) return;
    clearInterval(siren.id);
    try { siren.o.stop(); } catch { /* уже остановлена */ }
    siren = null;
  }

  /* ---------- Карта ---------- */
  function initMap() {
    const map = L.map('map', { zoomControl: false, attributionControl: false }).setView(DEFAULT_CENTER, 13);
    L.control.zoom({ position: 'topright', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить' }).addTo(map);
    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.on('click', onMapClick);
    state.map = map;
  }

  function updateLayoutVars() {
    const root = document.documentElement.style;
    root.setProperty('--topbar-h', el.topbar.offsetHeight + 'px');
    root.setProperty('--panel-h', wideMQ.matches ? '0px' : el.panel.offsetHeight + 'px');
  }

  function mapPadding() {
    const top = el.topbar.offsetHeight + 24;
    if (wideMQ.matches) return { paddingTopLeft: [el.panel.offsetWidth + 48, top], paddingBottomRight: [48, 48] };
    return { paddingTopLeft: [28, top], paddingBottomRight: [28, el.panel.offsetHeight + 24] };
  }

  /* ---------- GPS ---------- */
  function startLocating() {
    if (!('geolocation' in navigator)) {
      setStatus('Это устройство не умеет определять местоположение. Нажмите на карте, где вы находитесь.', 'warn');
      state.manual = true;
      return;
    }
    setStatus('Определяю, где вы находитесь…', 'info');
    navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  function onPos(p) {
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    state.userPos = { lat, lng, accuracy };
    state.geoDenied = false;
    drawUser();
    if (state.firstFix) {
      state.firstFix = false;
      state.map.setView([lat, lng], 16);
      setStatus('Я вижу вас на карте. Синяя точка — это вы.', 'ok');
    }
  }

  function onPosErr(err) {
    if (err && err.code === 1) {
      state.geoDenied = true;
      setStatus('Доступ к местоположению закрыт. Нажмите на значок замка рядом с адресом сайта и разрешите «Местоположение». А пока можно нажать на карте, где вы находитесь.', 'warn');
      state.manual = true;
    } else {
      setStatus('Не удаётся поймать сигнал GPS. Выйдите на открытое место или нажмите на карте, где вы находитесь.', 'warn');
    }
  }

  function getPosition() {
    if (state.userPos) return Promise.resolve(state.userPos);
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('no-geo'));
      navigator.geolocation.getCurrentPosition(
        (p) => { onPos(p); resolve(state.userPos); },
        reject,
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
  }

  function drawUser() {
    const { lat, lng, accuracy } = state.userPos;
    const ll = [lat, lng];
    if (!state.userMarker) {
      state.userMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'pin-me', html: '<span></span>', iconSize: [30, 30] }),
        keyboard: false, zIndexOffset: 1000,
      }).addTo(state.map).bindTooltip('Вы здесь', { permanent: true, direction: 'top', offset: [0, -16], className: 'tip-me' });
    } else {
      state.userMarker.setLatLng(ll);
    }
    if (accuracy && accuracy > 0) {
      if (!state.accCircle) {
        state.accCircle = L.circle(ll, { radius: accuracy, color: '#0047e0', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(state.map);
      } else {
        state.accCircle.setLatLng(ll).setRadius(accuracy);
      }
    } else if (state.accCircle) {
      state.accCircle.remove();
      state.accCircle = null;
    }
  }

  // Запасной вариант: человек сам показывает на карте, где он
  function enableManualMode(pendingFn) {
    state.manual = true;
    state.pending = pendingFn || null;
    const why = state.geoDenied ? 'Доступ к местоположению закрыт. ' : 'Не получилось определить, где вы. ';
    const msg = why + 'Нажмите на карте место, где вы сейчас находитесь.';
    setStatus(msg, 'warn');
    speak(msg);
  }

  function onMapClick(e) {
    if (!state.manual) return;
    state.manual = false;
    state.userPos = { lat: e.latlng.lat, lng: e.latlng.lng, accuracy: 0, manual: true };
    drawUser();
    setStatus('Хорошо, я запомнил, где вы находитесь.', 'ok');
    const p = state.pending;
    state.pending = null;
    if (p) p();
  }

  /* ---------- Поиск мест (Nominatim) ---------- */
  function shortName(it) {
    const parts = (it.display_name || '').split(',').map((s) => s.trim());
    return it.name || parts.slice(0, 2).join(', ') || 'выбранное место';
  }

  async function geocode(query, { nearest = false } = {}) {
    const base = `${NOMINATIM}/search?format=jsonv2&accept-language=ru&q=${encodeURIComponent(query)}`;
    const c = state.userPos || (state.map && { lat: state.map.getCenter().lat, lng: state.map.getCenter().lng });
    const urls = [];
    if (c) {
      const d = nearest ? 0.15 : 0.25;
      urls.push(`${base}&limit=${nearest ? 15 : 1}&viewbox=${c.lng - d},${c.lat + d},${c.lng + d},${c.lat - d}&bounded=1`);
    }
    if (!nearest) urls.push(`${base}&limit=1`);

    for (const url of urls) {
      const list = await fetchJson(url);
      if (list && list.length) {
        let best = list[0];
        if (nearest && state.userPos) {
          best = list.reduce((a, b) =>
            haversine(state.userPos, { lat: +a.lat, lng: +a.lon }) <= haversine(state.userPos, { lat: +b.lat, lng: +b.lon }) ? a : b);
        }
        return { lat: +best.lat, lng: +best.lon, short: shortName(best) };
      }
    }
    return null;
  }

  async function reverse(lat, lng) {
    const r = await fetchJson(`${NOMINATIM}/reverse?format=jsonv2&zoom=18&accept-language=ru&lat=${lat}&lon=${lng}`);
    if (!r || !r.address) return null;
    const a = r.address;
    const street = a.road || a.pedestrian || a.footway || a.neighbourhood || a.suburb || '';
    const house = a.house_number ? ' ' + a.house_number : '';
    const city = a.city || a.town || a.village || '';
    const line = [street + house, city].filter((s) => s.trim()).join(', ');
    return line || (r.display_name || '').split(',').slice(0, 3).join(',').trim() || null;
  }

  /* ---------- Маршруты ---------- */
  async function fetchRoute(from, to) {
    const url = `${ROUTE_API}${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const data = await fetchJson(url, 15000);
    return data && data.routes && data.routes[0] ? data.routes[0] : null;
  }

  function stepText(s) {
    const m = s.maneuver || {};
    const dist = fmtDist(s.distance, true);
    const name = s.name ? ` на ${s.name}` : '';
    const dirs = {
      left: 'налево', right: 'направо',
      'slight left': 'чуть левее', 'slight right': 'чуть правее',
      'sharp left': 'резко налево', 'sharp right': 'резко направо',
    };
    if (m.type === 'arrive') return 'Вы пришли. Цель рядом.';
    if (m.type === 'depart') return `Начните путь${s.name ? ' по улице ' + s.name : ''}: пройдите ${dist}.`;
    if (m.type === 'roundabout' || m.type === 'rotary') return 'Обойдите круг и идите дальше.';
    if (m.modifier === 'uturn') return `Развернитесь${name} и пройдите ${dist}.`;
    if (dirs[m.modifier]) return `Поверните ${dirs[m.modifier]}${name}, затем пройдите ${dist}.`;
    return `Идите прямо${name}: ${dist}.`;
  }

  function clearRoute() {
    if (state.routeGroup) { state.routeGroup.remove(); state.routeGroup = null; }
    state.currentRoute = null;
    el.routeCard.hidden = true;
    el.routeSteps.textContent = '';
  }

  async function buildRoute(dest, label) {
    let from;
    try { from = await getPosition(); }
    catch {
      enableManualMode(() => runAndSpeak(() => buildRoute(dest, label)));
      return { ok: false, msg: 'Мне нужно узнать, где вы. Нажмите на карте место, где вы стоите, и я построю дорогу.' };
    }

    setStatus('Строю дорогу… Это займёт несколько секунд.', 'info');

    let data = null;
    try { data = await fetchRoute(from, dest); } catch { data = null; }

    clearRoute();

    let coords, distance, duration, steps = [];
    const exact = !!data;
    if (exact) {
      coords = data.geometry.coordinates.map(([x, y]) => [y, x]);
      distance = data.distance;
      duration = data.duration;
      steps = (data.legs && data.legs[0] && data.legs[0].steps) || [];
    } else {
      coords = [[from.lat, from.lng], [dest.lat, dest.lng]];
      distance = haversine(from, dest);
      duration = distance / 1.2;
    }

    // Рисуем: белая обводка + яркая синяя линия
    const group = L.layerGroup().addTo(state.map);
    L.polyline(coords, { color: '#ffffff', weight: 15, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
    L.polyline(coords, {
      color: '#0057ff', weight: 9, opacity: 1, lineCap: 'round', lineJoin: 'round',
      dashArray: exact ? null : '2 14', interactive: false,
    }).addTo(group);
    L.marker([dest.lat, dest.lng], {
      icon: L.divIcon({ className: 'pin-dest', html: '<span>🏁</span>', iconSize: [44, 44], iconAnchor: [10, 40] }),
      keyboard: false,
    }).addTo(group).bindTooltip(label, { permanent: true, direction: 'right', offset: [28, -18], className: 'tip-dest' });
    state.routeGroup = group;

    // Карточка маршрута
    const mins = Math.max(1, Math.round(duration / 60));
    const minWord = plural(mins, ['минуту', 'минуты', 'минут']);
    el.routeTitle.textContent = label;
    el.routeStats.textContent = `🚶 ${mins} мин · ${fmtDist(distance)}`;

    const shown = steps.filter((s) => s.distance > 0 || (s.maneuver && s.maneuver.type === 'arrive')).slice(0, 10);
    el.routeSteps.textContent = '';
    shown.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = stepText(s);
      el.routeSteps.appendChild(li);
    });
    el.routeSteps.parentElement.hidden = !(exact && shown.length);

    el.routeNote.hidden = exact;
    if (!exact) el.routeNote.textContent = 'Точную дорогу построить не получилось — показана прямая линия. Будьте осторожны у дорог.';

    el.routeCard.hidden = false;

    const summary = exact
      ? `Дорога до «${label}» готова. Идти примерно ${mins} ${minWord}, это ${fmtDist(distance, true)}. Идите по синей линии на карте.`
      : `Точную дорогу построить не получилось. Показываю прямую линию до «${label}», примерно ${fmtDist(distance, true)}. Идите в эту сторону и будьте осторожны на дорогах.`;

    state.currentRoute = { label, summary };
    setStatus(exact ? 'Дорога готова. Идите по синей линии.' : 'Показана прямая линия до места.', exact ? 'ok' : 'warn');

    setCollapsed(true);
    state.map.fitBounds(L.latLngBounds(coords), { ...mapPadding(), maxZoom: 18 });

    return { ok: true, msg: summary };
  }

  async function runAndSpeak(fn) {
    const r = await fn();
    if (r && r.msg) speak(r.msg);
    return r;
  }

  function matchPlace(q) {
    const t = norm(q);
    if (t.split(/\s+/).length > 3) return null;
    return PLACES.find((p) => p.re.test(t)) || null;
  }

  async function routeToQuery(query, poi) {
    if (poi) {
      try { await getPosition(); }
      catch {
        enableManualMode(() => runAndSpeak(() => routeToQuery(query, poi)));
        return { ok: false, msg: 'Сначала мне нужно узнать, где вы. Нажмите на карте место, где вы стоите.' };
      }
    }
    setStatus(poi ? `Ищу ближайшую ${poi.q}…` : `Ищу «${query}»…`, 'info');

    let dest;
    try { dest = await geocode(poi ? poi.q : query, { nearest: !!poi }); }
    catch { setStatus(NET_MSG, 'error'); return { ok: false, msg: NET_MSG }; }

    if (!dest) {
      const msg = poi
        ? 'Рядом с вами ничего не нашлось. Попробуйте назвать улицу или место по-другому.'
        : `Не нашёл «${query}». Напишите, пожалуйста, улицу и номер дома или название места.`;
      setStatus(msg, 'warn');
      return { ok: false, msg };
    }
    return buildRoute(dest, dest.short);
  }

  /* ---------- Кнопка «Где я?» ---------- */
  async function locateText() {
    const p = await getPosition();
    state.map.setView([p.lat, p.lng], 17);
    let addr = null;
    try { addr = await reverse(p.lat, p.lng); } catch { /* нет интернета — скажем без адреса */ }
    return addr
      ? `Вы сейчас здесь: ${addr}. На карте это синяя точка.`
      : 'Вы на карте — это синяя точка. Название улицы определить не получилось, но карта вам поможет.';
  }

  async function whereUI() {
    setStatus('Определяю, где вы…', 'info');
    try {
      const m = await locateText();
      setStatus(m, 'ok');
      speak(m);
    } catch {
      enableManualMode(whereUI);
    }
  }

  /* ---------- Кнопка «Домой» ---------- */
  async function goHome() {
    const s = state.settings;
    if (!s.homeAddress && !s.homeCoords) {
      openSettings('Давайте запомним ваш домашний адрес — и кнопка «Домой» всегда будет вести вас к двери.');
      return { ok: false, msg: 'Сначала запомним ваш домашний адрес. Впишите его в окне.' };
    }
    let dest = s.homeCoords;
    if (!dest) {
      try { dest = await geocode(s.homeAddress); }
      catch { setStatus(NET_MSG, 'error'); return { ok: false, msg: NET_MSG }; }
      if (!dest) {
        openSettings('Не нашёл такой адрес. Попробуйте написать так: город, улица, дом.');
        return { ok: false, msg: 'Не нашёл такой адрес. Давайте уточним его.' };
      }
      s.homeCoords = { lat: dest.lat, lng: dest.lng };
      saveSettings();
    }
    return buildRoute(s.homeCoords, 'Домой');
  }

  const goHomeUI = () => runAndSpeak(goHome);

  /* ---------- Окна ---------- */
  let lastFocus = null;
  function openOverlay(node) {
    lastFocus = document.activeElement;
    node.hidden = false;
    const first = node.querySelector('a[href]:not([hidden]), button, input');
    if (first) first.focus();
  }

  function closeOverlays() {
    [el.settingsOverlay, el.callOverlay, el.sosOverlay].forEach((o) => { o.hidden = true; });
    stopSiren();
    stopCallTimers();
    if (navigator.vibrate) navigator.vibrate(0);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* ок */ } }
  }

  /* Настройки */
  let pendingHome = null;
  function openSettings(hint) {
    const s = state.settings;
    el.homeInput.value = s.homeAddress;
    el.relNameInput.value = s.relName;
    el.relPhoneInput.value = s.relPhone;
    el.settingsHint.textContent = hint || 'Данные хранятся только на этом устройстве.';
    pendingHome = null;
    openOverlay(el.settingsOverlay);
  }

  async function useHere() {
    el.settingsHint.textContent = 'Определяю ваше место…';
    try {
      const p = await getPosition();
      let addr = null;
      try { addr = await reverse(p.lat, p.lng); } catch { /* без адреса */ }
      const text = addr || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      el.homeInput.value = text;
      pendingHome = { text, coords: { lat: p.lat, lng: p.lng } };
      el.settingsHint.textContent = 'Готово! Это место станет домом. Нажмите «Сохранить».';
    } catch {
      el.settingsHint.textContent = 'Не удалось определить место. Впишите адрес вручную.';
    }
  }

  function saveSettingsForm(e) {
    e.preventDefault();
    const s = state.settings;
    const home = el.homeInput.value.trim();
    const phone = el.relPhoneInput.value.trim();
    if (phone && phone.replace(/\D/g, '').length < 5) {
      el.settingsHint.textContent = 'Номер телефона выглядит слишком коротким. Проверьте, пожалуйста.';
      el.relPhoneInput.focus();
      return;
    }
    if (home !== s.homeAddress) s.homeCoords = null;
    if (pendingHome && home === pendingHome.text) s.homeCoords = pendingHome.coords;
    s.homeAddress = home;
    s.relName = el.relNameInput.value.trim();
    s.relPhone = phone;
    saveSettings();
    closeOverlays();
    const msg = 'Сохранено. Теперь кнопки «Домой» и «Позвонить родным» знают, что делать.';
    setStatus(msg, 'ok');
    speak(msg);
  }

  /* Звонок родным (быстрый набор + эмуляция вызова) */
  let callTimers = [];
  function stopCallTimers() {
    callTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    callTimers = [];
  }

  function openCall() {
    const s = state.settings;
    if (!s.relPhone) {
      openSettings('Добавьте имя и номер телефона родственника — и звонить станет легко.');
      return false;
    }
    stopCallTimers();
    el.callName.textContent = s.relName || 'Родные';
    el.callPhone.textContent = s.relPhone;
    el.callGo.href = 'tel:' + s.relPhone.replace(/[^\d+]/g, '');
    el.callStatus.textContent = 'Нажмите зелёную кнопку, чтобы позвонить.';
    openOverlay(el.callOverlay);
    speak(`Позвонить: ${s.relName || 'родным'}? Нажмите зелёную кнопку.`);
    return true;
  }

  function startRingback() {
    // Звонок на телефоне откроется сам (tel:). Здесь — звук и текст вызова, как подсказка и эмуляция.
    el.callStatus.textContent = '📞 Звоним… Ждите ответа.';
    beep(425, 1.0);
    let n = 0;
    callTimers.push(setInterval(() => { if (++n < 3) beep(425, 1.0); }, 4000));
    callTimers.push(setTimeout(() => {
      el.callStatus.textContent = 'Если звонок не начался, наберите номер вручную: ' + state.settings.relPhone;
    }, 12000));
  }

  /* СОС */
  function updateSosSms(addr, pos) {
    const phone = state.settings.relPhone;
    if (!phone) { el.sosSms.hidden = true; return; }
    const p = pos || state.userPos;
    let text = 'Мне нужна помощь.';
    if (p) {
      text += (addr ? ` Я здесь: ${addr}.` : '') +
        ` Карта: https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}`;
    }
    el.sosSms.href = `sms:${phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`;
    el.sosSms.hidden = false;
  }

  async function openSOS() {
    closeOverlays();
    el.sosMute.textContent = '🔇 Выключить звук';
    openOverlay(el.sosOverlay);
    startSiren();
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400, 200, 400]);
    speak('Вызываю помощь. Нажмите большую кнопку: позвонить 103. Оставайтесь на месте. Я рядом.', { force: true });

    el.sosAddress.textContent = 'Определяю, где вы находитесь…';
    updateSosSms();
    try {
      const p = await getPosition();
      let addr = null;
      try { addr = await reverse(p.lat, p.lng); } catch { /* без адреса */ }
      const coord = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      el.sosAddress.textContent = (addr ? addr + '. ' : '') + `Координаты: ${coord}`;
      updateSosSms(addr, p);
    } catch {
      el.sosAddress.textContent = 'Не удалось определить место. Назовите диспетчеру ближайшую улицу или здание.';
    }
  }

  /* ---------- Рядом-Бот ---------- */
  function addMsg(role, text, actions) {
    const d = document.createElement('div');
    d.className = 'msg msg--' + role;
    const p = document.createElement('p');
    p.textContent = text;
    d.appendChild(p);
    if (actions && actions.length) {
      const row = document.createElement('div');
      row.className = 'msg__actions';
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn--mini ' + (a.cls || 'btn--light');
        b.textContent = a.label;
        b.addEventListener('click', a.run);
        row.appendChild(b);
      });
      d.appendChild(row);
    }
    el.chat.appendChild(d);
    while (el.chat.children.length > 14) el.chat.removeChild(el.chat.firstChild);
    el.chat.scrollTop = el.chat.scrollHeight;
    return d;
  }

  function botSay(text, actions) {
    addMsg('bot', text, actions);
    speak(text);
  }

  /*
   * Ответы бота строятся по простым правилам и работают без сервера.
   * Чтобы подключить настоящую языковую модель, добавьте вызов вашего бэкенда
   * в самом конце botReply (вместо «запасного» ответа).
   */
  async function botReply(text) {
    const t = norm(text);

    // 1. Срочное — всегда первым
    if (/скорая|скорую|(^|\s)сос($|\s)|помогите|помоги мне|плохо|сердце|давлени|кружится|упал|больно|задыха/.test(t)) {
      return {
        text: 'Я с вами, вы не одни. Если можете, сядьте и дышите медленно. Если вам плохо — нажмите красную кнопку, я покажу, куда позвонить.',
        actions: [{ label: '🆘 Вызвать скорую', cls: 'btn--red', run: openSOS }],
      };
    }

    // 2. Где я
    if (/где я($|\s|\?)|где нахожусь|мое место|местоположени|что за улица|какая улица|какой адрес/.test(t)) {
      try { return { text: await locateText() }; }
      catch {
        enableManualMode(whereUI);
        return { text: 'Не получилось определить, где вы. Нажмите на карте место, где вы сейчас стоите.' };
      }
    }

    // 3. Домой
    if (/домой|мой дом|к себе/.test(t)) {
      const r = await goHome();
      return { text: r.msg };
    }

    // 4. Позвонить родным
    if (/позвон|звонить|родным|родственник|дочк|дочер|сыну|внук/.test(t)) {
      const ok = openCall();
      return { text: ok ? 'Открываю звонок. Нажмите зелёную кнопку.' : 'Сначала добавим номер родственника.' };
    }

    // 5. Знакомые места (аптека, магазин…)
    const poi = PLACES.find((p) => p.re.test(t));
    if (poi) {
      const r = await routeToQuery(poi.q, poi);
      return { text: r.ok ? `Нашёл ближайшую ${poi.title}. ${r.msg}` : r.msg };
    }

    // 6. «Как пройти в …», «Отведи меня в …»
    const m = t.match(/(?:пройти|дойти|добраться|доехать|идти|отведи|отведите|веди|найди|найдите|хочу|нужно|надо)\s+(?:мне\s+)?(?:в|на|к|до)?\s*(.+)$/);
    if (m) {
      const q = m[1].replace(/[?!.]+$/, '').trim();
      if (q.length >= 3) {
        const r = await routeToQuery(q);
        return { text: r.msg };
      }
    }

    // 7. Тёплые слова и страхи
    if (/заблуд|страшно|боюсь|не знаю где|потерял|устал|тревожно|растерял/.test(t)) {
      return {
        text: 'Не волнуйтесь, мы всё решим вместе. Остановитесь, сделайте медленный вдох и выдох. Давайте сначала узнаем, где вы находитесь.',
        actions: [
          { label: '📍 Где я?', run: () => handleUserText('Где я?') },
          { label: '🏠 Домой', cls: 'btn--yellow', run: goHomeUI },
        ],
      };
    }
    if (/привет|здравствуй|добрый/.test(t)) {
      return { text: 'Здравствуйте! Я Рядом-Бот, я всегда рядом. Спросите меня, например: «Где я?» или «Как пройти в аптеку?»' };
    }
    if (/спасиб|благодар/.test(t)) {
      return { text: 'Пожалуйста! Мне приятно помогать. Я рядом, если понадоблюсь.' };
    }
    if (/что (ты )?умеешь|помощь|как пользоваться|что делать/.test(t)) {
      return { text: 'Я подскажу, где вы находитесь, найду аптеку, магазин или поликлинику и покажу дорогу синей линией. Ещё могу отвести домой и помочь позвонить родным.' };
    }

    // 8. Запасной ответ
    return { text: 'Я не совсем понял, но это не страшно. Попробуйте спросить так: «Где я?», «Как пройти в аптеку?» или «Отведи меня домой».' };
  }

  async function handleUserText(raw) {
    const text = (raw || '').trim();
    if (!text) return;
    addMsg('user', text);
    const typing = addMsg('bot', 'Думаю…');
    typing.classList.add('msg--typing');
    let reply;
    try { reply = await botReply(text); }
    catch (err) {
      const offline = err && /fetch|network|abort|HTTP/i.test(String(err.message || err));
      reply = { text: offline ? NET_MSG : 'Что-то пошло не так, но это не страшно. Давайте попробуем ещё раз.' };
    }
    typing.remove();
    if (reply && reply.text) botSay(reply.text, reply.actions);
  }

  /* Голосовой ввод (если браузер умеет) */
  function initMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { el.micBtn.hidden = true; return; }
    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let listening = false;

    const stopUi = () => {
      listening = false;
      el.micBtn.classList.remove('is-live');
      el.micBtn.setAttribute('aria-pressed', 'false');
    };
    rec.onresult = (e) => { handleUserText(e.results[0][0].transcript); };
    rec.onend = stopUi;
    rec.onerror = () => { stopUi(); setStatus('Не расслышал. Попробуйте ещё раз и говорите чуть громче.', 'warn'); };

    el.micBtn.addEventListener('click', () => {
      if (listening) { rec.stop(); return; }
      try {
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        rec.start();
        listening = true;
        el.micBtn.classList.add('is-live');
        el.micBtn.setAttribute('aria-pressed', 'true');
        setStatus('Слушаю вас… Говорите.', 'info');
      } catch { stopUi(); }
    });
  }

  /* ---------- Интерфейс: панель, шрифт, голос ---------- */
  function setCollapsed(c) {
    el.panel.classList.toggle('is-collapsed', c);
    el.panelHandle.setAttribute('aria-expanded', String(!c));
    el.panelHandle.textContent = c ? '⌃ Показать кнопки и помощника' : '⌄ Скрыть кнопки (смотреть карту)';
    updateLayoutVars();
  }

  function applyFont() {
    const px = FONT_SIZES[state.settings.fontStep] || FONT_SIZES[0];
    document.documentElement.style.setProperty('--fs', px + 'px');
    updateLayoutVars();
  }

  /* ---------- Запуск ---------- */
  function bindEvents() {
    el.searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = el.searchInput.value.trim();
      if (!q) {
        const m = 'Напишите, куда хотите пойти. Например: аптека или улица Абая 10.';
        setStatus(m, 'warn');
        speak(m);
        el.searchInput.focus();
        return;
      }
      el.searchInput.blur();
      runAndSpeak(() => routeToQuery(q, matchPlace(q)));
    });

    el.homeBtn.addEventListener('click', goHomeUI);
    el.callBtn.addEventListener('click', openCall);
    el.whereBtn.addEventListener('click', whereUI);
    el.sosBtn.addEventListener('click', openSOS);
    el.settingsBtn.addEventListener('click', () => openSettings());
    el.panelHandle.addEventListener('click', () => setCollapsed(!el.panel.classList.contains('is-collapsed')));

    el.routeSpeak.addEventListener('click', () => {
      if (state.currentRoute) speak(state.currentRoute.summary, { force: true });
    });
    el.routeClear.addEventListener('click', () => {
      clearRoute();
      setStatus('Дорога убрана.', 'ok');
    });

    document.querySelectorAll('[data-ask]').forEach((b) => {
      b.addEventListener('click', () => handleUserText(b.dataset.ask));
    });
    el.botForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = el.botInput.value;
      el.botInput.value = '';
      handleUserText(v);
    });

    // Настройки
    el.settingsForm.addEventListener('submit', saveSettingsForm);
    el.settingsClose.addEventListener('click', closeOverlays);
    el.useHereBtn.addEventListener('click', useHere);

    // Звонок
    el.callGo.addEventListener('click', startRingback);
    el.callEnd.addEventListener('click', closeOverlays);

    // СОС
    el.sosCancel.addEventListener('click', closeOverlays);
    el.sosMute.addEventListener('click', () => {
      if (siren) { stopSiren(); el.sosMute.textContent = '🔊 Включить звук'; }
      else { startSiren(); el.sosMute.textContent = '🔇 Выключить звук'; }
    });

    // Размер текста и голос
    el.fontBtn.addEventListener('click', () => {
      state.settings.fontStep = (state.settings.fontStep + 1) % FONT_SIZES.length;
      saveSettings();
      applyFont();
    });
    el.voiceBtn.addEventListener('click', () => {
      state.settings.voiceOn = !state.settings.voiceOn;
      saveSettings();
      applyVoiceButton();
      if (!state.settings.voiceOn && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      else speak('Голос включён.');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOverlays();
    });

    window.addEventListener('resize', updateLayoutVars);
    if (wideMQ.addEventListener) wideMQ.addEventListener('change', updateLayoutVars);
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(updateLayoutVars);
      ro.observe(el.topbar);
      ro.observe(el.panel);
    }
  }

  function init() {
    initMap();
    applyFont();
    applyVoiceButton();
    bindEvents();
    initMic();
    updateLayoutVars();
    if (window.speechSynthesis) window.speechSynthesis.getVoices(); // «разогрев» списка голосов

    addMsg('bot', 'Здравствуйте! Я Рядом-Бот. Помогу не заблудиться. Спросите, например: «Где я?» или «Как пройти в аптеку?»');
    startLocating();
  }

  init();
})();
