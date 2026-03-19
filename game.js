// ─── Firebase Config ──────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAJGS3EgK-lyMj_QNpyiOrw8hnxj_gtNSY",
  authDomain:        "tictactoetwo-0501.firebaseapp.com",
  databaseURL:       "https://tictactoetwo-0501-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "tictactoetwo-0501",
  storageBucket:     "tictactoetwo-0501.firebasestorage.app",
  messagingSenderId: "517254196835",
  appId:             "1:517254196835:web:eaeb96ce02311855cc5256"
};

firebase.initializeApp(firebaseConfig);

// ─── App Check (reCAPTCHA v3) ─────────────────────────────────────────────────
// REPLACE the string below with your reCAPTCHA v3 SITE KEY from:
// https://www.google.com/recaptcha/admin
// It looks like: 6Lc_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
const appCheck = firebase.appCheck();
appCheck.activate(
  '6LcKcJAsAAAAAP9YRIEkDqvKdns254wjUO45zUh9', // <── PASTE YOUR SITE KEY HERE
  true // auto-refresh tokens
);

const db = firebase.database();

// ─── ELO / Rating ────────────────────────────────────────────────────────────
const STARTING_RATING  = 1200;
const ELO_K            = 32;
const DRAW_DIFF_THRESH = 200;

function calcEloDelta(myRating, oppRating, outcome) {
  const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
  return Math.round(ELO_K * (outcome - expected));
}
function getOutcome(winner, player) {
  if (winner === 'D') return 0.5;
  return winner === player ? 1 : 0;
}

// ─── Mode ─────────────────────────────────────────────────────────────────────
// 'online' = Firebase multiplayer   'local' = pass-and-play
let gameMode = null;
let isRanked = false;

// ─── Online Session ───────────────────────────────────────────────────────────
let myPlayer        = null;
let roomId          = null;
let roomRef         = null;
let myQueueRef      = null;
let gameListener    = null;
let scoresListener  = null;
let playersListener = null;
let readyListener   = null;
const mySessionId   = Math.random().toString(36).slice(2);

// ─── Username ────────────────────────────────────────────────────────────────
let myUsername = localStorage.getItem('ttt2_username') || '';
// names[player] e.g. names['X'] = 'Alice'
let names = { X: '—', O: '—' };

// ─── Auth helpers ────────────────────────────────────────────────────────────
const myPlayerId = localStorage.getItem('ttt2_playerId') || (() => {
  const id = 'uid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('ttt2_playerId', id);
  return id;
})();

async function hashPassword(password) {
  // App-level salt — defeats generic rainbow table attacks
  const salted  = 'ttt2_s4lt_x9q::' + password + '::ttt2_end';
  const encoded = new TextEncoder().encode(salted);
  const buf     = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function nameKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// Pending state across the two-step auth flow
let pendingUsername = '';

// ── Step 1: check if username exists ─────────────────────────────────────────
async function checkUsername() {
  const val   = document.getElementById('username-input').value.trim();
  const errEl = document.getElementById('username-error');
  errEl.textContent = '';

  if (!val)          { errEl.textContent = 'Please enter a username.'; return; }
  if (val.length < 2){ errEl.textContent = 'At least 2 characters please.'; return; }

  errEl.textContent = 'Checking...';
  const btn = document.querySelector('#lobby-username .lobby-btn.primary');
  btn.disabled = true;

  pendingUsername = val;
  const key  = nameKey(val);
  const snap = await db.ref('usernames/' + key).get();
  btn.disabled = false;
  errEl.textContent = '';

  if (!snap.exists()) {
    // Brand new username — ask them to set a password
    document.getElementById('auth-name-chip').textContent = val;
    document.getElementById('set-password-input').value   = '';
    document.getElementById('set-password-confirm').value = '';
    document.getElementById('set-password-error').textContent = '';
    document.getElementById('lobby-username').classList.add('hidden');
    document.getElementById('lobby-set-password').classList.remove('hidden');
    document.getElementById('set-password-input').focus();

  } else if (snap.val().playerId === myPlayerId) {
    // Same device — auto-login (no password needed)
    await claimUsername(val, null, snap.val().passwordHash);

  } else {
    // Taken by someone else — offer login
    document.getElementById('auth-login-chip').textContent = val;
    document.getElementById('login-password-input').value  = '';
    document.getElementById('login-error').textContent     = '';
    document.getElementById('lobby-username').classList.add('hidden');
    document.getElementById('lobby-login-password').classList.remove('hidden');
    document.getElementById('login-password-input').focus();
  }
}

// ── Step 2a: new user sets a password ────────────────────────────────────────
async function submitSetPassword() {
  const pw1   = document.getElementById('set-password-input').value;
  const pw2   = document.getElementById('set-password-confirm').value;
  const errEl = document.getElementById('set-password-error');
  errEl.textContent = '';

  if (!pw1)        { errEl.textContent = 'Please choose a password.'; return; }
  if (pw1.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }
  if (pw1 !== pw2) { errEl.textContent = 'Passwords do not match.'; return; }

  const btn  = document.querySelector('#lobby-set-password .lobby-btn.primary');
  btn.disabled = true;
  errEl.textContent = 'Creating account...';

  const hash = await hashPassword(pw1);
  const key  = nameKey(pendingUsername);
  const ref  = db.ref('usernames/' + key);

  // Transaction — ensure nobody else grabbed it while we were on this screen
  let taken = false;
  await ref.transaction(current => {
    if (current !== null) { taken = true; return; }
    return { playerId: myPlayerId, display: pendingUsername, passwordHash: hash };
  });

  btn.disabled = false;

  if (taken) {
    errEl.textContent = 'That username was just taken. Try another.';
    setTimeout(backToUsername, 1500);
    return;
  }

  await finishLogin(pendingUsername);
}

// ── Step 2b: existing user logs in with password ──────────────────────────────
async function submitLogin() {
  const pw    = document.getElementById('login-password-input').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!pw) { errEl.textContent = 'Please enter your password.'; return; }

  const btn = document.querySelector('#lobby-login-password .lobby-btn.primary');
  btn.disabled = true;
  errEl.textContent = 'Checking...';

  const key  = nameKey(pendingUsername);
  const snap = await db.ref('usernames/' + key).get();

  if (!snap.exists()) {
    // Username vanished — just claim it fresh
    btn.disabled = false;
    errEl.textContent = '';
    await checkUsername();
    return;
  }

  const hash      = await hashPassword(pw);
  const storedHash = snap.val().passwordHash;

  if (hash !== storedHash) {
    btn.disabled = false;
    errEl.textContent = 'Incorrect password. Try again.';
    return;
  }

  // Password correct — transfer ownership to this device
  await db.ref('usernames/' + key).update({ playerId: myPlayerId });
  btn.disabled = false;
  await finishLogin(pendingUsername);
}

// ── Finish: save locally, release old username, go to lobby ──────────────────
async function finishLogin(name) {
  // Release old username if different
  if (myUsername && myUsername !== name) {
    const oldKey  = nameKey(myUsername);
    const oldSnap = await db.ref('usernames/' + oldKey).get();
    if (oldSnap.exists() && oldSnap.val().playerId === myPlayerId) {
      await db.ref('usernames/' + oldKey).remove();
    }
  }
  myUsername = name;
  localStorage.setItem('ttt2_username', name);
  showLobbyMain(name);
}

async function claimUsername(name, newHash, existingHash) {
  const key = nameKey(name);
  if (newHash) {
    await db.ref('usernames/' + key).set({ playerId: myPlayerId, display: name, passwordHash: newHash });
  }
  await finishLogin(name);
}

function backToUsername() {
  ['lobby-set-password','lobby-login-password'].forEach(id =>
    document.getElementById(id).classList.add('hidden'));
  document.getElementById('lobby-username').classList.remove('hidden');
  document.getElementById('username-error').textContent = '';
  pendingUsername = '';
}

async function showLobbyMain(name) {
  ['lobby-username','lobby-set-password','lobby-login-password'].forEach(id =>
    document.getElementById(id).classList.add('hidden'));
  document.getElementById('lobby-main').classList.remove('hidden');

  // Load rating and display alongside username
  const profile = await loadProfile(myPlayerId);
  const rating  = profile.rating || STARTING_RATING;
  const el      = document.getElementById('username-display');
  el.innerHTML  = name + ' <span class="lobby-rating-badge">' + rating + ' pts</span>';
}

function changeUsername() {
  document.getElementById('lobby-main').classList.add('hidden');
  document.getElementById('lobby-username').classList.remove('hidden');
  document.getElementById('username-input').value = myUsername;
  document.getElementById('username-error').textContent = '';
  pendingUsername = '';
}

async function initLobby() {
  if (myUsername) {
    const key  = nameKey(myUsername);
    const snap = await db.ref('usernames/' + key).get();
    if (snap.exists() && snap.val().playerId === myPlayerId) {
      showLobbyMain(myUsername);
    } else {
      myUsername = '';
      localStorage.removeItem('ttt2_username');
      setTimeout(() => document.getElementById('username-input').focus(), 100);
    }
  } else {
    setTimeout(() => document.getElementById('username-input').focus(), 100);
  }
}

// ─── Player Profile & Rating ─────────────────────────────────────────────────
async function loadProfile(playerId) {
  const ref  = db.ref('players/' + playerId);
  const snap = await ref.get();
  if (snap.exists()) return snap.val();
  const fresh = { rating: STARTING_RATING, wins: 0, losses: 0, draws: 0 };
  await ref.set(fresh);
  return fresh;
}

async function settleRating(roomData, winner) {
  if (!roomData || !roomData.ranked) return null;
  const settledRef = roomRef.child('ratingSettled');
  let didSettle = false;
  await settledRef.transaction(cur => { if (cur) return; didSettle = true; return true; });
  if (!didSettle) return null;
  const hostId = roomData.hostId, guestId = roomData.guestId;
  if (!hostId || !guestId) return null;
  const hostSeat  = roomData.creatorPlayer || 'X';
  const guestSeat = hostSeat === 'X' ? 'O' : 'X';
  const [hostProf, guestProf] = await Promise.all([loadProfile(hostId), loadProfile(guestId)]);
  const hostOutcome  = getOutcome(winner, hostSeat);
  const guestOutcome = getOutcome(winner, guestSeat);
  const ratingDiff   = Math.abs(hostProf.rating - guestProf.rating);
  let hostDelta  = calcEloDelta(hostProf.rating,  guestProf.rating, hostOutcome);
  let guestDelta = calcEloDelta(guestProf.rating, hostProf.rating,  guestOutcome);
  if (winner === 'D' && ratingDiff < DRAW_DIFF_THRESH) { hostDelta = 0; guestDelta = 0; }
  const upd = {};
  upd['players/' + hostId  + '/rating']   = Math.max(0, hostProf.rating  + hostDelta);
  upd['players/' + hostId  + '/wins']     = hostProf.wins   + (hostOutcome  === 1   ? 1 : 0);
  upd['players/' + hostId  + '/losses']   = hostProf.losses + (hostOutcome  === 0   ? 1 : 0);
  upd['players/' + hostId  + '/draws']    = hostProf.draws  + (hostOutcome  === 0.5 ? 1 : 0);
  upd['players/' + hostId  + '/username'] = roomData.usernameHost  || '';
  upd['players/' + guestId + '/rating']   = Math.max(0, guestProf.rating + guestDelta);
  upd['players/' + guestId + '/wins']     = guestProf.wins   + (guestOutcome === 1   ? 1 : 0);
  upd['players/' + guestId + '/losses']   = guestProf.losses + (guestOutcome === 0   ? 1 : 0);
  upd['players/' + guestId + '/draws']    = guestProf.draws  + (guestOutcome === 0.5 ? 1 : 0);
  upd['players/' + guestId + '/username'] = roomData.usernameGuest || '';
  await db.ref().update(upd);
  if (myPlayerId === hostId)  return hostDelta;
  if (myPlayerId === guestId) return guestDelta;
  return null;
}

async function showRatingDelta(delta) {
  if (delta === null || delta === undefined) return;
  const el = document.getElementById('end-rating-delta');
  el.classList.remove('hidden','gain','loss','none');
  if (delta === 0) { el.textContent = 'Rating unchanged'; el.classList.add('none'); }
  else { el.textContent = (delta > 0 ? '+' : '') + delta + ' pts'; el.classList.add(delta > 0 ? 'gain' : 'loss'); }

  // Also refresh the lobby username chip rating immediately
  refreshLobbyRating();
}

async function refreshLobbyRating() {
  const profile = await loadProfile(myPlayerId);
  const rating  = profile.rating || STARTING_RATING;
  const el      = document.getElementById('username-display');
  if (el) el.innerHTML = myUsername + ' <span class="lobby-rating-badge">' + rating + ' pts</span>';
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function openLB()    { document.getElementById('lb-modal').classList.remove('hidden'); fetchLeaderboard(); }
function closeLBBtn(){ document.getElementById('lb-modal').classList.add('hidden'); }
function closeLB(e)  { if (e.target === document.getElementById('lb-modal')) closeLBBtn(); }

async function fetchLeaderboard() {
  const listEl = document.getElementById('lb-list');
  listEl.innerHTML = '<div class="lb-loading">Loading...</div>';
  // Fetch all players without ordering (avoids needing a Firebase index)
  const snap = await db.ref('players').get();
  if (!snap.exists()) { listEl.innerHTML = '<div class="lb-loading">No players yet.</div>'; return; }
  const rows = [];
  snap.forEach(child => {
    const val = child.val();
    // Only show players who have played at least one rated game
    if (val.wins || val.losses || val.draws) rows.push({ id: child.key, ...val });
  });
  if (rows.length === 0) { listEl.innerHTML = '<div class="lb-loading">No rated games played yet.</div>'; return; }
  rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const top10 = rows.slice(0, 10);
  listEl.innerHTML = '';
  top10.forEach((p, i) => {
    const rank    = i + 1;
    const isMe    = p.id === myPlayerId;
    const rankCls = rank===1?'top1':rank===2?'top2':rank===3?'top3':'';
    const row     = document.createElement('div');
    row.className = 'lb-row' + (isMe ? ' me' : '');
    row.innerHTML =
      '<span class="lb-col-rank ' + rankCls + '">' + rank + '</span>' +
      '<span class="lb-col-name">' + (isMe ? '★ ' : '') + (p.username || 'Unknown') + '</span>' +
      '<span class="lb-col-rating">' + (p.rating || STARTING_RATING) + '</span>' +
      '<span class="lb-col-record"><span class="w">' + (p.wins||0) + 'W</span> ' +
      (p.draws||0) + 'D <span class="l">' + (p.losses||0) + 'L</span></span>';
    listEl.appendChild(row);
  });
}

// ─── Inactivity Timer ────────────────────────────────────────────────────────
// Both clients sync from the server-stored lastMoveAt timestamp so the
// countdown is identical on both devices regardless of network lag.
const INACTIVITY_LIMIT = 120; // seconds
let inactivityInterval = null;
let moveStartedAt      = 0;   // ms — set from Firebase server timestamp

function startInactivityTimer(serverTimestamp) {
  clearInactivityTimer();
  if (gameMode !== 'online' || outerWinner) return;

  // Use the server timestamp if provided, otherwise fall back to now
  moveStartedAt = serverTimestamp || Date.now();

  const bar   = document.getElementById('inactivity-bar');
  const fill  = document.getElementById('inactivity-fill');
  const label = document.getElementById('inactivity-label');
  const cd    = document.getElementById('inactivity-countdown');

  bar.classList.remove('hidden');

  inactivityInterval = setInterval(async () => {
    // Calculate remaining time from the authoritative server timestamp
    const elapsed  = (Date.now() - moveStartedAt) / 1000;
    const secsLeft = Math.max(0, Math.round(INACTIVITY_LIMIT - elapsed));
    const pct      = (secsLeft / INACTIVITY_LIMIT) * 100;

    fill.style.width = pct + '%';
    cd.textContent   = secsLeft;

    const urgent = secsLeft <= 30;
    fill.classList.toggle('urgent', urgent);
    label.classList.toggle('urgent', urgent);

    if (secsLeft <= 0) {
      clearInactivityTimer();
      // Only the waiting player (opponent's turn) triggers the forfeit
      // to avoid both clients writing simultaneously
      if (currentPlayer !== myPlayer) {
        await roomRef.child('forfeit').set({ loser: currentPlayer, ts: Date.now() });
      }
    }
  }, 1000);
}

function clearInactivityTimer() {
  if (inactivityInterval) { clearInterval(inactivityInterval); inactivityInterval = null; }
  const bar = document.getElementById('inactivity-bar');
  if (bar) bar.classList.add('hidden');
}

// ─── Game State ───────────────────────────────────────────────────────────────
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

let currentPlayer = 'X';
let boards      = Array.from({ length: 9 }, () => Array(9).fill(null));
let boardWinner = Array(9).fill(null);
let outerWinner = null;
let activeBoard = -1;
let scores      = { X: 0, O: 0 };
let moveCount   = 0;

// ─── How To Play ──────────────────────────────────────────────────────────────
function openHTP() {
  document.getElementById('htp-modal').classList.remove('hidden');
}

function closeHTPBtn() {
  document.getElementById('htp-modal').classList.add('hidden');
}

function closeHTP(e) {
  // Close only if clicking the backdrop itself, not the modal box
  if (e.target === document.getElementById('htp-modal')) closeHTPBtn();
}

// ─── Pass & Play ──────────────────────────────────────────────────────────────
function startPassAndPlay() {
  gameMode  = 'local';
  myPlayer  = null;
  names     = { X: 'Player X', O: 'Player O' };

  resetGameState();

  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('game-subtitle-left').textContent = 'Pass & Play';
  document.getElementById('room-info-bar').classList.add('hidden');
  document.getElementById('pc-name-x').textContent = names.X;
  document.getElementById('pc-name-o').textContent = names.O;
  document.getElementById('score-x').textContent = '0';
  document.getElementById('score-o').textContent = '0';

  buildGrid();
  render();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function resetGameState() {
  currentPlayer = 'X';
  boards        = Array.from({ length: 9 }, () => Array(9).fill(null));
  boardWinner   = Array(9).fill(null);
  outerWinner   = null;
  activeBoard   = -1;
  moveCount     = 0;
}

function initialGameState() {
  return {
    boards:        Array.from({ length: 9 }, () => Array(9).fill(null)),
    boardWinner:   Array(9).fill(null),
    outerWinner:   null,
    activeBoard:   -1,
    currentPlayer: 'X',
    moveCount:     0
  };
}

function serializeGame(state) {
  return {
    boards:        JSON.stringify(state.boards),
    boardWinner:   JSON.stringify(state.boardWinner),
    outerWinner:   state.outerWinner ?? '',
    activeBoard:   state.activeBoard,
    currentPlayer: state.currentPlayer,
    moveCount:     state.moveCount,
    lastMoveAt:    firebase.database.ServerValue.TIMESTAMP
  };
}

function deserializeGame(data) {
  boards        = JSON.parse(data.boards);
  boardWinner   = JSON.parse(data.boardWinner);
  outerWinner   = data.outerWinner || null;
  activeBoard   = data.activeBoard;
  currentPlayer = data.currentPlayer;
  moveCount     = data.moveCount;
}

function setLobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg;
}

function showLobbyPanel(panelId) {
  ['lobby-main', 'lobby-searching', 'lobby-waiting'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById(panelId).classList.remove('hidden');
}

// ─── Quick Match ──────────────────────────────────────────────────────────────
// Strategy: single atomic transaction on matchmaking/pending.
//   - If slot is empty  → write our roomId, become the host, wait for joiner.
//   - If slot has entry → take that roomId, clear the slot, join as guest.
// This means only ONE device ever writes to pending at a time, so there is
// no possible race condition between two simultaneous entrants.

async function quickMatch() {
  setLobbyError('');
  gameMode = 'online';
  isRanked = true;
  showLobbyPanel('lobby-searching');

  // Pre-create our own room in case we end up hosting
  const myRoomId    = generateRoomId();
  const hostPlayer  = Math.random() < 0.5 ? 'X' : 'O';
  const guestPlayer = hostPlayer === 'X' ? 'O' : 'X';

  const myRoomData = {
    players:       { [hostPlayer]: true, [guestPlayer]: false },
    creatorPlayer: hostPlayer,
    game:          serializeGame(initialGameState()),
    scores:        { X: 0, O: 0 },
    status:        'waiting',
    mode:          'matchmaking',
    createdAt:     Date.now()
  };

  // Write the room first so it exists before we advertise it
  const hostProfile = await loadProfile(myPlayerId);
  myRoomData.usernameHost = myUsername;
  myRoomData.hostId       = myPlayerId;
  myRoomData.hostRating   = hostProfile.rating;
  myRoomData.ranked       = true;
  await db.ref('rooms/' + myRoomId).set(myRoomData);
  db.ref('rooms/' + myRoomId).onDisconnect().remove();

  // Atomic transaction: grab someone else's room OR advertise ours
  const pendingRef = db.ref('matchmaking/pending');
  let theirRoomId  = null;

  await pendingRef.transaction(current => {
    if (current === null) {
      // Nobody waiting — advertise our room
      return { roomId: myRoomId, sessionId: mySessionId, ts: Date.now() };
    } else {
      // Someone is waiting — grab their room and clear the slot
      theirRoomId = current.roomId;
      return null;
    }
  });

  if (theirRoomId) {
    // ── We are the GUEST ──────────────────────────────────────────────────
    // Clean up the room we pre-created since we won't need it
    db.ref('rooms/' + myRoomId).onDisconnect().cancel();
    await db.ref('rooms/' + myRoomId).remove();

    // Join the host's room
    const snap = await db.ref('rooms/' + theirRoomId).get();
    if (!snap.exists() || snap.val().status !== 'waiting') {
      // Host's room is gone — clear pending and try again fresh
      await pendingRef.remove();
      await quickMatch();
      return;
    }

    const data = snap.val();
    let joinerSeat = data.players.X === false ? 'X' : 'O';

    roomId   = theirRoomId;
    roomRef  = db.ref('rooms/' + roomId);
    myPlayer = joinerSeat;

    // Write guest metadata BEFORE filling seat so host reads it in startOnlineGame
    const guestProfile = await loadProfile(myPlayerId);
    await roomRef.child('guestId').set(myPlayerId);
    await roomRef.child('guestRating').set(guestProfile.rating);
    await roomRef.child('usernameGuest').set(myUsername);
    await roomRef.child('status').set('playing');
    await roomRef.child('players/' + joinerSeat).set(true);
    roomRef.child('players/' + joinerSeat).onDisconnect().set(false);

    startOnlineGame();

  } else {
    // ── We are the HOST ───────────────────────────────────────────────────
    roomId   = myRoomId;
    roomRef  = db.ref('rooms/' + roomId);
    myPlayer = hostPlayer;
    myQueueRef = pendingRef; // reuse myQueueRef so cancelMatchmaking cleans it up

    // Watch for the guest to join our room
    roomRef.child('players/' + guestPlayer).on('value', snap => {
      if (snap.val() === true) {
        roomRef.child('players/' + guestPlayer).off();
        if (myQueueRef) {
          myQueueRef.onDisconnect().cancel();
          // Don't remove pending here — guest already cleared it via transaction
          myQueueRef = null;
        }
        startOnlineGame();
      }
    });
  }
}

async function cancelMatchmaking() {
  // Clear the pending slot if we are the host
  if (myQueueRef) {
    myQueueRef.onDisconnect().cancel();
    await myQueueRef.remove();
    myQueueRef = null;
  }
  if (roomRef) {
    roomRef.onDisconnect().cancel();
    await roomRef.remove();
    roomRef = null;
  }
  roomId = null; myPlayer = null; gameMode = null;
  showLobbyPanel('lobby-main');
}

// ─── Create Private Room ──────────────────────────────────────────────────────
async function createRoom() {
  setLobbyError('');
  gameMode = 'online';
  isRanked = false;
  roomId   = generateRoomId();
  roomRef  = db.ref(`rooms/${roomId}`);
  // Randomly assign creator to X or O
  myPlayer = Math.random() < 0.5 ? 'X' : 'O';
  const joinerSeat = myPlayer === 'X' ? 'O' : 'X';

  await roomRef.set({
    players:       { [myPlayer]: true, [joinerSeat]: false },
    creatorPlayer: myPlayer,
    game:          serializeGame(initialGameState()),
    scores:        { X: 0, O: 0 },
    status:        'waiting',
    mode:          'private',
    createdAt:     Date.now(),
    usernameHost:  myUsername
  });

  roomRef.onDisconnect().remove();
  showLobbyPanel('lobby-waiting');
  document.getElementById('room-code-display').textContent = roomId;

  roomRef.child(`players/${joinerSeat}`).on('value', snap => {
    if (snap.val() === true) {
      roomRef.child(`players/${joinerSeat}`).off();
      startOnlineGame();
    }
  });
}

// ─── Join Private Room ────────────────────────────────────────────────────────
async function joinRoom() {
  setLobbyError('');
  const code = document.getElementById('join-input').value.trim().toUpperCase();

  if (code.length !== 6) { setLobbyError('Please enter a 6-character room code.'); return; }

  const snap = await db.ref(`rooms/${code}`).get();

  if (!snap.exists()) { setLobbyError('Room not found. Check the code and try again.'); return; }
  const rdata = snap.val();
  if (rdata.status === 'finished') { setLobbyError('That game has already ended.'); return; }
  const hasOpenSeat = rdata.players && (rdata.players.X === false || rdata.players.O === false);
  if (!hasOpenSeat) { setLobbyError('Room is full — game already in progress.'); return; }

  gameMode  = 'online';
  isRanked  = false;

  // Find the open seat and join it
  const joinerSeat = rdata.players.X === false ? 'X' : 'O';

  roomId   = code;
  roomRef  = db.ref('rooms/' + roomId);
  myPlayer = joinerSeat;

  // Write guest metadata BEFORE filling seat so host reads it in startOnlineGame
  const guestProf = await loadProfile(myPlayerId);
  await roomRef.child('guestId').set(myPlayerId);
  await roomRef.child('guestRating').set(guestProf.rating);
  await roomRef.child('usernameGuest').set(myUsername);
  await roomRef.child('status').set('playing');
  await roomRef.child('players/' + joinerSeat).set(true);
  roomRef.child('players/' + joinerSeat).onDisconnect().set(false);

  startOnlineGame();
}

async function cancelRoom() {
  if (roomRef) { roomRef.onDisconnect().cancel(); await roomRef.remove(); }
  roomRef = null; roomId = null; myPlayer = null; gameMode = null;
  showLobbyPanel('lobby-main');
}

// ─── Leave ────────────────────────────────────────────────────────────────────
async function leaveRoom() {
  hideEndOverlay();
  clearInactivityTimer();
  setIngameNewGameVisible(true);
  document.body.style.setProperty('--bg-tint', 'transparent');
  // Remove our ready flag so opponent's button resets
  if (roomRef && myPlayer) {
    await roomRef.child('ready/' + myPlayer).remove();
  }
  detachListeners();

  if (gameMode === 'online' && roomRef) {
    roomRef.onDisconnect().cancel();
    await roomRef.child(`players/${myPlayer}`).set(false);
  }

  roomRef = null; roomId = null; myPlayer = null; gameMode = null;
  scores  = { X: 0, O: 0 };

  document.getElementById('game-screen').classList.add('hidden');
  document.getElementById('room-info-bar').classList.remove('hidden');
  document.getElementById('lobby-screen').classList.remove('hidden');
  showLobbyPanel('lobby-main');
  document.getElementById('join-input').value = '';
  setLobbyError('');
}

function detachListeners() {
  if (roomRef) {
    if (gameListener)    roomRef.child('game').off('value', gameListener);
    if (scoresListener)  roomRef.child('scores').off('value', scoresListener);
    if (playersListener) roomRef.child('players').off('value', playersListener);
    if (readyListener)   roomRef.child('ready').off('value', readyListener);
  }
  gameListener = scoresListener = playersListener = readyListener = null;
}

// ─── Start Online Game ────────────────────────────────────────────────────────
async function startOnlineGame() {
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('game-subtitle-left').textContent = 'Online';
  document.getElementById('room-info-bar').classList.remove('hidden');
  document.getElementById('room-info-label').textContent = 'Room: ' + roomId;

  // Fetch usernames from room
  const roomSnap = await roomRef.get();
  const rdata    = roomSnap.val() || {};
  const hostUser  = rdata.usernameHost  || 'Host';
  const guestUser = rdata.usernameGuest || 'Guest';
  const hostSeat  = rdata.creatorPlayer || 'X';
  const guestSeat = hostSeat === 'X' ? 'O' : 'X';

  names[hostSeat]  = hostUser;
  names[guestSeat] = guestUser;

  document.getElementById('pc-name-x').textContent = names.X;
  document.getElementById('pc-name-o').textContent = names.O;
  document.getElementById('score-x').textContent = '0';
  document.getElementById('score-o').textContent = '0';
  if (rdata.ranked) {
    document.getElementById('pc-rating-' + hostSeat.toLowerCase()).textContent  = (rdata.hostRating  || STARTING_RATING) + ' pts';
    document.getElementById('pc-rating-' + guestSeat.toLowerCase()).textContent = (rdata.guestRating || STARTING_RATING) + ' pts';
  } else {
    document.getElementById('pc-rating-x').textContent = 'Unranked';
    document.getElementById('pc-rating-o').textContent = 'Unranked';
  }

  buildGrid();

  // Hide in-game New Game button during ranked games
  setIngameNewGameVisible(!isRanked);

  // Listen for username/rating of late-joining guest
  roomRef.child('usernameGuest').on('value', snap => {
    if (snap.exists()) {
      names[guestSeat] = snap.val();
      document.getElementById('pc-name-' + guestSeat.toLowerCase()).textContent = snap.val();
    }
  });
  roomRef.child('guestRating').on('value', snap => {
    if (snap.exists() && rdata.ranked) {
      document.getElementById('pc-rating-' + guestSeat.toLowerCase()).textContent = snap.val() + ' pts';
    }
  });

  gameListener = roomRef.child('game').on('value', snap => {
    if (!snap.exists()) return;
    const gameData = snap.val();
    deserializeGame(gameData);

    // Reset New Game button in case it was in waiting state
    const btn = document.getElementById('end-newgame-btn');
    if (btn) { btn.textContent = '↺  New Game'; btn.disabled = false; }
    hideEndOverlay();

    render();
    if (!outerWinner) startInactivityTimer(gameData.lastMoveAt || Date.now());
    else clearInactivityTimer();
  });

  scoresListener = roomRef.child('scores').on('value', snap => {
    if (!snap.exists()) return;
    const s = snap.val();
    scores = { X: s.X || 0, O: s.O || 0 };
    document.getElementById('score-x').textContent = scores.X;
    document.getElementById('score-o').textContent = scores.O;
  });

  playersListener = roomRef.child('players').on('value', snap => {
    if (!snap.exists()) return;
    const players  = snap.val();
    const opponent = myPlayer === 'X' ? 'O' : 'X';
    if (players[opponent] === false && !outerWinner) {
      clearInactivityTimer();
      outerWinner = myPlayer; // treat as win for remaining player
      setIngameNewGameVisible(true);
      showEndOverlay('oppleft');
      if (isRanked) roomRef.get().then(s => settleRating(s.val(), myPlayer).then(d => showRatingDelta(d)));
    }
  });

  // Forfeit listener — inactivity timeout
  roomRef.child('forfeit').on('value', snap => {
    if (!snap.exists()) return;
    const { loser } = snap.val();
    if (!outerWinner) {
      clearInactivityTimer();
      outerWinner = loser === 'X' ? 'O' : 'X';
      const youWon = myPlayer === outerWinner;
      setIngameNewGameVisible(true);
      if (youWon) {
        showEndOverlay('win', 'Opponent ran out of time!');
      } else {
        showEndOverlay('loss', 'You ran out of time.');
      }
      // Settle rating — treat forfeit as a normal win/loss
      if (isRanked) roomRef.get().then(s => settleRating(s.val(), outerWinner).then(d => showRatingDelta(d)));
    }
  });

  // Listen for both players clicking New Game
  readyListener = roomRef.child('ready').on('value', async snap => {
    if (!snap.exists()) return;
    const ready = snap.val();
    // Both players ready — reset the game
    if (ready.X === true && ready.O === true) {
      await roomRef.child('ready').remove();
      await roomRef.child('forfeit').remove();
      await roomRef.child('ratingSettled').remove();
      await roomRef.child('game').set(serializeGame(initialGameState()));
    }
  });

  // Start timer immediately
  startInactivityTimer();
}

// ─── Build DOM ────────────────────────────────────────────────────────────────
function buildGrid() {
  const svg       = document.getElementById('outer-win-svg');
  const outerGrid = document.getElementById('outer-grid');
  outerGrid.innerHTML = '';
  outerGrid.appendChild(svg);

  for (let b = 0; b < 9; b++) {
    const board    = document.createElement('div');
    board.className = 'inner-board';
    board.id        = `board-${b}`;

    const cellGrid    = document.createElement('div');
    cellGrid.className = 'cell-grid';

    for (let c = 0; c < 9; c++) {
      const cell    = document.createElement('div');
      cell.className = 'cell';
      cell.id        = `cell-${b}-${c}`;
      cell.onclick   = () => handleClick(b, c);
      cellGrid.appendChild(cell);
    }

    const overlay    = document.createElement('div');
    overlay.className = 'board-overlay';
    const sym        = document.createElement('div');
    sym.className     = 'board-overlay-symbol';
    sym.id            = `overlay-sym-${b}`;
    overlay.appendChild(sym);

    board.appendChild(cellGrid);
    board.appendChild(overlay);
    outerGrid.appendChild(board);
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  for (let b = 0; b < 9; b++) {
    const boardEl = document.getElementById(`board-${b}`);
    boardEl.className = 'inner-board';

    const finished = boardWinner[b] !== null;

    if (finished) {
      if      (boardWinner[b] === 'X') boardEl.classList.add('won-x');
      else if (boardWinner[b] === 'O') boardEl.classList.add('won-o');
      else                             boardEl.classList.add('drawn');
    } else if (!outerWinner) {
      if (activeBoard === -1 || activeBoard === b)
        boardEl.classList.add(activeBoard === -1 ? 'any-valid' : 'active-board');
    }

    const overlaySym = document.getElementById(`overlay-sym-${b}`);
    if      (boardWinner[b] === 'X') { overlaySym.textContent = 'X';    overlaySym.className = 'board-overlay-symbol x'; }
    else if (boardWinner[b] === 'O') { overlaySym.textContent = 'O';    overlaySym.className = 'board-overlay-symbol o'; }
    else if (boardWinner[b] === 'D') { overlaySym.textContent = 'DRAW'; overlaySym.className = 'board-overlay-symbol draw'; }
    else                              { overlaySym.textContent = '';     overlaySym.className = 'board-overlay-symbol'; }

    const winningCells = finished && boardWinner[b] !== 'D' ? getWinningCells(boards[b]) : [];

    for (let c = 0; c < 9; c++) {
      const cellEl = document.getElementById(`cell-${b}-${c}`);
      const val    = boards[b][c];
      cellEl.className = 'cell';
      if (val) {
        cellEl.classList.add('taken', val === 'X' ? 'x-cell' : 'o-cell');
        if (winningCells.includes(c)) cellEl.classList.add('winning-cell');
        cellEl.innerHTML = `<span class="cell-symbol">${val}</span>`;
      } else {
        cellEl.textContent = '';
        if (finished || outerWinner) cellEl.classList.add('board-finished');
      }
    }
  }

  if (outerWinner) drawOuterWinLine(outerWinner);

  // Background tint based on whose turn it is
  if (!outerWinner) {
    document.body.style.setProperty('--bg-tint',
      currentPlayer === 'X'
        ? 'rgba(255,77,77,0.04)'
        : 'rgba(77,170,255,0.04)'
    );
  } else {
    document.body.style.setProperty('--bg-tint', 'transparent');
  }

  // Highlight active player card
  document.getElementById('player-card-x').className = 'player-card' + (currentPlayer === 'X' && !outerWinner ? ' active-x' : '');
  document.getElementById('player-card-o').className = 'player-card' + (currentPlayer === 'O' && !outerWinner ? ' active-o' : '');

  renderStatus();
}

function showEndOverlay(result, subtitle = '') {
  // result: 'win' | 'loss' | 'draw' | 'oppleft'
  const overlay  = document.getElementById('end-overlay');
  const icon     = document.getElementById('end-icon');
  const title    = document.getElementById('end-title');
  const sub      = document.getElementById('end-subtitle');
  const newBtn   = document.getElementById('end-newgame-btn');

  // Hide New Game button for online games when opponent left
  // (no point replaying alone)
  if (result === 'oppleft') {
    newBtn.style.display = 'none';
  } else {
    newBtn.style.display = '';
  }

  if (result === 'win') {
    icon.textContent  = '🏆';
    title.textContent = 'You Win!';
    title.style.color = 'var(--active-glow)';
    sub.textContent   = subtitle || 'Well played!';
  } else if (result === 'loss') {
    icon.textContent  = '💀';
    title.textContent = 'You Lose';
    title.style.color = 'var(--x-color)';
    sub.textContent   = subtitle || 'Better luck next time.';
  } else if (result === 'draw') {
    icon.textContent  = '🤝';
    title.textContent = 'Draw!';
    title.style.color = 'var(--muted)';
    sub.textContent   = subtitle || 'Evenly matched.';
  } else if (result === 'oppleft') {
    icon.textContent  = '🏆';
    title.textContent = 'You Win!';
    title.style.color = 'var(--active-glow)';
    sub.textContent   = 'Opponent left the game.';
  }

  overlay.classList.remove('hidden');
}

function hideEndOverlay() {
  document.getElementById('end-overlay').classList.add('hidden');
  document.getElementById('end-newgame-btn').style.display = '';
}

function setIngameNewGameVisible(visible) {
  const btn = document.getElementById('ingame-newgame-btn');
  if (btn) btn.style.display = visible ? '' : 'none';
}

function renderStatus() {
  const el    = document.getElementById('status-content');
  const bar   = el.closest('.status-bar');
  const where = activeBoard === -1 ? 'any board' : `board ${activeBoard + 1}`;

  if (outerWinner === 'D') {
    el.innerHTML = `<span class="win-banner" style="color:#888">DRAW</span>`;
    setIngameNewGameVisible(true);
    showEndOverlay('draw');
    if (gameMode === 'online' && isRanked) roomRef.get().then(s => settleRating(s.val(),'D').then(d => showRatingDelta(d)));
    return;
  }

  if (outerWinner) {
    const col = outerWinner === 'X' ? 'var(--x-color)' : 'var(--o-color)';
    if (gameMode === 'local') {
      el.innerHTML = `<span class="win-banner" style="color:${col}">${outerWinner} WINS!</span>`;
      showEndOverlay('win', `${outerWinner} wins this round!`);
    } else {
      const youWon = outerWinner === myPlayer;
      el.innerHTML = `<span class="win-banner" style="color:${col}">${youWon ? 'YOU WIN!' : 'OPPONENT WINS!'}</span>`;
      setIngameNewGameVisible(true);
      showEndOverlay(youWon ? 'win' : 'loss');
      if (isRanked) roomRef.get().then(s => settleRating(s.val(), outerWinner).then(d => showRatingDelta(d)));
    }
    return;
  }

  if (gameMode === 'local') {
    // Flash the bar on turn change to signal the hand-off
    bar.classList.remove('pnp-flash');
    void bar.offsetWidth; // reflow to restart animation
    bar.classList.add('pnp-flash');

    el.innerHTML = `
      <span class="player-indicator">
        <span class="player-symbol ${currentPlayer.toLowerCase()}">${currentPlayer}</span>
        <span>— <span style="color:var(--active-glow)">${currentPlayer}'s turn</span> — play in
          <span style="color:var(--active-glow)">${where}</span>
        </span>
      </span>`;
  } else {
    const isMyTurn = currentPlayer === myPlayer;
    if (isMyTurn) {
      el.innerHTML = `
        <span class="player-indicator">
          <span class="player-symbol ${currentPlayer.toLowerCase()}">${currentPlayer}</span>
          <span>— <span style="color:var(--active-glow)">Your turn</span> — play in
            <span style="color:var(--active-glow)">${where}</span>
          </span>
        </span>`;
    } else {
      el.innerHTML = `
        <span class="player-indicator">
          <span class="player-symbol ${currentPlayer.toLowerCase()}">${currentPlayer}</span>
          <span style="color:var(--muted)">— Opponent is thinking...</span>
        </span>`;
    }
  }
}

// ─── Handle Click ─────────────────────────────────────────────────────────────
async function handleClick(b, c) {
  if (outerWinner)                             return;
  if (boardWinner[b] !== null)                 return;
  if (boards[b][c] !== null)                   return;
  if (activeBoard !== -1 && activeBoard !== b) return;

  // Online: only let the current player click
  if (gameMode === 'online' && currentPlayer !== myPlayer) return;

  applyMove(b, c);

  if (gameMode === 'online') {
    await roomRef.child('game').set(serializeGame({
      boards, boardWinner, outerWinner, activeBoard, currentPlayer, moveCount
    }));
    if (outerWinner) {
      await roomRef.child('scores').set(scores);
      clearInactivityTimer();
    } else {
      // The game listener will fire and call startInactivityTimer with the
      // server timestamp — no need to call it here separately
    }
  } else {
    // Local — just re-render
    render();
    if (outerWinner) {
      scores[outerWinner]++;
      document.getElementById('score-x').textContent = scores.X;
      document.getElementById('score-o').textContent = scores.O;
    }
  }
}

function applyMove(b, c) {
  boards[b][c] = currentPlayer;
  moveCount++;

  const innerWin = checkWinner(boards[b]);
  if (innerWin) {
    boardWinner[b] = innerWin;
  } else if (boards[b].every(v => v !== null)) {
    boardWinner[b] = 'D';
  }

  const outerWin = checkWinner(boardWinner.map(w => w === 'D' ? null : w));
  if (outerWin) {
    outerWinner = outerWin;
    if (gameMode === 'online') scores[outerWin]++;
  } else if (boardWinner.every(w => w !== null)) {
    const xCount = boardWinner.filter(w => w === 'X').length;
    const oCount = boardWinner.filter(w => w === 'O').length;
    outerWinner  = xCount > oCount ? 'X' : oCount > xCount ? 'O' : 'D';
    if (gameMode === 'online' && outerWinner !== 'D') scores[outerWinner]++;
  }

  if (!outerWinner) {
    activeBoard   = boardWinner[c] !== null ? -1 : c;
    currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
  }
}

// ─── Restart ──────────────────────────────────────────────────────────────────
async function restartGame() {
  const deltaEl = document.getElementById('end-rating-delta');
  if (deltaEl) deltaEl.classList.add('hidden');
  if (isRanked) refreshLobbyRating();
  document.body.style.setProperty('--bg-tint', 'transparent');

  if (gameMode === 'local') {
    hideEndOverlay();
    clearInactivityTimer();
    resetGameState();
    buildGrid();
    render();
    return;
  }

  // Online: require mutual consent — set our ready flag and wait
  if (!roomRef) return;

  const btn = document.getElementById('end-newgame-btn');
  btn.textContent  = '⏳ Waiting for opponent...';
  btn.disabled     = true;

  await roomRef.child('ready/' + myPlayer).set(true);
  // The readyListener in startOnlineGame handles the actual reset
  // when both players have clicked
}

// ─── Win Helpers ──────────────────────────────────────────────────────────────
function checkWinner(cells) {
  for (const [a, b, c] of WINS)
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  return null;
}

function getWinningCells(cells) {
  for (const [a, b, c] of WINS)
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return [a, b, c];
  return [];
}

function drawOuterWinLine(winner) {
  const svg     = document.getElementById('outer-win-svg');
  svg.innerHTML = '';
  const wl      = getWinLineCoords(boardWinner.map(w => w === 'D' ? null : w));
  if (!wl) return;
  const [r1, c1, r2, c2] = wl;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', c1 + 0.5); line.setAttribute('y1', r1 + 0.5);
  line.setAttribute('x2', c2 + 0.5); line.setAttribute('y2', r2 + 0.5);
  line.setAttribute('stroke', winner === 'X' ? '#ff4d4d' : '#4daaff');
  line.setAttribute('stroke-width', '0.12');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('opacity', '0.7');
  svg.appendChild(line);
}

function getWinLineCoords(cells) {
  for (const combo of WINS) {
    const [a, b, c] = combo;
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c])
      return [Math.floor(a / 3), a % 3, Math.floor(c / 3), c % 3];
  }
  return null;
}

// ─── Init ────────────────────────────────────────────────────────────────────
initLobby();

// ─── Dots Animation ───────────────────────────────────────────────────────────
let dotCount = 0;
setInterval(() => {
  const el = document.querySelector('.dots');
  if (el) { dotCount = (dotCount + 1) % 4; el.textContent = '.'.repeat(dotCount); }
}, 500);