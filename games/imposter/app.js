/*
 * لعبة الإمبوستر: الواجهة والاتصال.
 * لا يوجد سيرفر: المضيف يفتح غرفة عبر PeerJS (WebRTC) والباقي يتصلون به مباشرة.
 * حالة اللعبة كلها عند المضيف (logic.js)، وكل لاعب يستلم نسخة خاصة به.
 */
(function () {
  'use strict';

  var L = window.ImposterLogic;
  var WORDS = [];
  var groups = window.IMPOSTER_WORDS || {};
  Object.keys(groups).forEach(function (k) { WORDS = WORDS.concat(groups[k]); });

  var APP = document.getElementById('app');
  var PREFIX = 'isaif-imposter-';
  var GRACE_MS = 20000;
  var CONNECT_TIMEOUT_MS = 15000;
  var MAX_RETRIES = 6;

  var state = { screen: 'home', view: null, busy: '', reconnecting: false, picked: null, name: '', code: '', fromLink: false, closedMsg: '' };
  var net = freshNet();
  var ui = { revealed: false, staged: -1 };

  function freshNet() {
    return {
      role: null, peer: null, conn: null, conns: {}, timers: {}, room: null, code: '', myId: '',
      name: '', token: '', joined: false, ready: false, leaving: false, retries: 0, connectTimer: null
    };
  }

  /* ---------- أدوات صغيرة ---------- */

  var mem = {};
  function sget(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function sset(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function sdel(k) { try { window.sessionStorage.removeItem(k); } catch (e) { delete mem[k]; } }
  function lget(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function token() {
    var t = sget('imp_token');
    if (!t) {
      var a = new Uint8Array(8);
      if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(a); }
      else { for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
      t = Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
      sset('imp_token', t);
    }
    return t;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normDigits(s) {
    return String(s)
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }

  var toastTimer;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3800);
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function shareLink() {
    return window.location.href.split(/[?#]/)[0] + '?room=' + net.code;
  }

  var wake = null;
  function keepAwake(on) {
    try {
      if (on) {
        if ('wakeLock' in navigator && !wake) {
          navigator.wakeLock.request('screen').then(function (l) {
            wake = l;
            l.addEventListener('release', function () { wake = null; });
          }).catch(function () { /* ignore */ });
        }
      } else if (wake) {
        wake.release().catch(function () { /* ignore */ });
        wake = null;
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- بناء الشاشات ---------- */

  function leaveBtn() { return '<button class="btn btn--text" data-action="leave">مغادرة الغرفة</button>'; }

  function homeHtml() {
    return '<section class="screen">' +
      '<a class="brand" href="../../">isaif.om</a>' +
      '<h1 class="display">الإمبوستر</h1>' +
      '<p class="lede">كلكم تعرفون الكلمة إلا واحد. اسألوا بعض، وكشفوه بالتصويت.</p>' +
      (state.fromLink ? '<p class="notice">وصلك رابط غرفة. اكتب اسمك وادخل.</p>' : '') +
      '<div class="field"><label for="name">اسمك</label>' +
        '<input class="input" id="name" maxlength="14" autocomplete="nickname" value="' + esc(state.name) + '"></div>' +
      '<button class="btn btn--block" data-action="create">إنشاء غرفة</button>' +
      '<p class="or">أو ادخل غرفة جاهزة</p>' +
      '<div class="field"><label for="code">رمز الغرفة</label>' +
        '<input class="input input--code" id="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000" value="' + esc(state.code) + '"></div>' +
      '<button class="btn btn--ghost btn--block" data-action="join">دخول الغرفة</button>' +
      '<details class="how"><summary>كيف نلعب؟</summary><ol>' +
        '<li>أنشئ غرفة وأرسل الرمز لأصحابك. تحتاجون 3 لاعبين على الأقل.</li>' +
        '<li>كل واحد يضغط على بطاقته ليعرف الكلمة. واحد بس يعرف أنه الإمبوستر.</li>' +
        '<li>اسألوا بعض عن الكلمة بدون ما تذكرونها. الإمبوستر يحاول يتخفى.</li>' +
        '<li>صوّتوا على اللي تشكون فيه.</li>' +
      '</ol></details>' +
      '</section>';
  }

  function busyHtml() {
    return '<section class="screen screen--center"><p class="busy">' + esc(state.busy) + '</p></section>';
  }

  function closedHtml() {
    return '<section class="screen">' +
      '<h1 class="display display--sm">انتهت الغرفة</h1>' +
      '<p class="lede">' + esc(state.closedMsg) + '</p>' +
      '<button class="btn btn--block" data-action="home">الرجوع للرئيسية</button>' +
      '</section>';
  }

  function rosterHtml(v) {
    return '<ul class="roster">' + v.players.map(function (p) {
      var tags = '';
      if (p.isHost) tags += '<span class="tag">المضيف</span>';
      if (p.id === v.you) tags += '<span class="tag tag--gold">أنت</span>';
      if (!p.connected) tags += '<span class="tag tag--soft">غير متصل</span>';
      return '<li class="player' + (p.connected ? '' : ' is-off') + '"><span class="player-name">' + esc(p.name) + '</span>' + tags + '</li>';
    }).join('') + '</ul>';
  }

  function lobbyHtml(v) {
    var online = v.players.filter(function (p) { return p.connected; }).length;
    var can = online >= v.minPlayers;
    var canShare = !!navigator.share;
    return '<section class="screen">' +
      (v.notice ? '<p class="notice">' + esc(v.notice) + '</p>' : '') +
      '<h1 class="code" aria-label="رمز الغرفة">' + esc(v.code) + '</h1>' +
      '<p class="lede">اطلب من أصحابك يدخلون هذا الرمز أو يفتحون الرابط.</p>' +
      '<div class="row-actions' + (canShare ? '' : ' row-actions--one') + '">' +
        '<button class="btn btn--ghost" data-action="copy">نسخ الرابط</button>' +
        (canShare ? '<button class="btn btn--ghost" data-action="share">مشاركة</button>' : '') +
      '</div>' +
      '<h2 class="h2">اللاعبون <span class="count">' + v.players.length + '</span></h2>' +
      rosterHtml(v) +
      (v.isHost
        ? '<button class="btn btn--gold btn--block" data-action="start"' + (can ? '' : ' disabled') + '>ابدأ اللعبة</button>' +
          (can ? '' : '<p class="hint">تحتاجون ' + v.minPlayers + ' لاعبين على الأقل. المتصلون الحين: ' + online + '.</p>')
        : '<p class="wait">ننتظر المضيف يبدأ اللعبة…</p>') +
      leaveBtn() +
      '</section>';
  }

  function roleCardHtml(v) {
    var face = v.role === 'imposter'
      ? '<span class="face"><strong class="face-main">الإمبوستر</strong><span class="face-note">أنت ما تعرف الكلمة. اسأل وجاوب بحذر.</span></span>'
      : '<span class="face"><strong class="face-main">' + esc(v.word) + '</strong><span class="face-note">هذي كلمتكم. لا تقولها صريحة.</span></span>';
    return '<div class="role-card' + (v.role === 'imposter' ? ' role-card--imposter' : '') + (ui.revealed ? ' is-revealed' : '') +
      '" id="roleCard" role="button" tabindex="0" aria-label="اضغط باستمرار لإظهار دورك">' +
      '<span class="role-hint">اضغط باستمرار<br>لإظهار دورك</span>' + face + '</div>';
  }

  function sitOutHtml() {
    return '<section class="screen">' +
      '<h1 class="display display--sm">الجولة شغّالة</h1>' +
      '<p class="lede">تنضم مع الجولة القادمة.</p>' + leaveBtn() + '</section>';
  }

  function roleHtml(v) {
    if (!v.inRound) return sitOutHtml();
    var turn = v.starterId === v.you ? 'ابدأ أنت بالسؤال.' : 'يبدأ بالسؤال: <b>' + esc(v.starterName) + '</b>';
    return '<section class="screen">' +
      '<h1 class="h2">الجولة ' + v.round + '</h1>' +
      roleCardHtml(v) +
      '<p class="turn">' + turn + '</p>' +
      '<p class="hint">اسألوا بعض عن الكلمة بدون ما تذكرونها. لما تخلصون، افتحوا التصويت.</p>' +
      (v.isHost
        ? '<button class="btn btn--block" data-action="open-vote">افتح التصويت</button>'
        : '<p class="wait">المضيف يفتح التصويت لما تخلصون.</p>') +
      leaveBtn() +
      '</section>';
  }

  function voteHtml(v) {
    if (!v.inRound) return sitOutHtml();
    var voted = v.voted || [];
    var iVoted = !!v.myVote;
    var others = v.roundPlayers.filter(function (p) { return p.id !== v.you; });
    var main;
    if (!iVoted) {
      main = '<ul class="ballot">' + others.map(function (p) {
        var on = state.picked === p.id;
        return '<li><button class="ballot-item' + (on ? ' is-picked' : '') + '" data-action="pick" data-id="' + esc(p.id) +
          '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(p.name) + '</button></li>';
      }).join('') + '</ul>' +
      '<button class="btn btn--gold btn--block" data-action="confirm-vote"' + (state.picked ? '' : ' disabled') + '>أكّد التصويت</button>';
    } else {
      main = '<p class="done">تم تصويتك. ننتظر الباقين.</p>';
    }
    var chips = '<ul class="chips">' + v.roundPlayers.map(function (p) {
      var done = voted.indexOf(p.id) >= 0;
      return '<li class="tag' + (done ? ' tag--gold' : ' tag--soft') + '">' + esc(p.name) + (done ? ' ✓' : '') + '</li>';
    }).join('') + '</ul>';
    return '<section class="screen">' +
      '<h1 class="display display--sm">مين الإمبوستر؟</h1>' +
      main +
      '<p class="hint">صوّت ' + voted.length + ' من ' + v.totalVoters + '</p>' + chips +
      (v.isHost ? '<button class="btn btn--ghost btn--block" data-action="force-finish">أنهِ التصويت الآن</button>' : '') +
      leaveBtn() +
      '</section>';
  }

  function resultHtml(v) {
    var r = v.result;
    var staged = ui.staged !== v.round;
    var maxVotes = 1;
    r.roundPlayers.forEach(function (p) { maxVotes = Math.max(maxVotes, r.tally[p.id] || 0); });

    var title, sub;
    if (r.caught) { title = 'انكشف الإمبوستر'; sub = 'صوّتتم صح.'; }
    else if (r.tie) { title = 'تعادلت الأصوات'; sub = 'ما قدرتوا تحسمون، والإمبوستر نجا.'; }
    else if (r.topNames.length) { title = 'الإمبوستر نجا'; sub = 'صوّتتم على ' + r.topNames[0] + ' وهو بريء.'; }
    else { title = 'الإمبوستر نجا'; sub = 'ما صوّت أحد.'; }

    var rows = r.roundPlayers.map(function (p) {
      var n = r.tally[p.id] || 0;
      var isImp = p.id === r.imposterId;
      return '<li class="tally-row' + (isImp ? ' is-imposter' : '') + '">' +
        '<span class="tally-name">' + esc(p.name) + (isImp ? '<span class="tag tag--alert">الإمبوستر</span>' : '') + '</span>' +
        '<span class="tally-n">' + n + '</span>' +
        '<span class="tally-bar"><i style="width:' + Math.round((n / maxVotes) * 100) + '%"></i></span></li>';
    }).join('');

    var names = {};
    r.roundPlayers.forEach(function (p) { names[p.id] = p.name; });
    var who = r.roundPlayers.filter(function (p) { return r.votes[p.id]; }).map(function (p) {
      return '<li>' + esc(p.name) + ' صوّت على ' + esc(names[r.votes[p.id]] || '؟') + '</li>';
    }).join('');

    return '<section class="screen' + (staged ? ' is-staged' : '') + '">' +
      '<div class="step" style="--d:0s"><h1 class="display display--sm">' + esc(title) + '</h1>' +
        '<p class="lede">' + esc(sub) + '</p></div>' +
      '<div class="block block--gold step" style="--d:.5s"><span class="block-main">' + esc(r.imposterName) + '</span>' +
        '<span class="block-note">كان الإمبوستر</span></div>' +
      '<div class="block block--ink step" style="--d:.95s"><span class="block-main">' + esc(r.word) + '</span>' +
        '<span class="block-note">كانت الكلمة</span></div>' +
      '<div class="step" style="--d:1.4s"><ul class="tally">' + rows + '</ul></div>' +
      (who ? '<div class="step" style="--d:1.4s"><ul class="who">' + who + '</ul></div>' : '') +
      (v.isHost
        ? '<button class="btn btn--gold btn--block step" style="--d:1.4s" data-action="new-round">جولة جديدة</button>' +
          '<button class="btn btn--ghost btn--block step" style="--d:1.4s" data-action="to-lobby">العودة إلى الصالة</button>'
        : '<p class="wait step" style="--d:1.4s">ننتظر المضيف يبدأ جولة جديدة…</p>') +
      leaveBtn() +
      '</section>';
  }

  function gameHtml(v) {
    var banner = state.reconnecting ? '<div class="banner" role="alert">انقطع الاتصال. جارٍ إعادة المحاولة…</div>' : '';
    var body;
    if (v.phase === 'lobby') body = lobbyHtml(v);
    else if (v.phase === 'role') body = roleHtml(v);
    else if (v.phase === 'vote') body = voteHtml(v);
    else body = resultHtml(v);
    return banner + body;
  }

  /* ---------- العرض ---------- */

  function captureInputs() {
    var n = document.getElementById('name');
    var c = document.getElementById('code');
    if (n) state.name = n.value;
    if (c) state.code = c.value;
  }

  function render() {
    captureInputs();
    var html;
    if (state.busy) html = busyHtml();
    else if (state.screen === 'home') html = homeHtml();
    else if (state.screen === 'closed') html = closedHtml();
    else if (state.view) html = gameHtml(state.view);
    else html = homeHtml();
    APP.innerHTML = html;
    if (state.screen === 'game' && state.view && state.view.phase === 'result') ui.staged = state.view.round;
  }

  function applyView(view) {
    var prev = state.view;
    if (!prev || prev.phase !== view.phase || prev.round !== view.round) {
      ui.revealed = false;
      state.picked = null;
    }
    state.view = view;
    render();
  }

  /* ---------- الأوامر الواردة من المستخدم ---------- */

  function readName() {
    var el = document.getElementById('name');
    var name = L.cleanName(el ? el.value : state.name);
    if (!el || !el.value.trim()) { toast('اكتب اسمك أولاً.'); if (el) el.focus(); return ''; }
    state.name = name;
    lset('imp_name', name);
    return name;
  }

  function ensurePeer() {
    if (typeof window.Peer !== 'function') {
      toast('تعذّر تحميل مكتبة الاتصال. تأكد من الإنترنت وحدّث الصفحة.');
      return false;
    }
    return true;
  }

  function fail(msg) {
    clearTimeout(net.connectTimer);
    teardownPeer();
    net = freshNet();
    sdel('imp_session');
    state.busy = '';
    state.reconnecting = false;
    state.screen = 'home';
    state.view = null;
    render();
    toast(msg);
  }

  function showClosed(msg) {
    clearTimeout(net.connectTimer);
    teardownPeer();
    net = freshNet();
    sdel('imp_session');
    keepAwake(false);
    state.busy = '';
    state.reconnecting = false;
    state.view = null;
    state.screen = 'closed';
    state.closedMsg = msg;
    render();
  }

  function teardownPeer() {
    var p = net.peer;
    net.peer = null;
    net.conn = null;
    if (p) { try { p.destroy(); } catch (e) { /* ignore */ } }
  }

  function onCreate() {
    var name = readName();
    if (!name || !ensurePeer()) return;
    state.busy = 'جارٍ إنشاء الغرفة…';
    render();
    createHost(name, 0);
  }

  function onJoin() {
    var name = readName();
    if (!name) return;
    var codeEl = document.getElementById('code');
    var code = normDigits(codeEl ? codeEl.value : state.code).replace(/\D/g, '');
    if (code.length !== 4) { toast('اكتب رمز الغرفة المكوّن من 4 أرقام.'); if (codeEl) codeEl.focus(); return; }
    if (!ensurePeer()) return;
    state.code = code;
    net = freshNet();
    net.role = 'client';
    net.code = code;
    net.name = name;
    net.token = token();
    state.busy = 'جارٍ الدخول…';
    render();
    attemptJoin();
  }

  /* ---------- المضيف ---------- */

  function createHost(name, attempt) {
    var code = String(1000 + Math.floor(Math.random() * 9000));
    var peer;
    try { peer = new window.Peer(PREFIX + code); } catch (e) { return fail('تعذّر إنشاء الغرفة. حاول مرة ثانية.'); }
    var opened = false;
    var timer = setTimeout(function () {
      if (!opened) { try { peer.destroy(); } catch (e) { /* ignore */ } fail('تعذّر إنشاء الغرفة. تأكد من الإنترنت وحاول مرة ثانية.'); }
    }, CONNECT_TIMEOUT_MS);

    peer.on('open', function () {
      opened = true;
      clearTimeout(timer);
      net = freshNet();
      net.role = 'host';
      net.peer = peer;
      net.code = code;
      net.name = name;
      net.token = token();
      net.joined = true;
      net.room = L.createRoom(code, net.token, name);
      net.myId = net.room.hostId;
      peer.on('connection', onIncoming);
      peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) { /* ignore */ } });
      state.busy = '';
      state.screen = 'game';
      keepAwake(true);
      broadcast();
    });
    peer.on('error', function (err) {
      if (opened) return;
      clearTimeout(timer);
      try { peer.destroy(); } catch (e) { /* ignore */ }
      if (err && err.type === 'unavailable-id' && attempt < 6) return createHost(name, attempt + 1);
      fail('تعذّر إنشاء الغرفة. تأكد من الإنترنت وحاول مرة ثانية.');
    });
  }

  function onIncoming(conn) {
    conn.on('data', function (msg) { hostHandle(conn, msg); });
    conn.on('close', function () { hostConnClosed(conn); });
    conn.on('error', function () { hostConnClosed(conn); });
  }

  function safeSend(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { /* ignore */ }
  }

  function hostHandle(conn, msg) {
    var room = net.room;
    if (!room || !msg || typeof msg !== 'object') return;

    if (msg.t === 'join') {
      var secret = String(msg.token || '').slice(0, 64);
      if (!secret) return;
      var res = L.addOrRejoin(room, secret, String(msg.name || ''));
      if (!res.ok) { safeSend(conn, { t: 'error', msg: res.error }); return; }
      var old = net.conns[res.id];
      net.conns[res.id] = conn;
      conn.__pid = res.id;
      if (old && old !== conn) { try { old.close(); } catch (e) { /* ignore */ } }
      clearTimeout(net.timers[res.id]);
      broadcast();
      return;
    }

    var id = conn.__pid;
    if (!id || net.conns[id] !== conn) return;

    if (msg.t === 'vote') {
      L.castVote(room, id, String(msg.target || ''));
      broadcast();
    } else if (msg.t === 'leave') {
      delete net.conns[id];
      clearTimeout(net.timers[id]);
      L.removePlayer(room, id);
      sweep();
      broadcast();
    }
  }

  function hostConnClosed(conn) {
    var room = net.room;
    var id = conn.__pid;
    if (!room || !id || net.conns[id] !== conn) return;
    delete net.conns[id];
    L.setConnected(room, id, false);
    scheduleRemoval(id);
    broadcast();
  }

  function scheduleRemoval(id) {
    clearTimeout(net.timers[id]);
    net.timers[id] = setTimeout(function () {
      var room = net.room;
      if (!room) return;
      var p = L.getPlayer(room, id);
      if (!p || p.connected) return;
      var inRound = (room.phase === 'role' || room.phase === 'vote') && room.roundPlayers.indexOf(id) >= 0;
      if (!inRound) { L.removePlayer(room, id); broadcast(); }
    }, GRACE_MS);
  }

  /* بعد انتهاء الجولة: المنقطعون نهائياً تنتهي مهلتهم ويُزالون. */
  function sweep() {
    var room = net.room;
    if (!room || (room.phase !== 'lobby' && room.phase !== 'result')) return;
    room.players.forEach(function (p) { if (!p.connected) scheduleRemoval(p.id); });
  }

  function broadcast() {
    var room = net.room;
    if (!room) return;
    applyView(L.viewFor(room, net.myId));
    room.players.forEach(function (p) {
      if (p.id === net.myId) return;
      safeSend(net.conns[p.id], { t: 'view', view: L.viewFor(room, p.id) });
    });
  }

  function hostAction(fn) {
    var room = net.room;
    if (!room || net.role !== 'host') return;
    var r = fn(room);
    if (r && r.ok === false && r.error) toast(r.error);
    sweep();
    broadcast();
  }

  /* ---------- اللاعب العادي ---------- */

  function attemptJoin() {
    teardownPeer();
    clearTimeout(net.connectTimer);
    net.ready = false;
    var peer;
    try { peer = new window.Peer(); } catch (e) { return retryOrFail('تعذّر الاتصال. حاول مرة ثانية.'); }
    net.peer = peer;
    net.connectTimer = setTimeout(function () {
      if (net.peer === peer && !net.ready) retryOrFail('تعذّر الاتصال بالغرفة. تأكد من الإنترنت وحاول مرة ثانية.');
    }, CONNECT_TIMEOUT_MS);

    peer.on('open', function () {
      if (net.peer !== peer) return;
      var conn = peer.connect(PREFIX + net.code, { reliable: true, serialization: 'json' });
      net.conn = conn;
      conn.on('open', function () { conn.send({ t: 'join', token: net.token, name: net.name }); });
      conn.on('data', function (msg) { if (net.conn === conn) onClientData(msg); });
      conn.on('close', function () { if (net.conn === conn) onClientClosed(); });
      conn.on('error', function () { if (net.conn === conn) onClientClosed(); });
    });
    peer.on('error', function (err) {
      if (net.peer !== peer) return;
      if (err && err.type === 'peer-unavailable') {
        retryOrFail('ما لقينا غرفة بهذا الرمز. تأكد منه وحاول مرة ثانية.');
      } else {
        retryOrFail('تعذّر الاتصال. تأكد من الإنترنت وحاول مرة ثانية.');
      }
    });
  }

  function retryOrFail(msg) {
    if (net.leaving) return;
    if (state.reconnecting) { scheduleRetry(); return; }
    fail(msg);
  }

  function scheduleRetry() {
    clearTimeout(net.connectTimer);
    net.retries += 1;
    if (net.retries > MAX_RETRIES) { showClosed('انقطع الاتصال بالغرفة.'); return; }
    setTimeout(function () {
      if (!net.leaving && state.reconnecting && net.role === 'client') attemptJoin();
    }, 1500);
  }

  function onClientData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'view') {
      net.ready = true;
      net.joined = true;
      net.retries = 0;
      clearTimeout(net.connectTimer);
      state.reconnecting = false;
      state.busy = '';
      if (state.screen !== 'game') { state.screen = 'game'; keepAwake(true); }
      sset('imp_session', JSON.stringify({ code: net.code, name: net.name }));
      applyView(msg.view);
    } else if (msg.t === 'error') {
      fail(msg.msg || 'تعذّر الدخول للغرفة.');
    } else if (msg.t === 'closed') {
      net.leaving = true;
      showClosed('المضيف أغلق الغرفة.');
    }
  }

  function onClientClosed() {
    clearTimeout(net.connectTimer);
    if (net.leaving) return;
    if (!net.joined) { fail('انقطع الاتصال. حاول مرة ثانية.'); return; }
    state.reconnecting = true;
    render();
    scheduleRetry();
  }

  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    if (state.screen === 'game') keepAwake(true);
    if (net.role === 'client' && net.joined && !net.leaving && !state.reconnecting && net.conn && net.conn.open === false) {
      onClientClosed();
    }
  }

  function leaveRoom() {
    var peer = net.peer;
    var wasHost = net.role === 'host';
    net.leaving = true;
    clearTimeout(net.connectTimer);
    if (wasHost) {
      Object.keys(net.conns).forEach(function (id) { safeSend(net.conns[id], { t: 'closed' }); });
    } else if (net.conn) {
      safeSend(net.conn, { t: 'leave' });
    }
    Object.keys(net.timers).forEach(function (id) { clearTimeout(net.timers[id]); });
    net = freshNet();
    sdel('imp_session');
    keepAwake(false);
    state.screen = 'home';
    state.view = null;
    state.busy = '';
    state.reconnecting = false;
    state.picked = null;
    ui.revealed = false;
    render();
    if (peer) setTimeout(function () { try { peer.destroy(); } catch (e) { /* ignore */ } }, 400);
  }

  function castMyVote() {
    var target = state.picked;
    if (!target) return;
    if (net.role === 'host') {
      hostAction(function (room) { return L.castVote(room, net.myId, target); });
    } else if (net.conn) {
      safeSend(net.conn, { t: 'vote', target: target });
    }
  }

  /* ---------- الأحداث ---------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el || el.disabled) return;
    switch (el.getAttribute('data-action')) {
      case 'create': onCreate(); break;
      case 'join': onJoin(); break;
      case 'home': state.screen = 'home'; render(); break;
      case 'leave': leaveRoom(); break;
      case 'copy':
        copyText(shareLink()).then(function (ok) { toast(ok ? 'تم نسخ الرابط.' : 'ما قدرنا ننسخ الرابط. الرمز: ' + net.code); });
        break;
      case 'share':
        try {
          navigator.share({ title: 'الإمبوستر', text: 'ادخل غرفتي في لعبة الإمبوستر. الرمز: ' + net.code, url: shareLink() }).catch(function () { /* ignore */ });
        } catch (err) { /* ignore */ }
        break;
      case 'start': hostAction(function (room) { return L.startRound(room, WORDS); }); break;
      case 'open-vote': hostAction(L.startVote); break;
      case 'force-finish': hostAction(L.forceFinish); break;
      case 'new-round': hostAction(function (room) { return L.startRound(room, WORDS); }); break;
      case 'to-lobby': hostAction(L.backToLobby); break;
      case 'pick': state.picked = el.getAttribute('data-id'); render(); break;
      case 'confirm-vote': castMyVote(); break;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'code') {
      e.target.value = normDigits(e.target.value).replace(/\D/g, '').slice(0, 4);
    }
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.id === 'name' || t.id === 'code') && e.key === 'Enter') {
      var code = normDigits((document.getElementById('code') || {}).value || '').replace(/\D/g, '');
      if (t.id === 'code' || code.length === 4) onJoin(); else onCreate();
      return;
    }
    if (t && t.id === 'roleCard' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setReveal(true); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.target && e.target.id === 'roleCard' && (e.key === 'Enter' || e.key === ' ')) setReveal(false);
  });

  /* بطاقة الدور: اضغط باستمرار لتشوف، وأفلت لتختفي (حتى ما يشوف اللي جنبك). */
  function setReveal(on) {
    ui.revealed = on;
    var c = document.getElementById('roleCard');
    if (c) c.classList.toggle('is-revealed', on);
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('#roleCard')) setReveal(true);
  });
  ['pointerup', 'pointercancel', 'touchend', 'mouseup', 'blur'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (ui.revealed) setReveal(false); });
  });
  document.addEventListener('contextmenu', function (e) {
    if (e.target.closest && e.target.closest('#roleCard')) e.preventDefault();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && ui.revealed) setReveal(false);
    onVisible();
  });

  /* ---------- البداية ---------- */

  function init() {
    state.name = lget('imp_name') || '';
    var m = /[?&]room=(\d{4})(?:&|$)/.exec(window.location.search);
    if (m) { state.code = m[1]; state.fromLink = true; }

    var saved = sget('imp_session');
    if (saved && ensurePeerQuiet()) {
      try {
        var s = JSON.parse(saved);
        if (s && /^\d{4}$/.test(s.code)) {
          net = freshNet();
          net.role = 'client';
          net.code = s.code;
          net.name = String(s.name || state.name || 'لاعب');
          net.token = token();
          net.joined = true;
          state.reconnecting = true;
          state.busy = 'جارٍ الرجوع للغرفة…';
          render();
          attemptJoin();
          return;
        }
      } catch (e) { sdel('imp_session'); }
    }
    render();
  }

  function ensurePeerQuiet() { return typeof window.Peer === 'function'; }

  init();
})();
