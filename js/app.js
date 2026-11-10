import { buildHanon1 } from './hanon.js';
import {
  bluetoothSupported,
  webMidiSupported,
  connectBluetooth,
  connectWebMidi,
} from './midi.js';

const COLOR_OK = '#16a34a'; // 한 번에 맞힘
const COLOR_FIXED = '#d97706'; // 틀린 뒤 고쳐서 맞힘
const COLOR_BAD = '#dc2626'; // 틀림(아직 못 맞힘)
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const sheet = $('sheet');

const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(sheet, {
  backend: 'svg',
  autoResize: false,
  drawTitle: true,
  drawPartNames: false,
  followCursor: false,
  cursorsOptions: [{ type: 0, color: '#3b82f6', alpha: 0.35, follow: false }],
});

const state = {
  loaded: false,
  allSteps: [], // 악보 전체의 연주 지점
  steps: [], // 선택한 손에 해당하는 연주 지점
  pos: 0,
  cursorPos: 0,
  hit: new Set(),
  stepMistake: false,
  mistakes: 0,
  firstTry: 0,
  finished: false,
  zoom: window.innerWidth < 700 ? 0.6 : 0.9,
  lastXml: null,
};

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function setMessage(text, kind = '') {
  const el = $('message');
  el.textContent = text;
  el.className = kind;
}

// ---------- 악보 불러오기 ----------

async function loadScore(xml) {
  $('loading').hidden = false;
  state.loaded = false;
  try {
    await osmd.load(xml);
    state.lastXml = xml;
    osmd.zoom = state.zoom;
    osmd.render();
    collectSteps();
    state.loaded = true;
    startSession();
  } catch (error) {
    console.error(error);
    setMessage('악보를 불러오지 못했습니다: ' + error.message, 'bad');
  } finally {
    $('loading').hidden = true;
  }
}

// 커서를 처음부터 끝까지 한 번 훑어서, 실제로 건반을 눌러야 하는 지점만 모은다.
function collectSteps() {
  const cursor = osmd.cursor;
  cursor.reset();
  const steps = [];
  let index = 0;
  while (!cursor.Iterator.EndReached) {
    const notes = [];
    for (const entry of cursor.Iterator.CurrentVoiceEntries || []) {
      if (entry.IsGrace) continue;
      for (const note of entry.Notes) {
        if (note.isRest()) continue;
        if (note.NoteTie && note.NoteTie.StartNote !== note) continue; // 붙임줄로 이어진 음
        const staff = note.ParentStaff ?? note.ParentStaffEntry?.ParentStaff;
        notes.push({
          note,
          midi: note.halfTone + 12,
          staff: staff?.idInMusicSheet ?? 0,
        });
      }
    }
    if (notes.length) {
      const measure = notes[0].note.SourceMeasure?.MeasureNumber ?? null;
      steps.push({ cursorIndex: index, notes, measure, result: null });
    }
    cursor.next();
    index++;
  }
  cursor.reset();
  state.cursorPos = 0;
  state.allSteps = steps;
}

// ---------- 연습 세션 ----------

function startSession() {
  const hand = $('hand').value;
  const wanted = (n) =>
    hand === 'both' || (hand === 'right' ? n.staff === 0 : n.staff !== 0);

  state.steps = state.allSteps
    .map((step) => ({ ...step, notes: step.notes.filter(wanted), result: null }))
    .filter((step) => step.notes.length);

  state.pos = 0;
  state.hit = new Set();
  state.stepMistake = false;
  state.mistakes = 0;
  state.firstTry = 0;
  state.finished = false;
  $('result').hidden = true;

  osmd.render(); // 이전 색칠을 지운다
  osmd.cursor.reset();
  state.cursorPos = 0;
  osmd.cursor.show();
  moveCursorToStep();
  stage.scrollTop = 0;
  setMessage(state.steps.length ? '첫 음을 치면 시작합니다' : '연주할 음이 없습니다');
  updateStatus();
}

function moveCursorToStep() {
  const step = state.steps[state.pos];
  if (!step) return;
  const cursor = osmd.cursor;
  if (step.cursorIndex < state.cursorPos) {
    cursor.reset();
    state.cursorPos = 0;
  }
  while (state.cursorPos < step.cursorIndex) {
    cursor.next();
    state.cursorPos++;
  }
  keepCursorVisible();
}

function keepCursorVisible() {
  const el = osmd.cursor.cursorElement;
  if (!el) return;
  const box = el.getBoundingClientRect();
  const view = stage.getBoundingClientRect();
  const margin = view.height * 0.2;
  if (box.top < view.top + 8 || box.bottom > view.bottom - margin) {
    stage.scrollTo({
      top: stage.scrollTop + (box.top - view.top) - view.height * 0.25,
      behavior: 'smooth',
    });
  }
}

function expectedSet(step) {
  return new Set(step.notes.map((n) => n.midi));
}

function handleNoteOn(midi) {
  if (!state.loaded || state.finished) return;
  const step = state.steps[state.pos];
  if (!step) return;
  const expected = expectedSet(step);

  if (!expected.has(midi)) {
    state.stepMistake = true;
    state.mistakes++;
    for (const n of step.notes) {
      if (!state.hit.has(n.midi)) colorNote(n.note, COLOR_BAD);
    }
    const want = [...expected].sort((a, b) => a - b).map(noteName).join(', ');
    setMessage(`틀린 음 ${noteName(midi)} → 쳐야 할 음 ${want}`, 'bad');
    stage.classList.remove('flash');
    void stage.offsetWidth; // 애니메이션 다시 시작
    stage.classList.add('flash');
    updateStatus();
    return;
  }

  if (state.hit.has(midi)) return;
  state.hit.add(midi);
  const color = state.stepMistake ? COLOR_FIXED : COLOR_OK;
  for (const n of step.notes) {
    if (n.midi === midi) colorNote(n.note, color);
  }
  if (state.hit.size < expected.size) return;

  // 이 지점의 음을 모두 맞혔다.
  step.result = state.stepMistake ? 'fixed' : 'ok';
  if (!state.stepMistake) state.firstTry++;
  if (state.stepMistake) setMessage('');
  state.pos++;
  state.hit = new Set();
  state.stepMistake = false;

  if (state.pos >= state.steps.length) {
    finish();
  } else {
    moveCursorToStep();
  }
  updateStatus();
}

function finish() {
  state.finished = true;
  osmd.cursor.hide();
  const total = state.steps.length;
  const accuracy = Math.round((state.firstTry / total) * 100);
  const perfect = state.mistakes === 0;
  $('result-title').textContent = perfect ? '퍼펙트!' : '완주했습니다';
  $('result-body').textContent = perfect
    ? '한 음도 틀리지 않았습니다.'
    : `정확도 ${accuracy}%\n틀린 횟수 ${state.mistakes}번\n주황색 음표가 틀렸던 자리입니다.`;
  $('result').hidden = false;
  setMessage(perfect ? '퍼펙트!' : '완주', 'good');
}

function updateStatus() {
  const total = state.steps.length;
  const step = state.steps[Math.min(state.pos, total - 1)];
  const lastMeasure = state.steps[total - 1]?.measure;
  $('progress').textContent =
    step?.measure != null ? `마디 ${step.measure} / ${lastMeasure}` : '–';
  const done = state.pos;
  $('score').textContent = done
    ? `정확도 ${Math.round((state.firstTry / done) * 100)}% · 틀린 횟수 ${state.mistakes}`
    : `틀린 횟수 ${state.mistakes}`;
}

// ---------- 음표 색칠 ----------

function colorNote(note, color) {
  const graphical = osmd.rules.GNote(note);
  if (!graphical) return;
  let heads = [];
  try {
    heads = graphical.getNoteheadSVGs?.() ?? [];
  } catch {
    heads = [];
  }
  if (!heads.length) {
    const group = graphical.getSVGGElement?.();
    if (!group) return;
    heads = [...group.querySelectorAll('.vf-notehead')];
    if (!heads.length) heads = [group];
  }
  for (const head of heads) {
    for (const path of head.querySelectorAll('path')) {
      path.setAttribute('fill', color);
      path.setAttribute('stroke', color);
    }
  }
}

// 확대/축소나 화면 회전으로 악보를 다시 그린 뒤 색과 커서를 복원한다.
function rerenderKeepingProgress() {
  if (!state.loaded) return;
  osmd.zoom = state.zoom;
  osmd.render();
  osmd.cursor.reset();
  state.cursorPos = 0;
  for (let i = 0; i < state.pos; i++) {
    const step = state.steps[i];
    const color = step.result === 'fixed' ? COLOR_FIXED : COLOR_OK;
    for (const n of step.notes) colorNote(n.note, color);
  }
  const current = state.steps[state.pos];
  if (current) {
    for (const n of current.notes) {
      if (state.hit.has(n.midi)) {
        colorNote(n.note, state.stepMistake ? COLOR_FIXED : COLOR_OK);
      } else if (state.stepMistake) {
        colorNote(n.note, COLOR_BAD);
      }
    }
  }
  if (state.finished) {
    osmd.cursor.hide();
  } else {
    osmd.cursor.show();
    moveCursorToStep();
  }
}

// ---------- 피아노 연결 ----------

function onMidiMessage(status, d1, d2) {
  const command = status & 0xf0;
  if (command === 0x90 && d2 > 0) handleNoteOn(d1);
}

function onLinkState({ connected, name, reconnecting }) {
  const el = $('link');
  if (connected) {
    el.textContent = name ? `연결됨: ${name}` : '연결됨';
    el.className = 'pill on';
    keepScreenAwake();
  } else if (reconnecting) {
    el.textContent = '다시 연결하는 중…';
    el.className = 'pill wait';
  } else {
    el.textContent = '연결 안 됨';
    el.className = 'pill off';
  }
}

async function keepScreenAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // 지원하지 않거나 거부되면 그냥 넘어간다
  }
}

$('connect').addEventListener('click', async () => {
  if (!bluetoothSupported()) {
    setMessage('이 브라우저는 블루투스 연결을 지원하지 않습니다. 안드로이드 크롬에서 열어주세요.', 'bad');
    return;
  }
  try {
    await connectBluetooth(onMidiMessage, onLinkState);
    setMessage('피아노가 연결되었습니다', 'good');
  } catch (error) {
    if (error.name === 'NotFoundError') return; // 사용자가 선택 창을 닫음
    console.error(error);
    setMessage('연결 실패: ' + error.message, 'bad');
  }
});

$('connect-usb').addEventListener('click', async () => {
  if (!webMidiSupported()) {
    setMessage('이 브라우저는 USB MIDI를 지원하지 않습니다.', 'bad');
    return;
  }
  try {
    const count = await connectWebMidi(onMidiMessage, onLinkState);
    setMessage(count ? 'MIDI 기기가 연결되었습니다' : '연결된 MIDI 기기를 찾지 못했습니다', count ? 'good' : 'bad');
  } catch (error) {
    console.error(error);
    setMessage('MIDI 연결 실패: ' + error.message, 'bad');
  }
});

// ---------- 화면 조작 ----------

$('restart').addEventListener('click', () => state.loaded && startSession());
$('result-again').addEventListener('click', () => startSession());
$('hand').addEventListener('change', () => state.loaded && startSession());

$('zoom-in').addEventListener('click', () => {
  state.zoom = Math.min(1.6, state.zoom + 0.1);
  rerenderKeepingProgress();
});
$('zoom-out').addEventListener('click', () => {
  state.zoom = Math.max(0.3, state.zoom - 0.1);
  rerenderKeepingProgress();
});

let resizeTimer = null;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // 주소창 숨김 등 높이 변화는 무시
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderKeepingProgress, 250);
});

$('song').addEventListener('change', (event) => {
  if (event.target.value === 'file') {
    $('file').click();
    event.target.value = 'hanon1';
  } else {
    loadScore(buildHanon1());
  }
});

$('file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadScore(reader.result);
  if (file.name.toLowerCase().endsWith('.mxl')) {
    reader.readAsBinaryString(file);
  } else {
    reader.readAsText(file);
  }
  event.target.value = '';
});

// ---------- 피아노 없이 시험해 보기 (?debug) ----------

function debugPlay(correct) {
  const step = state.steps[state.pos];
  if (!step) return;
  const expected = expectedSet(step);
  if (correct) {
    const next = [...expected].find((m) => !state.hit.has(m));
    if (next != null) handleNoteOn(next);
  } else {
    let wrong = step.notes[0].midi + 1;
    while (expected.has(wrong)) wrong++;
    handleNoteOn(wrong);
  }
}

if (new URLSearchParams(location.search).has('debug')) {
  $('debug').hidden = false;
  $('debug-right').addEventListener('click', () => debugPlay(true));
  $('debug-wrong').addEventListener('click', () => debugPlay(false));
  window.pianoDebug = { state, handleNoteOn, debugPlay };
}

loadScore(buildHanon1());
