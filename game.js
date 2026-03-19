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
const db = firebase.database();

// ─── Mode ─────────────────────────────────────────────────────────────────────
// 'online' = Firebase multiplayer   'local' = pass-and-play
let gameMode = null;

// ─── Online Session ───────────────────────────────────────────────────────────
let myPlayer        = null;
let roomId          = null;
let roomRef         = null;
let myQueueRef      = null;
let gameListener    = null;
let scoresListener  = null;
let playersListener = null;
const mySessionId   = Math.random().toString(36).slice(2);

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
  myPlayer  = null; // both players share the screen — no "my player"

  resetGameState();

  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('game-subtitle').textContent = 'Pass & Play';
  document.getElementById('room-info-bar').classList.add('hidden');
  document.getElementById('score-label-x').textContent = 'X — Wins';
  document.getElementById('score-label-o').textContent = 'O — Wins';

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
    moveCount:     state.moveCount
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

    await roomRef.child('players/' + joinerSeat).set(true);
    await roomRef.child('status').set('playing');
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
    createdAt:     Date.now()
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

  gameMode = 'online';

  // Find the open seat and join it
  const joinerSeat = rdata.players.X === false ? 'X' : 'O';

  roomId   = code;
  roomRef  = db.ref('rooms/' + roomId);
  myPlayer = joinerSeat;

  await roomRef.child('players/' + joinerSeat).set(true);
  await roomRef.child('status').set('playing');
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
  }
  gameListener = scoresListener = playersListener = null;
}

// ─── Start Online Game ────────────────────────────────────────────────────────
function startOnlineGame() {
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('game-subtitle').textContent = 'Online Multiplayer';
  document.getElementById('room-info-bar').classList.remove('hidden');
  document.getElementById('room-info-label').textContent = `Room: ${roomId}`;
  document.getElementById('my-player-label').textContent = `You are: ${myPlayer}`;

  buildGrid();

  gameListener = roomRef.child('game').on('value', snap => {
    if (!snap.exists()) return;
    deserializeGame(snap.val());
    render();
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
      document.getElementById('status-content').innerHTML =
        `<span class="win-banner" style="color:var(--muted)">Opponent left the game.</span>`;
    }
  });
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
  renderStatus();
}

function renderStatus() {
  const el    = document.getElementById('status-content');
  const bar   = el.closest('.status-bar');
  const where = activeBoard === -1 ? 'any board' : `board ${activeBoard + 1}`;

  if (outerWinner === 'D') {
    el.innerHTML = `<span class="win-banner" style="color:#888">IT'S A DRAW!</span>`;
    return;
  }

  if (outerWinner) {
    const col = outerWinner === 'X' ? 'var(--x-color)' : 'var(--o-color)';
    if (gameMode === 'local') {
      el.innerHTML = `<span class="win-banner" style="color:${col}">${outerWinner} WINS! 🎉</span>`;
    } else {
      el.innerHTML = `<span class="win-banner" style="color:${col}">${outerWinner === myPlayer ? 'YOU WIN! 🎉' : 'OPPONENT WINS!'}</span>`;
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
    if (outerWinner) await roomRef.child('scores').set(scores);
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
  if (gameMode === 'local') {
    resetGameState();
    buildGrid();
    render();
  } else {
    if (!roomRef) return;
    await roomRef.child('game').set(serializeGame(initialGameState()));
  }
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

// ─── Dots Animation ───────────────────────────────────────────────────────────
let dotCount = 0;
setInterval(() => {
  const el = document.querySelector('.dots');
  if (el) { dotCount = (dotCount + 1) % 4; el.textContent = '.'.repeat(dotCount); }
}, 500);