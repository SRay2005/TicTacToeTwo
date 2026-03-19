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

// ─── Session ──────────────────────────────────────────────────────────────────
let myPlayer         = null;   // 'X' or 'O'
let roomId           = null;
let roomRef          = null;
let myQueueRef       = null;   // ref to this player's spot in the matchmaking queue
let gameListener     = null;
let scoresListener   = null;
let playersListener  = null;

// Stable ID for this browser session (survives page interactions, resets on close)
const mySessionId = Math.random().toString(36).slice(2);

// ─── Game State ───────────────────────────────────────────────────────────────
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

let currentPlayer = 'X';
let boards      = Array.from({ length: 9 }, () => Array(9).fill(null));
let boardWinner = Array(9).fill(null);
let outerWinner = null;
let activeBoard = -1;
let scores      = { X: 0, O: 0 };
let moveCount   = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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

// ─── Quick Match (Matchmaking) ────────────────────────────────────────────────
// Strategy:
//   The Firebase path `matchmaking/queue` holds entries keyed by sessionId.
//   Each entry: { roomId, timestamp }
//   When a player enters:
//     1. Scan the queue for an existing entry that isn't theirs.
//     2. If found → join that person's room as O, remove them from queue.
//     3. If not found → create a room as X, add yourself to the queue, wait.

async function quickMatch() {
  setLobbyError('');
  showLobbyPanel('lobby-searching');

  const queueRef = db.ref('matchmaking/queue');

  // Look for someone already waiting
  const snap = await queueRef.orderByChild('timestamp').limitToFirst(10).get();

  let foundMatch = false;

  if (snap.exists()) {
    const entries = snap.val();
    for (const [sid, entry] of Object.entries(entries)) {
      // Skip stale entries (older than 2 minutes) and our own
      const age = Date.now() - entry.timestamp;
      if (sid === mySessionId || age > 120000) continue;

      // Try to atomically claim this slot
      const claimed = await claimQueueSlot(sid, entry.roomId);
      if (claimed) {
        foundMatch = true;
        // Join the room that person created
        await joinAsO(entry.roomId);
        break;
      }
    }
  }

  if (!foundMatch) {
    // No one waiting — create a room and add ourselves to the queue
    roomId   = generateRoomId();
    roomRef  = db.ref(`rooms/${roomId}`);
    myPlayer = 'X';

    await roomRef.set({
      players: { X: true, O: false },
      game:    serializeGame(initialGameState()),
      scores:  { X: 0, O: 0 },
      status:  'waiting',
      mode:    'matchmaking'
    });

    // Auto-clean room on disconnect
    roomRef.onDisconnect().remove();

    // Add to matchmaking queue; auto-remove on disconnect
    myQueueRef = db.ref(`matchmaking/queue/${mySessionId}`);
    await myQueueRef.set({ roomId, timestamp: Date.now() });
    myQueueRef.onDisconnect().remove();

    // Watch for O joining
    roomRef.child('players/O').on('value', snap => {
      if (snap.val() === true) {
        roomRef.child('players/O').off();
        // Clean up our queue entry since we got matched
        if (myQueueRef) {
          myQueueRef.onDisconnect().cancel();
          myQueueRef.remove();
          myQueueRef = null;
        }
        startGame();
      }
    });
  }
}

// Atomically remove a queue entry — returns true if we were first to claim it
async function claimQueueSlot(sessionId, targetRoomId) {
  const slotRef = db.ref(`matchmaking/queue/${sessionId}`);
  let claimed = false;

  await slotRef.transaction(current => {
    if (current === null) return; // already claimed by someone else — abort
    claimed = true;
    return null; // delete it
  });

  return claimed;
}

async function joinAsO(targetRoomId) {
  const snap = await db.ref(`rooms/${targetRoomId}`).get();

  if (!snap.exists() || snap.val().players.O === true) {
    // Room vanished or was already filled — go back to searching
    await quickMatch();
    return;
  }

  roomId   = targetRoomId;
  roomRef  = db.ref(`rooms/${roomId}`);
  myPlayer = 'O';

  await roomRef.child('players/O').set(true);
  await roomRef.child('status').set('playing');
  roomRef.child('players/O').onDisconnect().set(false);

  startGame();
}

async function cancelMatchmaking() {
  // Remove from queue if we were waiting
  if (myQueueRef) {
    myQueueRef.onDisconnect().cancel();
    await myQueueRef.remove();
    myQueueRef = null;
  }
  // Delete the room we may have created
  if (roomRef) {
    roomRef.onDisconnect().cancel();
    await roomRef.remove();
    roomRef = null;
  }
  roomId   = null;
  myPlayer = null;
  showLobbyPanel('lobby-main');
}

// ─── Create Private Room ──────────────────────────────────────────────────────
async function createRoom() {
  setLobbyError('');
  roomId   = generateRoomId();
  roomRef  = db.ref(`rooms/${roomId}`);
  myPlayer = 'X';

  await roomRef.set({
    players: { X: true, O: false },
    game:    serializeGame(initialGameState()),
    scores:  { X: 0, O: 0 },
    status:  'waiting',
    mode:    'private'
  });

  roomRef.onDisconnect().remove();

  showLobbyPanel('lobby-waiting');
  document.getElementById('room-code-display').textContent = roomId;

  roomRef.child('players/O').on('value', snap => {
    if (snap.val() === true) {
      roomRef.child('players/O').off();
      startGame();
    }
  });
}

// ─── Join Private Room ────────────────────────────────────────────────────────
async function joinRoom() {
  setLobbyError('');
  const code = document.getElementById('join-input').value.trim().toUpperCase();

  if (code.length !== 6) {
    setLobbyError('Please enter a 6-character room code.');
    return;
  }

  const snap = await db.ref(`rooms/${code}`).get();

  if (!snap.exists()) {
    setLobbyError('Room not found. Check the code and try again.');
    return;
  }

  const data = snap.val();

  if (data.players.O === true) {
    setLobbyError('Room is full — game already in progress.');
    return;
  }
  if (data.status === 'finished') {
    setLobbyError('That game has already ended.');
    return;
  }

  await joinAsO(code);
}

// ─── Cancel Private Room ──────────────────────────────────────────────────────
async function cancelRoom() {
  if (roomRef) {
    roomRef.onDisconnect().cancel();
    await roomRef.remove();
  }
  roomRef  = null;
  roomId   = null;
  myPlayer = null;
  showLobbyPanel('lobby-main');
}

// ─── Leave Mid-game ───────────────────────────────────────────────────────────
async function leaveRoom() {
  detachListeners();

  if (roomRef) {
    roomRef.onDisconnect().cancel();
    await roomRef.child(`players/${myPlayer}`).set(false);
  }

  roomRef  = null;
  roomId   = null;
  myPlayer = null;

  document.getElementById('game-screen').classList.add('hidden');
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

// ─── Start Game ───────────────────────────────────────────────────────────────
function startGame() {
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
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
    const board = document.createElement('div');
    board.className = 'inner-board';
    board.id = `board-${b}`;

    const cellGrid = document.createElement('div');
    cellGrid.className = 'cell-grid';

    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.id = `cell-${b}-${c}`;
      cell.onclick = () => handleClick(b, c);
      cellGrid.appendChild(cell);
    }

    const overlay = document.createElement('div');
    overlay.className = 'board-overlay';
    const sym = document.createElement('div');
    sym.className = 'board-overlay-symbol';
    sym.id = `overlay-sym-${b}`;
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
      if (activeBoard === -1 || activeBoard === b) {
        boardEl.classList.add(activeBoard === -1 ? 'any-valid' : 'active-board');
      }
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
  const el = document.getElementById('status-content');

  if (outerWinner === 'D') {
    el.innerHTML = `<span class="win-banner" style="color:#888">IT'S A DRAW!</span>`;
    return;
  }
  if (outerWinner) {
    const col    = outerWinner === 'X' ? 'var(--x-color)' : 'var(--o-color)';
    const youWon = outerWinner === myPlayer;
    el.innerHTML = `<span class="win-banner" style="color:${col}">${youWon ? 'YOU WIN! 🎉' : 'OPPONENT WINS!'}</span>`;
    return;
  }

  const isMyTurn = currentPlayer === myPlayer;
  const where    = activeBoard === -1 ? 'any board' : `board ${activeBoard + 1}`;

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

// ─── Game Logic ───────────────────────────────────────────────────────────────
async function handleClick(b, c) {
  if (outerWinner)                             return;
  if (currentPlayer !== myPlayer)              return;
  if (boardWinner[b] !== null)                 return;
  if (boards[b][c] !== null)                   return;
  if (activeBoard !== -1 && activeBoard !== b) return;

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
    scores[outerWin]++;
    await roomRef.child('scores').set(scores);
  } else if (boardWinner.every(w => w !== null)) {
    const xCount = boardWinner.filter(w => w === 'X').length;
    const oCount = boardWinner.filter(w => w === 'O').length;
    outerWinner  = xCount > oCount ? 'X' : oCount > xCount ? 'O' : 'D';
    if (outerWinner !== 'D') {
      scores[outerWinner]++;
      await roomRef.child('scores').set(scores);
    }
  }

  if (!outerWinner) {
    activeBoard   = boardWinner[c] !== null ? -1 : c;
    currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
  }

  await roomRef.child('game').set(serializeGame({
    boards, boardWinner, outerWinner, activeBoard, currentPlayer, moveCount
  }));
}

// ─── Restart ──────────────────────────────────────────────────────────────────
async function restartGame() {
  if (!roomRef) return;
  await roomRef.child('game').set(serializeGame(initialGameState()));
}

// ─── Win Helpers ──────────────────────────────────────────────────────────────
function checkWinner(cells) {
  for (const [a, b, c] of WINS) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  return null;
}

function getWinningCells(cells) {
  for (const [a, b, c] of WINS) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return [a, b, c];
  }
  return [];
}

function drawOuterWinLine(winner) {
  const svg     = document.getElementById('outer-win-svg');
  svg.innerHTML = '';
  const winLine = getWinLineCoords(boardWinner.map(w => w === 'D' ? null : w));
  if (!winLine) return;
  const [r1, c1, r2, c2] = winLine;
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
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
      return [Math.floor(a / 3), a % 3, Math.floor(c / 3), c % 3];
    }
  }
  return null;
}

// ─── Dots Animation ───────────────────────────────────────────────────────────
let dotCount = 0;
setInterval(() => {
  const el = document.querySelector('.dots');
  if (el) { dotCount = (dotCount + 1) % 4; el.textContent = '.'.repeat(dotCount); }
}, 500);