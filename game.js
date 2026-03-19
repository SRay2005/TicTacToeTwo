// ─── State ────────────────────────────────────────────────────────────────────
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

let currentPlayer = 'X';
let boards = Array.from({ length: 9 }, () => Array(9).fill(null)); // boards[b][c] = null | 'X' | 'O'
let boardWinner = Array(9).fill(null); // null | 'X' | 'O' | 'D'
let outerWinner = null;
let activeBoard = -1; // -1 = any board allowed
let scores = { X: 0, O: 0 };
let moveCount = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const outerGrid = document.getElementById('outer-grid');
const statusContent = document.getElementById('status-content');

// ─── Build DOM ────────────────────────────────────────────────────────────────
function buildGrid() {
  const svg = document.getElementById('outer-win-svg');
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
    overlay.id = `overlay-${b}`;

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
function render(lastBoard = -1, lastCell = -1) {
  for (let b = 0; b < 9; b++) {
    const boardEl = document.getElementById(`board-${b}`);
    boardEl.className = 'inner-board';

    const finished = boardWinner[b] !== null;

    if (finished) {
      if (boardWinner[b] === 'X') boardEl.classList.add('won-x');
      else if (boardWinner[b] === 'O') boardEl.classList.add('won-o');
      else boardEl.classList.add('drawn');
    } else if (!outerWinner) {
      if (activeBoard === -1 || activeBoard === b) {
        boardEl.classList.add(activeBoard === -1 ? 'any-valid' : 'active-board');
      }
    }

    // Board overlay symbol
    const overlaySym = document.getElementById(`overlay-sym-${b}`);
    if (boardWinner[b] === 'X') {
      overlaySym.textContent = 'X';
      overlaySym.className = 'board-overlay-symbol x';
    } else if (boardWinner[b] === 'O') {
      overlaySym.textContent = 'O';
      overlaySym.className = 'board-overlay-symbol o';
    } else if (boardWinner[b] === 'D') {
      overlaySym.textContent = 'DRAW';
      overlaySym.className = 'board-overlay-symbol draw';
    }

    // Highlight winning cells
    const winningCells = finished && boardWinner[b] !== 'D' ? getWinningCells(boards[b]) : [];

    for (let c = 0; c < 9; c++) {
      const cellEl = document.getElementById(`cell-${b}-${c}`);
      const val = boards[b][c];
      cellEl.className = 'cell';

      if (val) {
        cellEl.classList.add('taken', val === 'X' ? 'x-cell' : 'o-cell');
        if (winningCells.includes(c)) cellEl.classList.add('winning-cell');
        if (b === lastBoard && c === lastCell) cellEl.classList.add('just-placed');
        cellEl.innerHTML = `<span class="cell-symbol">${val}</span>`;
      } else {
        cellEl.textContent = '';
        if (finished || outerWinner) cellEl.classList.add('board-finished');
      }
    }
  }

  renderStatus();
}

function renderStatus() {
  if (outerWinner === 'D') {
    statusContent.innerHTML = `<span class="win-banner" style="color:#888">IT'S A DRAW!</span>`;
    return;
  }
  if (outerWinner) {
    const col = outerWinner === 'X' ? 'var(--x-color)' : 'var(--o-color)';
    statusContent.innerHTML = `<span class="win-banner" style="color:${col}">${outerWinner} WINS THE GAME! 🎉</span>`;
    return;
  }

  const where = activeBoard === -1 ? 'any board' : `board ${activeBoard + 1}`;
  statusContent.innerHTML = `
    <span class="player-indicator">
      <span class="player-symbol ${currentPlayer.toLowerCase()}">${currentPlayer}</span>
      <span>— play in <span style="color:var(--active-glow)">${where}</span></span>
    </span>`;
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
function handleClick(b, c) {
  if (outerWinner) return;
  if (boardWinner[b] !== null) return;
  if (boards[b][c] !== null) return;
  if (activeBoard !== -1 && activeBoard !== b) return;

  // Place piece
  boards[b][c] = currentPlayer;
  moveCount++;

  // Check inner board result
  const innerWin = checkWinner(boards[b]);
  if (innerWin) {
    boardWinner[b] = innerWin;
  } else if (boards[b].every(v => v !== null)) {
    boardWinner[b] = 'D';
  }

  // Check outer board result
  const outerWin = checkWinner(boardWinner.map(w => w === 'D' ? null : w));
  if (outerWin) {
    outerWinner = outerWin;
    scores[outerWin]++;
    document.getElementById(`score-${outerWin.toLowerCase()}`).textContent = scores[outerWin];
    drawOuterWinLine(outerWin);
  } else if (boardWinner.every(w => w !== null)) {
    // All boards finished — tally board wins
    const xBoards = boardWinner.filter(w => w === 'X').length;
    const oBoards = boardWinner.filter(w => w === 'O').length;
    outerWinner = xBoards > oBoards ? 'X' : oBoards > xBoards ? 'O' : 'D';
    if (outerWinner !== 'D') {
      scores[outerWinner]++;
      document.getElementById(`score-${outerWinner.toLowerCase()}`).textContent = scores[outerWinner];
    }
  }

  // Determine next active board
  if (!outerWinner) {
    activeBoard = boardWinner[c] !== null ? -1 : c;
    currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
  }

  render(b, c);
}

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
  const svg = document.getElementById('outer-win-svg');
  svg.innerHTML = '';
  const winLine = getWinLineCoords(boardWinner.map(w => w === 'D' ? null : w));
  if (!winLine) return;

  const [r1, c1, r2, c2] = winLine;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', c1 + 0.5);
  line.setAttribute('y1', r1 + 0.5);
  line.setAttribute('x2', c2 + 0.5);
  line.setAttribute('y2', r2 + 0.5);
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

// ─── Restart ──────────────────────────────────────────────────────────────────
function restartGame() {
  currentPlayer = 'X';
  boards = Array.from({ length: 9 }, () => Array(9).fill(null));
  boardWinner = Array(9).fill(null);
  outerWinner = null;
  activeBoard = -1;
  moveCount = 0;
  document.getElementById('outer-win-svg').innerHTML = '';
  render();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
buildGrid();
render();