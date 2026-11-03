/*
 * منطق لعبة الإمبوستر.
 * المضيف وحده يشغّل هذا الملف ويحتفظ بحالة الغرفة، واللاعبون الآخرون يستلمون
 * "عرضاً" خاصاً بكل واحد منهم (viewFor) فلا يصلهم إلا ما يحق لهم رؤيته.
 * الملف يعمل في المتصفح وفي Node (للاختبار).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.ImposterLogic = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_PLAYERS = 3;
  var MAX_PLAYERS = 12;

  function rand(n) { return Math.floor(Math.random() * n); }
  function pick(list) { return list[rand(list.length)]; }

  function cleanName(name) {
    var n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    n = Array.from(n).slice(0, 14).join('');
    return n || 'لاعب';
  }

  function createRoom(code, hostSecret, hostName) {
    var room = {
      code: code, hostId: 'p1', phase: 'lobby', round: 0, notice: '', nextId: 2,
      players: [{ id: 'p1', secret: String(hostSecret), name: cleanName(hostName), connected: true }],
      roundPlayers: [], roundNames: {}, word: null, imposterId: null, starterId: null,
      votes: {}, result: null, usedWords: [], lastImposterId: null
    };
    return room;
  }

  function getPlayer(room, id) {
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === id) return room.players[i];
    }
    return null;
  }

  function uniqueName(room, name) {
    var base = cleanName(name), n = base, i = 2;
    while (room.players.some(function (p) { return p.name === n; })) { n = base + ' ' + i; i++; }
    return n;
  }

  /* الدخول أو العودة للغرفة. "secret" سرّ اللاعب وهو لا يظهر لأحد غيره. */
  function addOrRejoin(room, secret, name) {
    secret = String(secret);
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].secret === secret) {
        room.players[i].connected = true;
        return { ok: true, id: room.players[i].id, rejoined: true };
      }
    }
    if (room.players.length >= MAX_PLAYERS) {
      return { ok: false, error: 'الغرفة ممتلئة. الحد الأقصى ' + MAX_PLAYERS + ' لاعبين.' };
    }
    var id = 'p' + room.nextId++;
    room.players.push({ id: id, secret: secret, name: uniqueName(room, name), connected: true });
    return { ok: true, id: id };
  }

  function connectedPlayers(room) {
    return room.players.filter(function (p) { return p.connected; });
  }

  function startRound(room, words) {
    if (room.phase !== 'lobby' && room.phase !== 'result') return { ok: false, error: 'الجولة شغّالة الحين.' };
    var active = connectedPlayers(room);
    if (active.length < MIN_PLAYERS) return { ok: false, error: 'تحتاجون ' + MIN_PLAYERS + ' لاعبين على الأقل.' };
    if (!words || !words.length) return { ok: false, error: 'قائمة الكلمات فاضية.' };

    var pool = words.filter(function (w) { return room.usedWords.indexOf(w) < 0; });
    if (!pool.length) { room.usedWords = []; pool = words.slice(); }
    var word = pick(pool);
    room.usedWords.push(word);

    var ids = active.map(function (p) { return p.id; });
    var candidates = ids;
    if (ids.length >= 4 && room.lastImposterId) {
      candidates = ids.filter(function (id) { return id !== room.lastImposterId; });
      if (!candidates.length) candidates = ids;
    }
    var imposter = pick(candidates);

    room.roundPlayers = ids;
    room.roundNames = {};
    active.forEach(function (p) { room.roundNames[p.id] = p.name; });
    room.word = word;
    room.imposterId = imposter;
    room.lastImposterId = imposter;
    room.starterId = pick(ids);
    room.votes = {};
    room.result = null;
    room.notice = '';
    room.round += 1;
    room.phase = 'role';
    return { ok: true };
  }

  function startVote(room) {
    if (room.phase !== 'role') return { ok: false };
    room.phase = 'vote';
    room.votes = {};
    return { ok: true };
  }

  function castVote(room, voterId, targetId) {
    if (room.phase !== 'vote') return { ok: false };
    if (room.roundPlayers.indexOf(voterId) < 0 || room.roundPlayers.indexOf(targetId) < 0) return { ok: false };
    if (voterId === targetId) return { ok: false };
    if (room.votes[voterId]) return { ok: false };
    room.votes[voterId] = targetId;
    maybeFinish(room);
    return { ok: true };
  }

  /* ينهي التصويت تلقائياً لما يصوّت كل اللاعبين المتصلين. */
  function maybeFinish(room) {
    if (room.phase !== 'vote') return false;
    var waiting = room.roundPlayers.filter(function (id) {
      var p = getPlayer(room, id);
      return p && p.connected && !room.votes[id];
    });
    if (waiting.length === 0 && Object.keys(room.votes).length > 0) {
      finishVote(room);
      return true;
    }
    return false;
  }

  function finishVote(room) {
    var tally = {};
    room.roundPlayers.forEach(function (id) { tally[id] = 0; });
    Object.keys(room.votes).forEach(function (voter) {
      var t = room.votes[voter];
      if (tally[t] !== undefined) tally[t] += 1;
    });
    var max = 0;
    Object.keys(tally).forEach(function (id) { if (tally[id] > max) max = tally[id]; });
    var top = max > 0 ? Object.keys(tally).filter(function (id) { return tally[id] === max; }) : [];
    var caught = top.length === 1 && top[0] === room.imposterId;
    var votes = {};
    Object.keys(room.votes).forEach(function (k) { votes[k] = room.votes[k]; });
    room.result = { tally: tally, top: top, caught: caught, tie: top.length > 1, votes: votes };
    room.phase = 'result';
  }

  function forceFinish(room) {
    if (room.phase !== 'vote') return { ok: false };
    finishVote(room);
    return { ok: true };
  }

  function resetRoundFields(room) {
    room.roundPlayers = [];
    room.roundNames = {};
    room.word = null;
    room.imposterId = null;
    room.starterId = null;
    room.votes = {};
    room.result = null;
  }

  function abort(room, notice) {
    resetRoundFields(room);
    room.phase = 'lobby';
    room.notice = notice || '';
    return { ok: true, aborted: true };
  }

  function backToLobby(room) {
    if (room.phase === 'lobby') return { ok: false };
    resetRoundFields(room);
    room.phase = 'lobby';
    room.notice = '';
    return { ok: true };
  }

  function setConnected(room, id, connected) {
    var p = getPlayer(room, id);
    if (!p) return;
    p.connected = !!connected;
    if (!connected) maybeFinish(room);
  }

  /* إزالة لاعب نهائياً (غادر أو انتهت مهلة انقطاعه). */
  function removePlayer(room, id) {
    var idx = -1;
    for (var i = 0; i < room.players.length; i++) { if (room.players[i].id === id) { idx = i; break; } }
    if (idx < 0 || id === room.hostId) return { ok: false };
    room.players.splice(idx, 1);

    if (room.phase === 'role' || room.phase === 'vote') {
      var ri = room.roundPlayers.indexOf(id);
      if (ri >= 0) {
        if (id === room.imposterId) return abort(room, 'غادر الإمبوستر. ابدأوا جولة جديدة.');
        room.roundPlayers.splice(ri, 1);
        delete room.votes[id];
        Object.keys(room.votes).forEach(function (v) { if (room.votes[v] === id) delete room.votes[v]; });
        if (room.roundPlayers.length < MIN_PLAYERS) return abort(room, 'غادر لاعب وما بقي عدد كافٍ. ابدأوا جولة جديدة.');
        if (room.starterId === id) room.starterId = pick(room.roundPlayers);
        if (room.phase === 'vote') maybeFinish(room);
      }
    }
    return { ok: true };
  }

  /* العرض الخاص بلاعب واحد: لا يحتوي إلا على ما يحق له معرفته. */
  function viewFor(room, id) {
    function nm(pid) {
      var p = getPlayer(room, pid);
      if (p) return p.name;
      return room.roundNames[pid] || '؟';
    }
    var v = {
      code: room.code, phase: room.phase, round: room.round, notice: room.notice || '',
      you: id, isHost: id === room.hostId, hostId: room.hostId, minPlayers: MIN_PLAYERS,
      players: room.players.map(function (p) {
        return { id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId };
      })
    };

    if (room.phase === 'role' || room.phase === 'vote') {
      var inRound = room.roundPlayers.indexOf(id) >= 0;
      v.inRound = inRound;
      v.starterId = room.starterId;
      v.starterName = nm(room.starterId);
      v.roundPlayers = room.roundPlayers.map(function (pid) { return { id: pid, name: nm(pid) }; });
      if (inRound) {
        if (id === room.imposterId) { v.role = 'imposter'; }
        else { v.role = 'word'; v.word = room.word; }
      }
      if (room.phase === 'vote') {
        v.voted = Object.keys(room.votes);
        v.myVote = room.votes[id] || null;
        v.totalVoters = room.roundPlayers.filter(function (pid) {
          var p = getPlayer(room, pid);
          return p && p.connected;
        }).length;
      }
    } else if (room.phase === 'result') {
      var r = room.result;
      v.result = {
        imposterId: room.imposterId,
        imposterName: nm(room.imposterId),
        word: room.word,
        caught: r.caught,
        tie: r.tie,
        topNames: r.top.map(nm),
        tally: r.tally,
        votes: r.votes,
        roundPlayers: room.roundPlayers.map(function (pid) { return { id: pid, name: nm(pid) }; })
      };
    }
    return v;
  }

  return {
    MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS,
    cleanName: cleanName, createRoom: createRoom, getPlayer: getPlayer, addOrRejoin: addOrRejoin,
    startRound: startRound, startVote: startVote, castVote: castVote, maybeFinish: maybeFinish,
    forceFinish: forceFinish, backToLobby: backToLobby, setConnected: setConnected,
    removePlayer: removePlayer, viewFor: viewFor
  };
});
