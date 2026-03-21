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
let names   = { X: '—', O: '—' };
let myName  = '';   // my display name — never changes on seat swap
let oppName = '';   // opponent display name — never changes on seat swap

// ─── Guest Mode ──────────────────────────────────────────────────────────────
let isGuest = false;
// Temporary in-memory stats for guests (cleared on session end)
let guestStats = { wins: 0, losses: 0, draws: 0, rating: STARTING_RATING };

function generateGuestName() {
  const adj  = ['Swift','Bold','Quiet','Brave','Sharp','Sly','Wild','Cool'];
  const noun = ['Fox','Bear','Wolf','Hawk','Lion','Tiger','Panda','Eagle'];
  const num  = Math.floor(Math.random() * 900) + 100;
  return adj[Math.floor(Math.random()*adj.length)] + noun[Math.floor(Math.random()*noun.length)] + num;
}

function playAsGuest() {
  isGuest = true;
  // Keep same guest name for this tab session (survives tab switches but not closes)
  myUsername = sessionStorage.getItem('ttt2_guest_name') || generateGuestName();
  sessionStorage.setItem('ttt2_guest_name', myUsername);
  // Keep stats from this session if returning to lobby
  const savedStats = sessionStorage.getItem('ttt2_guest_stats');
  guestStats = savedStats ? JSON.parse(savedStats) : { wins: 0, losses: 0, draws: 0, rating: STARTING_RATING };
  showLobbyMain(myUsername);
  document.getElementById('lobby-guest-upgrade').classList.remove('hidden');
}

function upgradeGuest() {
  // Show username entry pre-filled, then password setup
  document.getElementById('lobby-guest-upgrade').classList.add('hidden');
  document.getElementById('lobby-main').classList.add('hidden');
  document.getElementById('lobby-username').classList.remove('hidden');
  document.getElementById('username-input').value = '';
  document.getElementById('username-input').focus();
  document.getElementById('username-error').textContent = '';
  // After account creation, transfer guest stats
  pendingGuestUpgrade = true;
}

let pendingGuestUpgrade = false;

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
  // Release old username if different (and it was a real username, not a guest)
  if (myUsername && myUsername !== name && !isGuest) {
    const oldKey  = nameKey(myUsername);
    const oldSnap = await db.ref('usernames/' + oldKey).get();
    if (oldSnap.exists() && oldSnap.val().playerId === myPlayerId) {
      await db.ref('usernames/' + oldKey).remove();
    }
  }

  // If upgrading from guest, write guest stats to the new profile
  if (isGuest && pendingGuestUpgrade && guestStats.wins + guestStats.losses + guestStats.draws > 0) {
    const existing = await loadProfile(myPlayerId);
    await db.ref('players/' + myPlayerId).update({
      rating:   guestStats.rating,
      wins:     (existing.wins   || 0) + guestStats.wins,
      losses:   (existing.losses || 0) + guestStats.losses,
      draws:    (existing.draws  || 0) + guestStats.draws,
      username: name
    });
  }

  isGuest             = false;
  pendingGuestUpgrade = false;
  myUsername          = name;
  localStorage.setItem('ttt2_username', name);
  document.getElementById('lobby-guest-upgrade').classList.add('hidden');
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
  pendingUsername      = '';
  pendingGuestUpgrade  = false; // don't transfer stats if user backed out
}

async function showLobbyMain(name) {
  ['lobby-username','lobby-set-password','lobby-login-password',
   'lobby-searching','lobby-waiting'].forEach(id =>
    document.getElementById(id).classList.add('hidden'));
  document.getElementById('lobby-main').classList.remove('hidden');
  ['cpu-picker','private-picker'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });

  // Load rating and display alongside username
  const el = document.getElementById('username-display');
  if (isGuest) {
    const gRating = guestStats.rating || STARTING_RATING;
    el.innerHTML = '👤 ' + name + ' <span class="lobby-rating-badge guest-badge">' + gRating + ' pts (guest)</span>';
  } else {
    // If we have a fresh cached rating from a just-played game, use it immediately.
    // Otherwise read from Firebase (initial load, or after a refresh).
    const cachedRating = (myGameRating && myGameRating !== STARTING_RATING) ? myGameRating : null;
    if (cachedRating) {
      el.innerHTML = name + ' <span class="lobby-rating-badge">' + cachedRating + ' pts</span>';
      // Also do a Firebase read in background to stay in sync
      loadProfile(myPlayerId).then(p => {
        const r = p.rating || STARTING_RATING;
        el.innerHTML = name + ' <span class="lobby-rating-badge">' + r + ' pts</span>';
      });
    } else {
      const profile = await loadProfile(myPlayerId);
      const rating  = profile.rating || STARTING_RATING;
      el.innerHTML  = name + ' <span class="lobby-rating-badge">' + rating + ' pts</span>';
    }
  }
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
      isGuest = false;
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
  if (isGuest) return { ...guestStats, username: myUsername };
  const ref  = db.ref('players/' + playerId);
  const snap = await ref.get();
  if (snap.exists()) return snap.val();
  const fresh = { rating: STARTING_RATING, wins: 0, losses: 0, draws: 0 };
  await ref.set(fresh);
  return fresh;
}

async function settleRating(roomData, winner) {
  if (!roomData || !roomData.ranked) return null;
  const hostId  = roomData.hostId;
  const guestId = roomData.guestId;
  if (!hostId || !guestId) return null;

  const hostSeat  = roomData.creatorPlayer || 'X';
  const guestSeat = hostSeat === 'X' ? 'O' : 'X';

  const hostIsGuest  = roomData.hostPlayerIsGuest  === true || (myPlayerId === hostId  && isGuest);
  const guestIsGuest = roomData.guestPlayerIsGuest === true || (myPlayerId === guestId && isGuest);

  // Use the ratings stored in the room at game start — these are always correct
  // even when one player is a guest (guest never writes to Firebase, so loadProfile
  // would return a stale 1200 for them)
  const hostRatingStart  = roomData.hostRating  || STARTING_RATING;
  const guestRatingStart = roomData.guestRating || STARTING_RATING;

  // For win/loss/draw counts, fetch registered players' profiles (guests have in-memory stats)
  const hostProf  = hostIsGuest  ? { wins:0, losses:0, draws:0 } : (await loadProfile(hostId));
  const guestProf = guestIsGuest ? { wins:0, losses:0, draws:0 } : (await loadProfile(guestId));

  const hostOutcome  = getOutcome(winner, hostSeat);
  const guestOutcome = getOutcome(winner, guestSeat);
  const ratingDiff   = Math.abs(hostRatingStart - guestRatingStart);
  let hostDelta  = calcEloDelta(hostRatingStart,  guestRatingStart, hostOutcome);
  let guestDelta = calcEloDelta(guestRatingStart, hostRatingStart,  guestOutcome);
  if (winner === 'D' && ratingDiff < DRAW_DIFF_THRESH) { hostDelta = 0; guestDelta = 0; }

  // Transaction: only ONE client writes to Firebase
  const settledRef = roomRef.child('ratingSettled');
  let didSettle = false;
  await settledRef.transaction(cur => {
    if (cur) return;
    didSettle = true;
    return true;
  });

  if (didSettle) {
    const hostUpdates = {
      rating:   Math.max(0, hostRatingStart  + hostDelta),
      wins:     (hostProf.wins   || 0) + (hostOutcome  === 1   ? 1 : 0),
      losses:   (hostProf.losses || 0) + (hostOutcome  === 0   ? 1 : 0),
      draws:    (hostProf.draws  || 0) + (hostOutcome  === 0.5 ? 1 : 0),
      username: roomData.usernameHost  || ''
    };
    const guestUpdates = {
      rating:   Math.max(0, guestRatingStart + guestDelta),
      wins:     (guestProf.wins   || 0) + (guestOutcome === 1   ? 1 : 0),
      losses:   (guestProf.losses || 0) + (guestOutcome === 0   ? 1 : 0),
      draws:    (guestProf.draws  || 0) + (guestOutcome === 0.5 ? 1 : 0),
      username: roomData.usernameGuest || ''
    };

    // Update guest in-memory stats
    if (myPlayerId === hostId && hostIsGuest) {
      guestStats = { ...hostUpdates };
      sessionStorage.setItem('ttt2_guest_stats', JSON.stringify(guestStats));
    } else if (myPlayerId === guestId && guestIsGuest) {
      guestStats = { ...guestUpdates };
      sessionStorage.setItem('ttt2_guest_stats', JSON.stringify(guestStats));
    }

    // Write to Firebase only for non-guest players
    const writes = [];
    if (!hostIsGuest)  writes.push(db.ref('players/' + hostId).update(hostUpdates));
    if (!guestIsGuest) writes.push(db.ref('players/' + guestId).update(guestUpdates));
    if (writes.length) await Promise.all(writes);
  }

  // Both players return their own delta regardless of who wrote
  if (myPlayerId === hostId)  return hostDelta;
  if (myPlayerId === guestId) return guestDelta;
  return null;
}

function showInstantDelta(winner) {
  if (!myPlayer || !isRanked) return;
  const outcome    = winner === 'D' ? 0.5 : winner === myPlayer ? 1 : 0;
  const oppOutcome = 1 - outcome;
  const drawFlat   = winner === 'D' && Math.abs(myGameRating - oppGameRating) < DRAW_DIFF_THRESH;
  const myDelta    = drawFlat ? 0 : calcEloDelta(myGameRating, oppGameRating, outcome);
  const oppDelta   = drawFlat ? 0 : calcEloDelta(oppGameRating, myGameRating, oppOutcome);
  showRatingDelta(myDelta);
  // Update both cached ratings so rematch ELO is calculated from correct post-game values
  myGameRating  = Math.max(0, myGameRating  + myDelta);
  oppGameRating = Math.max(0, oppGameRating + oppDelta);
}

async function showRatingDelta(delta) {
  if (delta === null || delta === undefined) return;
  const el = document.getElementById('end-rating-delta');
  el.classList.remove('hidden','gain','loss','none');
  if (delta === 0) { el.textContent = 'Rating unchanged'; el.classList.add('none'); }
  else { el.textContent = (delta > 0 ? '+' : '') + delta + ' pts'; el.classList.add(delta > 0 ? 'gain' : 'loss'); }

  // Refresh lobby badge and my player card immediately
  refreshLobbyRating();
  if (myPlayer) {
    const profile = await loadProfile(myPlayerId);
    const myCard  = document.getElementById('pc-rating-' + myPlayer.toLowerCase());
    if (myCard) myCard.textContent = (profile.rating || STARTING_RATING) + ' pts';
  }
}

async function refreshLobbyRating() {
  const el = document.getElementById('username-display');
  if (!el) return;
  if (isGuest) {
    // guestStats.rating is always current (updated by showInstantDelta)
    const gRating = guestStats.rating || STARTING_RATING;
    el.innerHTML = '👤 ' + myUsername + ' <span class="lobby-rating-badge guest-badge">' + gRating + ' pts (guest)</span>';
    return;
  }
  // myGameRating is updated synchronously by showInstantDelta — always current.
  // Use it directly rather than waiting for a Firebase read.
  const rating = myGameRating || STARTING_RATING;
  el.innerHTML = myUsername + ' <span class="lobby-rating-badge">' + rating + ' pts</span>';
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
let lastMoveB     = -1; // board index of last move
let lastMoveC     = -1; // cell index of last move
let boards      = Array.from({ length: 9 }, () => Array(9).fill(null));
let boardWinner = Array(9).fill(null);
let outerWinner = null;
let activeBoard = -1;
let ratingShown   = false;
let myGameRating  = STARTING_RATING;
let oppGameRating = STARTING_RATING;
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
  gameMode      = 'local';
  myPlayer      = null;
  cpuDifficulty = null;
  cpuPlayer     = null;
  cpuThinking   = false;
  names         = { X: 'Player X', O: 'Player O' };

  document.getElementById('outer-win-svg').innerHTML = '';
  scores = { X: 0, O: 0 };
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

// ─── CPU / AI ─────────────────────────────────────────────────────────────────
let cpuDifficulty = null;
let cpuPlayer     = null;
let cpuThinking   = false;

let pendingCpuSide = 'X'; // default player side

function openCpuPicker() {
  document.getElementById('cpu-picker').classList.remove('hidden');
  document.getElementById('private-picker').classList.add('hidden');
  // Default select X
  pendingCpuSide = 'X';
  document.querySelector('.cpu-side-btn.x-side').classList.add('selected');
  document.querySelector('.cpu-side-btn.o-side').classList.remove('selected');
}

function closeCpuPicker() {
  document.getElementById('cpu-picker').classList.add('hidden');
}

function setCpuSide(side) {
  pendingCpuSide = side;
  document.querySelector('.cpu-side-btn.x-side').classList.toggle('selected', side === 'X');
  document.querySelector('.cpu-side-btn.o-side').classList.toggle('selected', side === 'O');
}

function confirmCpuStart(difficulty) {
  closeCpuPicker();
  startVsCPU(difficulty, pendingCpuSide);
}

function openPrivatePicker() {
  document.getElementById('private-picker').classList.remove('hidden');
  document.getElementById('cpu-picker').classList.add('hidden');
  document.getElementById('join-input').focus();
}

function closePrivatePicker() {
  document.getElementById('private-picker').classList.add('hidden');
}

function startVsCPU(difficulty, playerSide) {
  cpuDifficulty = difficulty;
  myPlayer  = playerSide || 'X';
  cpuPlayer = myPlayer === 'X' ? 'O' : 'X';
  gameMode  = 'local';
  isRanked  = false;
  names     = { [myPlayer]: myUsername || 'You', [cpuPlayer]: 'CPU (' + difficulty + ')' };
  resetGameState();
  scores = { X: 0, O: 0 };
  document.getElementById('outer-win-svg').innerHTML = '';
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('game-subtitle-left').textContent = 'vs CPU';
  document.getElementById('room-info-bar').classList.add('hidden');
  document.getElementById('pc-name-x').textContent = names.X;
  document.getElementById('pc-name-o').textContent = names.O;
  document.getElementById('pc-rating-' + myPlayer.toLowerCase()).textContent = '';
  document.getElementById('pc-rating-' + cpuPlayer.toLowerCase()).textContent = difficulty.toUpperCase();
  document.getElementById('score-x').textContent = '0';
  document.getElementById('score-o').textContent = '0';
  buildGrid();
  render();
  // If player chose O, CPU is X and goes first
  if (cpuPlayer === currentPlayer) scheduleCpuMove();
}

function scheduleCpuMove() {
  if (!cpuDifficulty || currentPlayer !== cpuPlayer || outerWinner || cpuThinking) return;
  cpuThinking = true;
  const delay = cpuDifficulty === 'easy' ? 400 : cpuDifficulty === 'medium' ? 650 : 950;
  setTimeout(() => {
    const move = getCpuMove();
    if (move) {
      applyMove(move.b, move.c);
      render();
      if (outerWinner) {
        scores[outerWinner]++;
        document.getElementById('score-x').textContent = scores.X;
        document.getElementById('score-o').textContent = scores.O;
      }
    }
    cpuThinking = false;
  }, delay);
}

function getCpuMove() {
  const validBoards = getValidBoards();
  const allMoves = [];
  for (const b of validBoards)
    for (let c = 0; c < 9; c++)
      if (boards[b][c] === null) allMoves.push({ b, c });
  if (!allMoves.length) return null;
  if (cpuDifficulty === 'easy')   return Math.random() < 0.8 ? randomMove(allMoves) : bestHeuristicMove(allMoves);
  if (cpuDifficulty === 'medium') {
    const forced = forcedMove(allMoves);
    if (forced) return forced;
    return Math.random() < 0.5 ? bestHeuristicMove(allMoves) : randomMove(allMoves);
  }
  return bestHeuristicMove(allMoves);
}

function getValidBoards() {
  if (activeBoard !== -1 && boardWinner[activeBoard] === null) return [activeBoard];
  return [0,1,2,3,4,5,6,7,8].filter(b => boardWinner[b] === null);
}
function randomMove(moves) { return moves[Math.floor(Math.random() * moves.length)]; }

function forcedMove(moves) {
  const opp = cpuPlayer === 'X' ? 'O' : 'X';
  for (const { b, c } of moves) if (wouldWinBoard(b, c, cpuPlayer)) return { b, c };
  for (const { b, c } of moves) if (wouldWinBoard(b, c, opp))       return { b, c };
  return null;
}
function wouldWinBoard(b, c, player) {
  const sim = [...boards[b]]; sim[c] = player;
  return checkWinner(sim) === player;
}

function bestHeuristicMove(moves) {
  let best = -Infinity, bestMove = moves[0];
  for (const m of moves) { const s = scoreMove(m.b, m.c); if (s > best) { best = s; bestMove = m; } }
  return bestMove;
}

function scoreMove(b, c) {
  let score = 0;
  const opp = cpuPlayer === 'X' ? 'O' : 'X';
  if (wouldWinBoard(b, c, cpuPlayer)) score += 100;
  if (wouldWinBoard(b, c, opp))       score += 80;
  score += outerBoardStrategicValue(b) * 3;
  score += cellPositionValue(c);
  const nb = c;
  if (boardWinner[nb] !== null) {
    score -= 5;
  } else {
    for (let nc = 0; nc < 9; nc++) {
      if (boards[nb][nc] === null) {
        const sim = [...boards[nb]]; sim[nc] = opp;
        if (checkWinner(sim) === opp) { score -= 40; break; }
      }
    }
    score += boardStrengthFor(nb, cpuPlayer) * 4;
    score -= boardStrengthFor(nb, opp) * 3;
  }
  score += outerProgressValue(b, cpuPlayer) * 5;
  return score;
}

function cellPositionValue(c) {
  if (c === 4) return 8;
  if (c === 0 || c === 2 || c === 6 || c === 8) return 5;
  return 3;
}
function outerBoardStrategicValue(b) { return WINS.filter(combo => combo.includes(b)).length; }
function boardStrengthFor(b, player) { return boards[b].filter(v => v === player).length; }
function outerProgressValue(b, player) {
  let value = 0;
  const won = boardWinner.map((w,i) => w === player ? i : -1).filter(i => i >= 0);
  for (const combo of WINS) {
    if (!combo.includes(b)) continue;
    value += combo.filter(i => won.includes(i)).length;
  }
  return value;
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
  ratingShown   = false;
  lastMoveB     = -1;
  lastMoveC     = -1;
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
    lastMoveB:     state.lastMoveB !== undefined ? state.lastMoveB : -1,
    lastMoveC:     state.lastMoveC !== undefined ? state.lastMoveC : -1,
    lastMoveAt:    firebase.database.ServerValue.TIMESTAMP
  };
}

function deserializeGame(data) {
  boards        = JSON.parse(data.boards);
  boardWinner   = JSON.parse(data.boardWinner);
  outerWinner   = data.outerWinner || null;
  activeBoard   = data.activeBoard;
  currentPlayer = data.currentPlayer;
  moveCount = data.moveCount;
  lastMoveB = (data.lastMoveB !== undefined) ? data.lastMoveB : -1;
  lastMoveC = (data.lastMoveC !== undefined) ? data.lastMoveC : -1;
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
  if (isGuest) myRoomData.hostPlayerIsGuest = true;
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
    if (isGuest) await roomRef.child('guestPlayerIsGuest').set(true);
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
    usernameHost:  myUsername,
    hostId:        myPlayerId
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
  if (isGuest) await roomRef.child('guestPlayerIsGuest').set(true);
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
  isRanked      = false;
  ratingShown   = false;
  const deltaEl = document.getElementById('end-rating-delta');
  if (deltaEl) deltaEl.classList.add('hidden');
  cpuDifficulty = null; cpuPlayer = null; cpuThinking = false;
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
  document.getElementById('room-info-bar').classList.add('hidden'); // hide, not show
  document.getElementById('lobby-screen').classList.remove('hidden');
  // Re-show lobby main (also restores guest upgrade banner if in guest mode)
  await showLobbyMain(myUsername);
  const jiEl = document.getElementById('join-input'); if (jiEl) jiEl.value = '';
  setLobbyError('');
  ['cpu-picker','private-picker'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
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

  // Always sync isRanked from the room data — single source of truth
  isRanked = rdata.ranked === true;

  const hostUser  = rdata.usernameHost  || 'Unknown';
  const guestUser = rdata.usernameGuest || 'Unknown';
  const hostSeat  = rdata.creatorPlayer || 'X';
  const guestSeat = hostSeat === 'X' ? 'O' : 'X';

  // Cache names permanently — these never change regardless of seat swaps
  myName  = (myPlayer === hostSeat) ? hostUser  : guestUser;
  oppName = (myPlayer === hostSeat) ? guestUser : hostUser;

  names[myPlayer]                         = myName;
  names[myPlayer === 'X' ? 'O' : 'X']    = oppName;

  document.getElementById('pc-name-x').textContent = names.X;
  document.getElementById('pc-name-o').textContent = names.O;
  // Keep in-session scores (don't reset to 0 — scoresListener only fires on change)
  document.getElementById('score-x').textContent = scores.X || 0;
  document.getElementById('score-o').textContent = scores.O || 0;
  if (rdata.ranked) {
    const hRat = rdata.hostRating  || STARTING_RATING;
    const gRat = rdata.guestRating || STARTING_RATING;
    document.getElementById('pc-rating-' + hostSeat.toLowerCase()).textContent  = hRat + ' pts';
    document.getElementById('pc-rating-' + guestSeat.toLowerCase()).textContent = gRat + ' pts';
    myGameRating  = (myPlayer === hostSeat) ? hRat : gRat;
    oppGameRating = (myPlayer === hostSeat) ? gRat : hRat;
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
      const gName = snap.val();
      names[guestSeat] = gName;
      document.getElementById('pc-name-' + guestSeat.toLowerCase()).textContent = gName;
      // Also update cached myName/oppName so rematch names are correct
      if (myPlayer === guestSeat) myName  = gName;
      else                        oppName = gName;
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

    // Only reset overlay/button when a fresh game starts (not on game-over syncs)
    if (!outerWinner) {
      const btn = document.getElementById('end-newgame-btn');
      if (btn) { btn.textContent = '↺  New Game'; btn.disabled = false; btn.style.color = ''; }
      hideEndOverlay();
    }

    // Clear win line and refresh ratings when a fresh game starts
    if (!outerWinner) {
      document.getElementById('outer-win-svg').innerHTML = '';
      setIngameNewGameVisible(!isRanked);
      if (isRanked) {
        roomRef.get().then(async snap => {
          if (!snap.exists()) return;
          const rd = snap.val();
          if (!rd.hostId || !rd.guestId) return;
          const hSeat = (rd.creatorPlayer || 'X').toLowerCase();
          const gSeat = hSeat === 'x' ? 'o' : 'x';
          const [hProf, gProf] = await Promise.all([loadProfile(rd.hostId), loadProfile(rd.guestId)]);
          const hEl = document.getElementById('pc-rating-' + hSeat);
          const gEl = document.getElementById('pc-rating-' + gSeat);
          if (hEl) hEl.textContent = (hProf.rating || STARTING_RATING) + ' pts';
          if (gEl) gEl.textContent = (gProf.rating || STARTING_RATING) + ' pts';
        });
      }
    }

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

  let oppLeftTimer = null; // grace-period timer for network switches

  playersListener = roomRef.child('players').on('value', snap => {
    if (!snap.exists()) return;
    const players  = snap.val();
    const opponent = myPlayer === 'X' ? 'O' : 'X';

    if (players[opponent] === false && !outerWinner) {
      // Give opponent 8 seconds to reconnect (covers WiFi → mobile handoff)
      if (oppLeftTimer) return; // already waiting
      oppLeftTimer = setTimeout(async () => {
        oppLeftTimer = null;
        // Re-check: did they come back?
        const reSnap = await roomRef.child('players/' + opponent).get();
        if (reSnap.val() === false && !outerWinner) {
          clearInactivityTimer();
          outerWinner = myPlayer;
          setIngameNewGameVisible(true);
          showEndOverlay('oppleft');
          if (isRanked && !ratingShown) { ratingShown = true; showInstantDelta(myPlayer); roomRef.get().then(s => settleRating(s.val(), myPlayer)); }
        }
      }, 8000);
    } else if (players[opponent] === true && oppLeftTimer) {
      // Opponent reconnected within grace period — cancel the timer
      clearTimeout(oppLeftTimer);
      oppLeftTimer = null;
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
      if (isRanked && !ratingShown) { ratingShown = true; showInstantDelta(outerWinner); roomRef.get().then(s => settleRating(s.val(), outerWinner)); }
    }
  });

  // Listen for ready / rematch state changes
  let oppWasReady = false; // track whether opponent ever set their ready flag
  readyListener = roomRef.child('ready').on('value', async snap => {
    const ready    = snap.exists() ? snap.val() : {};
    const opponent = myPlayer === 'X' ? 'O' : 'X';

    // Both players ready — swap seats and start new game
    if (ready.X === true && ready.O === true) {
      oppWasReady = false;
      ratingShown = false;

      // Flip seats — both clients do this identically
      myPlayer = myPlayer === 'X' ? 'O' : 'X';

      // Rebuild names dict (myName/oppName are pinned to players, not seats)
      names[myPlayer]                      = myName;
      names[myPlayer === 'X' ? 'O' : 'X'] = oppName;
      document.getElementById('pc-name-x').textContent = names.X;
      document.getElementById('pc-name-o').textContent = names.O;

      // Read current room to find new creatorPlayer value, then update it.
      // This ensures the game listener reads the correct hSeat when refreshing ratings.
      const rsSnap = await roomRef.get();
      const rsData = rsSnap.val() || {};
      const curCreator = rsData.creatorPlayer || 'X';
      const newCreator = curCreator === 'X' ? 'O' : 'X';

      // Only the original host writes — guest reads. Both derive myGameRating correctly.
      const amHost = rsData.hostId === myPlayerId;
      if (amHost) {
        await roomRef.child('creatorPlayer').set(newCreator);
      }

      // Also update cached ratings to match new creatorPlayer
      // hSeat = newCreator, so host's rating now belongs to newCreator card
      const hProf = await loadProfile(rsData.hostId  || myPlayerId);
      const gProf = await loadProfile(rsData.guestId || myPlayerId);
      myGameRating  = amHost ? hProf.rating : gProf.rating;
      oppGameRating = amHost ? gProf.rating : hProf.rating;

      await roomRef.child('ready').remove();
      await roomRef.child('forfeit').remove();
      await roomRef.child('ratingSettled').remove();
      await roomRef.child('game').set(serializeGame(initialGameState()));
      return;
    }

    // Opponent pressed New Game — show pulsing notification
    if (ready[opponent] === true) {
      oppWasReady = true;
      const notif = document.getElementById('rematch-notif');
      if (notif) notif.classList.remove('hidden');
    }

    // Opponent's ready flag was cleared AFTER being set = they went home
    if (oppWasReady && !ready[opponent] && ready[myPlayer] === true) {
      oppWasReady = false;
      const btn = document.getElementById('end-newgame-btn');
      if (btn) {
        btn.textContent = '✕ Opponent went home';
        btn.disabled    = true;
        btn.style.color = 'var(--muted)';
      }
      const notif = document.getElementById('rematch-notif');
      if (notif) notif.classList.add('hidden');
    }

    // If no ready flags at all, reset the notification (fresh state)
    if (!ready[opponent] && !ready[myPlayer]) {
      oppWasReady = false;
      const notif = document.getElementById('rematch-notif');
      if (notif) notif.classList.add('hidden');
    }
  });

  // Don't start timer here — the game listener will start it with the
  // correct server timestamp when the first game state arrives
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
        if (b === lastMoveB && c === lastMoveC) cellEl.classList.add('last-move');
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
    newBtn.textContent = (gameMode === 'online') ? '↺  Rematch' : '↺  New Game';
  }

  if (result === 'pnp-win') {
    icon.textContent  = '🏆';
    title.textContent = subtitle.split(' ')[0] + ' Wins!';
    title.style.color = 'var(--active-glow)';
    sub.textContent   = '';
  } else if (result === 'win') {
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
  const btn = document.getElementById('end-newgame-btn');
  btn.style.display = ''; btn.disabled = false;
  btn.style.color = ''; btn.textContent = '↺  New Game';
  const notif = document.getElementById('rematch-notif');
  if (notif) notif.classList.add('hidden');
  // Always clear the rating delta so it never persists into unranked games
  const deltaEl = document.getElementById('end-rating-delta');
  if (deltaEl) deltaEl.classList.add('hidden');
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
    if (gameMode === 'online' && isRanked && !ratingShown) { ratingShown = true; showInstantDelta('D'); roomRef.get().then(s => settleRating(s.val(), 'D')); }
    return;
  }

  if (outerWinner) {
    const col = outerWinner === 'X' ? 'var(--x-color)' : 'var(--o-color)';
    if (gameMode === 'local') {
      if (cpuDifficulty) {
        const playerWon = outerWinner === myPlayer;
        el.innerHTML = `<span class="win-banner" style="color:${col}">${playerWon ? 'YOU WIN!' : 'CPU WINS!'}</span>`;
        showEndOverlay(playerWon ? 'win' : 'loss', playerWon ? 'Great play!' : 'The CPU got you.');
      } else {
        el.innerHTML = `<span class="win-banner" style="color:${col}">${outerWinner} WINS!</span>`;
        // Pass & Play: show which side won, not "you win"
        showEndOverlay('pnp-win', `${outerWinner} wins this round!`);
      }
    } else {
      const youWon = outerWinner === myPlayer;
      el.innerHTML = `<span class="win-banner" style="color:${col}">${youWon ? 'YOU WIN!' : 'OPPONENT WINS!'}</span>`;
      setIngameNewGameVisible(true);
      showEndOverlay(youWon ? 'win' : 'loss');
      if (isRanked && !ratingShown) { ratingShown = true; showInstantDelta(outerWinner); roomRef.get().then(s => settleRating(s.val(), outerWinner)); }
    }
    return;
  }

  if (gameMode === 'local') {
    if (cpuDifficulty && currentPlayer === cpuPlayer) {
      el.innerHTML = `<span class="player-indicator"><span class="player-symbol ${currentPlayer.toLowerCase()}">${currentPlayer}</span><span style="color:var(--muted)">— 🤖 CPU is thinking...</span></span>`;
      return;
    }
    // Flash the bar on turn change to signal the hand-off
    bar.classList.remove('pnp-flash');
    void bar.offsetWidth; // reflow to restart animation
    bar.classList.add('pnp-flash');

    el.innerHTML = `
      <span class="player-indicator">
        <span class="player-symbol ${currentPlayer.toLowerCase()}">${currentPlayer}</span>
        <span>— <span style="color:var(--active-glow)">${cpuDifficulty ? 'Your turn' : currentPlayer + "'s turn"}</span> — play in
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
  if (cpuDifficulty && (currentPlayer === cpuPlayer || cpuThinking)) return;

  applyMove(b, c);

  if (gameMode === 'online') {
    await roomRef.child('game').set(serializeGame({
      boards, boardWinner, outerWinner, activeBoard, currentPlayer, moveCount,
      lastMoveB, lastMoveC
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
    } else if (cpuDifficulty) {
      scheduleCpuMove();
    }
  }
}

function applyMove(b, c) {
  lastMoveB = b;
  lastMoveC = c;
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
  refreshLobbyRating(); // always refresh so guest and ranked ratings update
  document.body.style.setProperty('--bg-tint', 'transparent');

  if (gameMode === 'local') {
    hideEndOverlay();
    clearInactivityTimer();
    document.getElementById('outer-win-svg').innerHTML = '';
    resetGameState();
    cpuThinking = false;
    buildGrid();
    render();
    if (cpuDifficulty && cpuPlayer === currentPlayer) scheduleCpuMove();
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