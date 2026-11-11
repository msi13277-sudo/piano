// ?v= 숫자는 브라우저가 예전 파일을 계속 쓰지 않게 하려는 것. index.html의 버전과 함께 올린다.
import { buildHanon1 } from './hanon.js?v=15';
import {
  bluetoothSupported,
  webMidiSupported,
  connectBluetooth,
  connectWebMidi,
  getMidiOutputs,
} from './midi.js?v=15';
import * as sound from './sound.js?v=15';

const COLOR_OK = '#16a34a'; // 한 번에(박자까지) 맞힘
const COLOR_FIXED = '#d97706'; // 틀린 뒤 고쳐서 맞힘
const COLOR_TIMING = '#9333ea'; // 음은 맞지만 박자가 어긋남
const COLOR_BAD = '#dc2626'; // 틀리거나 놓침
const COLOR_PLAIN = '#000000';
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const COUNT_IN_BEATS = 4;

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
  steps: [], // 선택한 손과 구간에 해당하는 연주 지점
  pos: 0, // 기다림 모드: 지금 쳐야 할 지점 / 템포 모드: 커서가 있는 지점
  cursorPos: 0,
  hit: new Set(),
  stepMistake: false,
  finished: false,
  zoom: window.innerWidth < 700 ? 0.6 : 0.9,

  // 설정
  mode: 'wait',
  bpm: 60,
  tol: 0.1,
  metronome: true,
  loop: false,
  from: 1,
  to: 1,
  firstMeasure: 1,
  lastMeasure: 1,

  // 템포 모드 진행 상태
  running: false,
  t0: 0,
  missPtr: 0,
  clickIndex: 0,
  raf: 0,
  countShown: null,

  // 결과
  stats: { ok: 0, wrong: 0, timing: 0, miss: 0 },
  perMeasure: new Map(), // 마디 번호 → 틀린 횟수(반복 연습 전체 합계)
  pass: 1,
  paint: new Map(), // 색칠한 음표 → 색
  loopTimer: 0,

  // 듣기와 녹음
  soundOut: 'phone', // 'phone' 또는 'piano'
  playing: false, // 듣기나 녹음 재생이 진행 중
  listening: false, // 그중 악보 듣기
  combo: 0, // 한 번에 맞힌 자리가 이어진 개수
  compare: null, // 방금 끝낸 회차와 지난 기록의 비교
  paused: false, // 듣기 일시정지
  picking: null, // 터치로 반복 구간을 고르는 중이면 { first }
};

// 재생 엔진 상태: 소리 이벤트와 화면 갱신 이벤트를 시간순으로 내보낸다.
const playback = {
  timer: 0, start: 0, audio: [], calls: [], ai: 0, ci: 0, end: 0, onEnd: null, pausedAt: 0,
};

// 녹음 상태. take는 마지막으로 녹음한 연주.
const rec = { active: false, start: 0, events: [], take: null, timer: 0 };

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function nowSec() {
  return performance.now() / 1000;
}

// 안내 문구는 악보 아래쪽에 잠깐 떠 있다가 사라진다.
let messageTimer = 0;

function setMessage(text, kind = '') {
  const el = $('message');
  clearTimeout(messageTimer);
  el.textContent = text;
  el.className = kind;
  el.hidden = !text;
  if (text) {
    messageTimer = setTimeout(() => {
      el.hidden = true;
    }, kind === 'bad' ? 8000 : 5000);
  }
}

function flashWrong() {
  stage.classList.remove('flash');
  void stage.offsetWidth; // 애니메이션 다시 시작
  stage.classList.add('flash');
}

// ---------- 설정 저장 ----------

const PREF_KEYS = ['mode', 'bpm', 'tol', 'metronome', 'soundOut'];

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('piano-prefs') || '{}');
    for (const key of PREF_KEYS) {
      if (saved[key] !== undefined) state[key] = saved[key];
    }
  } catch {
    // 저장된 설정을 못 읽으면 기본값을 쓴다
  }
}

function savePrefs() {
  try {
    const out = {};
    for (const key of PREF_KEYS) out[key] = state[key];
    localStorage.setItem('piano-prefs', JSON.stringify(out));
  } catch {
    // 저장이 안 되어도 연습에는 지장이 없다
  }
}

function syncControls() {
  for (const button of $('mode').querySelectorAll('button')) {
    const on = button.dataset.mode === state.mode;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
  $('bpm').value = state.bpm;
  $('tol').value = String(state.tol);
  $('metronome').checked = state.metronome;
  $('loop').checked = state.loop;
  $('sound-out').value = state.soundOut;
  sound.setTarget(state.soundOut);
  $('from').value = state.from;
  $('to').value = state.to;
  $('from').min = $('to').min = state.firstMeasure;
  $('from').max = $('to').max = state.lastMeasure;
  for (const el of document.querySelectorAll('.tempo-only')) {
    el.hidden = state.mode !== 'tempo';
  }
  updateMainButton();
}

function updateMainButton() {
  $('restart-label').textContent =
    state.mode === 'tempo' ? (state.running ? '정지' : '시작') : '처음부터';
  $('restart').classList.toggle('active', state.running);
  // 재생 버튼 하나가 재생 중에는 일시정지 버튼으로 바뀐다.
  const sounding = state.listening && !state.paused;
  $('listen-play').classList.toggle('playing', sounding);
  $('listen-play').classList.toggle('active', state.listening);
  $('listen-play').setAttribute('aria-label', sounding ? '듣기 일시정지' : '듣기 재생');
  $('listen-stop').disabled = !state.listening;
  // 구간 버튼: 구간이 정해져 있으면 그 범위를 보여주고, 누르면 해제한다.
  const partial = rangeIsPartial();
  const rangeLabel = $('range-label');
  rangeLabel.textContent = state.picking
    ? '취소'
    : !partial
      ? '구간'
      : state.from === state.to
        ? `${state.from}마디`
        : `${state.from}–${state.to}마디`;
  rangeLabel.classList.toggle('plain', !state.picking && !partial);
  $('range-pick').classList.toggle('active', Boolean(state.picking) || partial);
  $('range-pick').setAttribute(
    'aria-label',
    state.picking ? '구간 설정 취소' : partial ? '반복 구간 해제' : '반복 구간 설정'
  );
  $('record-label').textContent = rec.active ? formatTime(nowSec() - rec.start) : '';
  $('record').setAttribute('aria-label', rec.active ? '녹음 중지' : '녹음');
  $('record').classList.toggle('recording', rec.active);
  $('take').hidden = !rec.take;
  $('take-play').textContent = state.playing && !state.listening ? '정지' : '재생';
}

// ---------- 악보 불러오기 ----------

async function loadScore(xml) {
  // 악보 파일은 글자로 된 것('<'로 시작)이거나 압축된 것('PK'로 시작)이다.
  const head = typeof xml === 'string' ? xml.trimStart().slice(0, 2) : '';
  if (!head.startsWith('<') && head !== 'PK') {
    setMessage('악보 파일이 아닙니다. MusicXML 파일(.musicxml, .xml, .mxl)을 골라 주세요', 'bad');
    return false;
  }
  $('loading').hidden = false;
  state.loaded = false;
  stopTempo();
  try {
    await osmd.load(xml);
    osmd.zoom = state.zoom;
    osmd.render();
    state.paint.clear();
    collectSteps();
    state.firstMeasure = state.allSteps[0]?.measure ?? 1;
    state.lastMeasure = state.allSteps.at(-1)?.measure ?? 1;
    state.from = state.firstMeasure;
    state.to = state.lastMeasure;
    state.loaded = true;
    syncControls();
    newPractice();
    state.lastXml = xml;
    return true;
  } catch (error) {
    console.error(error);
    // 실패하면 직전에 열려 있던 악보로 되돌려서 계속 쓸 수 있게 한다.
    if (state.lastXml && state.lastXml !== xml) await loadScore(state.lastXml);
    setMessage('악보를 불러오지 못했습니다. 파일이 손상됐거나 지원하지 않는 형식입니다', 'bad');
    return false;
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
        // 붙임줄이 있으면 이어진 음표들의 길이를 모두 더한다.
        const tied = note.NoteTie?.Notes ?? [note];
        const length = tied.reduce((sum, n) => sum + (n.Length?.RealValue ?? 0), 0);
        notes.push({
          note,
          midi: note.halfTone + 12,
          staff: staff?.idInMusicSheet ?? 0,
          len: length * 4, // 음 길이(4분음표 단위), 듣기에서 쓴다
        });
      }
    }
    if (notes.length) {
      const stamp =
        cursor.Iterator.CurrentEnrolledTimestamp ?? cursor.Iterator.currentTimeStamp;
      steps.push({
        cursorIndex: index,
        notes,
        measure: notes[0].note.SourceMeasure?.MeasureNumber ?? null,
        beats: stamp.RealValue * 4, // 곡 처음부터의 위치(4분음표 단위)
      });
    }
    cursor.next();
    index++;
  }
  cursor.reset();
  state.cursorPos = 0;
  state.allSteps = steps;
}

// ---------- 연습 세션 ----------

// 새 연습: 반복 횟수와 마디별 기록까지 모두 지우고 시작한다.
function newPractice() {
  state.perMeasure = new Map();
  state.pass = 1;
  prepareSession();
}

// 선택한 손과 마디 범위에 해당하는 연주 지점을 새로 만든다.
function buildSteps(from, to) {
  const hand = $('hand').value;
  const wanted = (n) => hand === 'both' || (hand === 'right' ? n.staff === 0 : n.staff !== 0);
  return state.allSteps
    .filter((s) => s.measure == null || (s.measure >= from && s.measure <= to))
    .map((s) => ({
      ...s,
      notes: s.notes.filter(wanted),
      hits: new Set(),
      wrongs: 0,
      wrongNotes: [],
      result: null,
      off: false,
      sec: 0,
    }))
    .filter((s) => s.notes.length);
}

function rangeIsPartial() {
  return state.from !== state.firstMeasure || state.to !== state.lastMeasure;
}

// 한 회차 준비: 색칠과 점수를 지우고 커서를 구간 처음에 둔다.
function prepareSession(keepMessage = false) {
  clearTimeout(state.loopTimer);
  stopTempo();
  stopPlayback();

  state.steps = buildSteps(state.from, state.to);

  const base = state.steps[0]?.beats ?? 0;
  for (const s of state.steps) s.sec = ((s.beats - base) * 60) / state.bpm;

  state.pos = 0;
  state.hit = new Set();
  state.stepMistake = false;
  state.finished = false;
  state.missPtr = 0;
  state.prevWrong = [];
  setCombo(0);
  state.stats = { ok: 0, wrong: 0, timing: 0, miss: 0 };
  $('result').hidden = true;

  clearPaint();
  osmd.cursor.show();
  moveCursorToStep(true);

  if (!keepMessage) {
    if (!state.steps.length) setMessage('이 구간에는 연주할 음이 없습니다', 'bad');
    else if (state.mode === 'tempo') setMessage(`시작을 누르면 ${COUNT_IN_BEATS}박을 센 뒤 시작합니다`);
    else setMessage('첫 음을 치면 시작합니다');
  }
  updateStatus();
  updateMainButton();
  drawRangeOverlay();
}

function moveCursorToIndex(cursorIndex, force = false) {
  const cursor = osmd.cursor;
  if (cursorIndex < state.cursorPos) {
    cursor.reset();
    state.cursorPos = 0;
  }
  while (state.cursorPos < cursorIndex) {
    cursor.next();
    state.cursorPos++;
  }
  keepCursorVisible(force);
}

function moveCursorToStep(force = false) {
  const step = state.steps[state.pos];
  if (step) moveCursorToIndex(step.cursorIndex, force);
}

function keepCursorVisible(force = false) {
  const el = osmd.cursor.cursorElement;
  if (!el) return;
  const box = el.getBoundingClientRect();
  const view = stage.getBoundingClientRect();
  const margin = view.height * 0.2;
  if (force || box.top < view.top + 8 || box.bottom > view.bottom - margin) {
    stage.scrollTo({
      top: Math.max(0, stage.scrollTop + (box.top - view.top) - view.height * 0.25),
      behavior: force ? 'auto' : 'smooth',
    });
  }
}

function expectedSet(step) {
  return new Set(step.notes.map((n) => n.midi));
}

function bumpMeasure(measure) {
  if (measure == null) return;
  state.perMeasure.set(measure, (state.perMeasure.get(measure) ?? 0) + 1);
}

function handleNoteOn(midi) {
  if (!state.loaded || state.playing) return; // 듣기/재생 중에는 판정하지 않는다
  if (state.mode === 'tempo') tempoNoteOn(midi);
  else if (state.mode === 'perform') performNoteOn(midi);
  else waitNoteOn(midi);
}

// ---------- 연주 모드: 틀려도 빨갛게 표시만 하고 다음으로 넘어간다 ----------

function performNoteOn(midi) {
  if (state.finished) return;
  const steps = state.steps;
  const step = steps[state.pos];
  if (!step) return;
  const expected = expectedSet(step);

  if (expected.has(midi)) {
    if (step.hits.has(midi)) return;
    step.hits.add(midi);
    for (const n of step.notes) {
      if (n.midi === midi) paint(n.note, COLOR_OK);
    }
    completePerformStep(step, expected);
    return;
  }

  // 지금 자리의 음이 아니다. 무조건 "틀림"으로 넘기면 한 번의 실수 뒤로
  // 계속 한 칸씩 밀려서 전부 빨갛게 되므로, 흔한 두 경우를 먼저 가려낸다.
  const untouched = step.hits.size === 0 && step.wrongs === 0;
  const previous = steps[state.pos - 1];
  const next = steps[state.pos + 1];

  // (1) 한 자리를 건너뛰고 친 경우: 직전에 틀렸다고 본 음이 사실은 이 자리의 음이었고,
  //     지금 친 음은 그다음 자리의 음이다.
  if (
    untouched &&
    previous?.result === 'bad' &&
    next?.notes.some((n) => n.midi === midi) &&
    [...expected].every((m) => state.prevWrong.includes(m))
  ) {
    step.hits = new Set(expected);
    step.result = 'ok';
    state.stats.ok++;
    for (const n of step.notes) paint(n.note, COLOR_OK);
    state.prevWrong = [];
    state.pos++;
    moveCursorToStep();
    performNoteOn(midi);
    return;
  }

  // (2) 직전에 틀린 자리를 고쳐 친 경우: 진행 위치는 그대로 두고 고친 것으로 표시한다.
  if (untouched && previous?.result === 'bad' && previous.notes.some((n) => n.midi === midi)) {
    for (const n of previous.notes) {
      if (n.midi === midi) paint(n.note, COLOR_FIXED);
    }
    setMessage('고쳐 쳤습니다');
    celebrateFix(previous.notes.filter((n) => n.midi === midi));
    return;
  }

  // (3) 틀린 음
  step.wrongs++;
  step.wrongNotes.push(midi);
  const want = [...expected].sort((a, b) => a - b).map(noteName).join(', ');
  setMessage(`틀린 음 ${noteName(midi)} (악보: ${want})`, 'bad');
  flashWrong();
  completePerformStep(step, expected);
}

// 악보에 적힌 음의 개수만큼 건반을 눌렀으면, 맞았든 틀렸든 그 자리를 끝내고 넘어간다.
function completePerformStep(step, expected) {
  const allHit = step.hits.size === expected.size;
  if (!allHit && step.hits.size + step.wrongs < expected.size) return;

  if (step.wrongs > 0) {
    step.result = 'bad';
    state.stats.wrong++;
    bumpMeasure(step.measure);
    for (const n of step.notes) {
      if (!step.hits.has(n.midi)) paint(n.note, COLOR_BAD);
      else if (allHit) paint(n.note, COLOR_FIXED); // 음은 다 쳤지만 다른 건반도 함께 눌렀다
    }
    state.prevWrong = step.wrongNotes;
    setCombo(0);
  } else {
    step.result = 'ok';
    state.stats.ok++;
    state.prevWrong = [];
    setCombo(state.combo + 1);
  }

  state.pos++;
  if (state.pos >= state.steps.length) finishPass();
  else moveCursorToStep();
  updateStatus();
}

// ---------- 기다림 모드: 맞는 음을 쳐야 다음으로 넘어간다 ----------

function waitNoteOn(midi) {
  if (state.finished) return;
  const step = state.steps[state.pos];
  if (!step) return;
  const expected = expectedSet(step);

  if (!expected.has(midi)) {
    state.stepMistake = true;
    setCombo(0);
    state.stats.wrong++;
    bumpMeasure(step.measure);
    for (const n of step.notes) {
      if (!state.hit.has(n.midi)) paint(n.note, COLOR_BAD);
    }
    const want = [...expected].sort((a, b) => a - b).map(noteName).join(', ');
    setMessage(`틀린 음 ${noteName(midi)} → 쳐야 할 음 ${want}`, 'bad');
    flashWrong();
    updateStatus();
    return;
  }

  if (state.hit.has(midi)) return;
  state.hit.add(midi);
  const color = state.stepMistake ? COLOR_FIXED : COLOR_OK;
  for (const n of step.notes) {
    if (n.midi === midi) paint(n.note, color);
  }
  if (state.hit.size < expected.size) return;

  // 이 지점의 음을 모두 맞혔다.
  step.result = state.stepMistake ? 'fixed' : 'ok';
  if (state.stepMistake) {
    setMessage('');
    celebrateFix(step.notes); // 틀렸던 자리를 맞게 고쳐 쳤다
  } else {
    state.stats.ok++;
    setCombo(state.combo + 1);
  }
  state.pos++;
  state.hit = new Set();
  state.stepMistake = false;

  if (state.pos >= state.steps.length) {
    finishPass();
  } else {
    moveCursorToStep();
  }
  updateStatus();
}

// ---------- 템포 모드: 정해진 빠르기로 흘러가며 박자까지 판정한다 ----------

function startTempo(keepMessage = false) {
  prepareSession(keepMessage);
  if (!state.steps.length) return;
  sound.ensureAudio();
  const beat = 60 / state.bpm;
  state.t0 = nowSec() + COUNT_IN_BEATS * beat + 0.1;
  state.clickIndex = -COUNT_IN_BEATS;
  state.countShown = null;
  state.running = true;
  updateMainButton();
  state.raf = requestAnimationFrame(tick);
}

function stopTempo() {
  if (!state.running) return;
  state.running = false;
  cancelAnimationFrame(state.raf);
  updateMainButton();
}

function tick() {
  if (!state.running) return;
  const t = nowSec() - state.t0;
  const beat = 60 / state.bpm;
  const steps = state.steps;

  // 메트로놈: 예비박은 항상 소리를 내고, 그 뒤는 설정에 따른다.
  while (state.clickIndex * beat <= t + 0.15) {
    if (state.clickIndex < 0 || state.metronome) {
      sound.click(state.clickIndex * beat - t, state.clickIndex < 0);
    }
    state.clickIndex++;
  }

  if (t < 0) {
    const count = Math.ceil(-t / beat);
    if (count !== state.countShown) {
      state.countShown = count;
      setMessage(`준비… ${count}`);
    }
  } else if (state.countShown !== 0) {
    state.countShown = 0;
    setMessage('');
  }

  // 커서는 시간에 맞춰 흘러간다.
  let moved = false;
  while (state.pos + 1 < steps.length && steps[state.pos + 1].sec <= t) {
    state.pos++;
    moved = true;
  }
  if (moved) {
    moveCursorToStep();
    updateStatus();
  }

  // 허용 시간이 지나도록 치지 않은 음은 놓친 것으로 처리한다.
  const late = state.tol * 2;
  while (state.missPtr < steps.length && steps[state.missPtr].sec + late < t) {
    const step = steps[state.missPtr];
    if (!step.result) {
      step.result = 'miss';
      state.stats.miss++;
      bumpMeasure(step.measure);
      for (const n of step.notes) {
        if (!step.hits.has(n.midi)) paint(n.note, COLOR_BAD);
      }
      updateStatus();
    }
    state.missPtr++;
  }

  if (state.missPtr >= steps.length) {
    finishPass();
    return;
  }
  state.raf = requestAnimationFrame(tick);
}

function tempoNoteOn(midi) {
  if (!state.running) {
    if (!state.finished) setMessage('시작을 누르면 연주를 판정합니다');
    return;
  }
  const t = nowSec() - state.t0;
  const reach = state.tol * 2; // 이 범위 안이면 "음은 맞음"으로 인정한다
  const steps = state.steps;

  let best = null;
  let bestGap = Infinity;
  for (let i = state.missPtr; i < steps.length; i++) {
    const step = steps[i];
    if (step.sec > t + reach) break;
    if (step.sec < t - reach || step.hits.has(midi)) continue;
    if (!step.notes.some((n) => n.midi === midi)) continue;
    const gap = Math.abs(step.sec - t);
    if (gap < bestGap) {
      best = step;
      bestGap = gap;
    }
  }

  if (!best) {
    const here = steps[state.pos];
    state.stats.wrong++;
    bumpMeasure(here?.measure);
    setMessage(`틀린 음 ${noteName(midi)}`, 'bad');
    flashWrong();
    updateStatus();
    return;
  }

  best.hits.add(midi);
  const offBeat = bestGap > state.tol;
  if (offBeat) {
    best.off = true;
    setMessage(t < best.sec ? '조금 빨랐습니다' : '조금 늦었습니다');
  }
  for (const n of best.notes) {
    if (n.midi === midi) paint(n.note, offBeat ? COLOR_TIMING : COLOR_OK);
  }
  if (best.hits.size === expectedSet(best).size) {
    best.result = best.off ? 'timing' : 'ok';
    if (best.off) {
      state.stats.timing++;
      bumpMeasure(best.measure);
    } else {
      state.stats.ok++;
    }
    updateStatus();
  }
}

// ---------- 재생 엔진 (듣기와 녹음 재생이 함께 쓴다) ----------

function startPlayback(audioEvents, callEvents, endSec, onEnd) {
  stopPlayback();
  sound.ensureAudio();
  Object.assign(playback, {
    start: Infinity, // 피아노 음색이 준비되면 시작 시각을 정한다
    audio: audioEvents,
    calls: callEvents,
    ai: 0,
    ci: 0,
    end: endSec,
    onEnd,
    pausedAt: -0.25,
  });
  state.playing = true;
  state.paused = false;
  playback.timer = setInterval(pumpPlayback, 25);
  const run = playback.audio;
  sound.whenReady().then(() => {
    const stillThisRun = state.playing && playback.audio === run && playback.start === Infinity;
    if (stillThisRun && !state.paused) playback.start = nowSec() + 0.25;
  });
}

function pumpPlayback() {
  const t = nowSec() - playback.start;
  // 소리는 조금 앞서서 예약해야 끊기지 않는다.
  while (playback.ai < playback.audio.length && playback.audio[playback.ai].t <= t + 0.15) {
    const event = playback.audio[playback.ai++];
    const delay = event.t - t;
    if (event.raw) sound.sendRaw(event.raw, delay);
    else sound.playNote(event.midi, event.vel, delay, event.dur);
  }
  while (playback.ci < playback.calls.length && playback.calls[playback.ci].t <= t) {
    playback.calls[playback.ci++].fn();
  }
  if (t >= playback.end) {
    const done = playback.onEnd;
    stopPlayback(false);
    done?.();
  }
}

function pausePlayback() {
  if (!state.playing || state.paused) return;
  clearInterval(playback.timer);
  if (playback.start !== Infinity) playback.pausedAt = nowSec() - playback.start;
  state.paused = true;
  sound.stopAll();
  updateMainButton();
}

function resumePlayback() {
  if (!state.playing || !state.paused) return;
  sound.ensureAudio();
  playback.start = nowSec() - playback.pausedAt;
  state.paused = false;
  playback.timer = setInterval(pumpPlayback, 25);
  updateMainButton();
}

function stopPlayback(silence = true) {
  if (!state.playing) return;
  clearInterval(playback.timer);
  state.playing = false;
  state.listening = false;
  state.paused = false;
  if (silence) sound.stopAll();
  updateMainButton();
}

// ---------- 듣기: 악보를 지금 설정한 빠르기로 들려준다 ----------

// fromMeasure를 주면 그 마디부터 들려준다(악보를 터치했을 때).
function startListening(fromMeasure = null) {
  prepareSession();
  let steps = state.steps;
  if (fromMeasure != null) {
    const inside = fromMeasure >= state.from && fromMeasure <= state.to;
    steps = buildSteps(fromMeasure, inside ? state.to : state.lastMeasure);
  }
  if (!steps.length) return;

  const perBeat = 60 / state.bpm;
  const base = steps[0].beats;
  const audio = [];
  const calls = [];
  for (const step of steps) {
    const at = (step.beats - base) * perBeat;
    for (const n of step.notes) {
      audio.push({ t: at, midi: n.midi, vel: 80, dur: Math.max(0.08, n.len * perBeat * 0.95) });
    }
    calls.push({
      t: at,
      fn: () => {
        moveCursorToIndex(step.cursorIndex);
        if (step.measure != null) {
          $('progress').textContent = `${step.measure} / ${state.lastMeasure}마디`;
        }
      },
    });
  }
  const last = steps.at(-1);
  const end =
    (last.beats - base) * perBeat + Math.max(...last.notes.map((n) => n.len)) * perBeat + 0.3;
  startPlayback(audio, calls, end, () => {
    prepareSession();
    setMessage('듣기가 끝났습니다');
  });
  state.listening = true;
  moveCursorToIndex(steps[0].cursorIndex, true);
  setMessage(
    fromMeasure != null ? `${fromMeasure}마디부터 들려주는 중입니다` : '악보를 들려주는 중입니다'
  );
  updateMainButton();
}

// ---------- 악보 터치: 누른 자리가 몇 마디인지 찾는다 ----------

// 각 마디가 악보에서 차지하는 영역(악보 내부 단위).
function measureBoxes() {
  const boxes = [];
  for (const source of osmd.Sheet?.SourceMeasures ?? []) {
    const list = source.VerticalMeasureList ?? source.verticalMeasureList ?? [];
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const graphical of list) {
      const shape = graphical?.PositionAndShape;
      if (!shape) continue;
      left = Math.min(left, shape.AbsolutePosition.x);
      right = Math.max(right, shape.AbsolutePosition.x + shape.Size.width);
      top = Math.min(top, shape.AbsolutePosition.y);
      bottom = Math.max(bottom, shape.AbsolutePosition.y + shape.Size.height);
    }
    if (left < right) boxes.push({ number: source.MeasureNumber, left, right, top, bottom });
  }
  return boxes;
}

function measureAt(clientX, clientY) {
  const svg = sheet.querySelector('svg');
  if (!svg) return null;
  const frame = svg.getBoundingClientRect();
  const unit = 10 * state.zoom; // 악보 내부 단위 하나의 화면 크기(px)
  const x = (clientX - frame.left) / unit;
  const y = (clientY - frame.top) / unit;
  let best = null;
  let bestGap = Infinity;
  for (const box of measureBoxes()) {
    if (x < box.left || x > box.right) continue;
    const gap = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (gap < bestGap) {
      best = box;
      bestGap = gap;
    }
  }
  return best && bestGap < 6 ? best.number : null;
}

// 반복 구간(또는 고르는 중인 첫 마디)을 악보 위에 옅은 색으로 표시한다.
function drawRangeOverlay() {
  let layer = $('range-overlay');
  if (!layer || layer.parentElement !== sheet) {
    layer?.remove();
    layer = document.createElement('div');
    layer.id = 'range-overlay';
    sheet.append(layer);
  }
  layer.replaceChildren();
  const svg = sheet.querySelector('svg');
  if (!svg || !state.loaded) return;

  let from = null;
  let to = null;
  if (state.picking?.first != null) from = to = state.picking.first;
  else if (rangeIsPartial()) [from, to] = [state.from, state.to];
  if (from == null) return;

  const unit = 10 * state.zoom;
  // SVG에는 offsetLeft가 없어서 화면 좌표의 차이로 위치를 구한다.
  const frame = svg.getBoundingClientRect();
  const origin = sheet.getBoundingClientRect();
  const offsetX = frame.left - origin.left;
  const offsetY = frame.top - origin.top;
  for (const box of measureBoxes()) {
    if (box.number < from || box.number > to) continue;
    const mark = document.createElement('div');
    mark.className = 'range-box';
    mark.style.left = `${offsetX + box.left * unit}px`;
    mark.style.top = `${offsetY + (box.top - 1.5) * unit}px`;
    mark.style.width = `${(box.right - box.left) * unit}px`;
    mark.style.height = `${(box.bottom - box.top + 3) * unit}px`;
    layer.append(mark);
  }
}

function setRange(from, to, loop) {
  state.from = Math.min(from, to);
  state.to = Math.max(from, to);
  state.loop = loop;
  state.picking = null;
  syncControls();
  newPractice();
}

function pickMeasure(measure) {
  if (state.picking.first == null) {
    state.picking.first = measure;
    setMessage(`${measure}마디부터 반복합니다. 이제 마지막 마디를 누르세요`);
    drawRangeOverlay();
    return;
  }
  const first = state.picking.first;
  setRange(first, measure, true);
  setMessage(
    state.from === state.to
      ? `${state.from}마디를 반복합니다`
      : `${state.from}~${state.to}마디를 반복합니다`,
    'good'
  );
}

// ---------- 녹음: 피아노에서 들어온 연주(건반, 세기, 페달)를 기록한다 ----------

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function startRecording() {
  stopPlayback();
  rec.active = true;
  rec.start = nowSec();
  rec.events = [];
  setMessage('녹음 중입니다. 연주하세요');
  rec.timer = setInterval(() => {
    $('record-label').textContent = formatTime(nowSec() - rec.start);
  }, 500);
  updateMainButton();
}

function stopRecording() {
  rec.active = false;
  clearInterval(rec.timer);
  if (!rec.events.length) {
    setMessage('녹음된 음이 없습니다. 피아노가 연결되어 있는지 확인해 주세요', 'bad');
  } else {
    // 첫 음 앞의 긴 공백은 잘라낸다.
    const first = rec.events[0].t;
    const lead = Math.min(first, 0.3);
    const events = rec.events.map((e) => ({ t: e.t - first + lead, data: e.data }));
    rec.take = { events, length: events.at(-1).t, at: new Date() };
    const notes = events.filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;
    $('take-info').textContent = `녹음 ${formatTime(rec.take.length)} · 음 ${notes}개`;
    setMessage('녹음을 마쳤습니다', 'good');
  }
  rec.events = [];
  updateMainButton();
}

// 녹음된 메시지를 "언제, 어떤 음을, 얼마나 길게"로 바꾼다. 페달을 밟고 있으면 뗄 때까지 이어진다.
function takeToNotes(events) {
  const notes = [];
  const open = new Map(); // 누르고 있는 건반
  const held = []; // 건반은 뗐지만 페달로 이어지는 음
  let pedal = false;
  for (const event of events) {
    const [status, d1, d2] = event.data;
    const command = status & 0xf0;
    if (command === 0x90 && d2 > 0) {
      const previous = open.get(d1);
      if (previous) previous.dur = event.t - previous.t;
      const note = { t: event.t, midi: d1, vel: d2, dur: null };
      notes.push(note);
      open.set(d1, note);
    } else if (command === 0x80 || command === 0x90) {
      const note = open.get(d1);
      if (note) {
        open.delete(d1);
        if (pedal) held.push(note);
        else note.dur = event.t - note.t;
      }
    } else if (command === 0xb0 && d1 === 64) {
      const down = d2 >= 64;
      if (pedal && !down) {
        for (const note of held) note.dur = event.t - note.t;
        held.length = 0;
      }
      pedal = down;
    }
  }
  const end = events.at(-1).t;
  for (const note of notes) {
    if (note.dur == null) note.dur = end - note.t + 0.5;
    note.dur = Math.max(0.05, note.dur);
  }
  return notes;
}

function playTake() {
  if (!rec.take) return;
  if (state.playing) {
    stopPlayback();
    setMessage('재생을 멈췄습니다');
    return;
  }
  if (rec.active) stopRecording();
  stopTempo();
  const audio =
    sound.getTarget() === 'piano'
      ? rec.take.events.map((e) => ({ t: e.t, raw: e.data }))
      : takeToNotes(rec.take.events);
  startPlayback(audio, [], rec.take.length + 1, () => {
    setMessage('녹음 재생이 끝났습니다');
  });
  setMessage('녹음을 재생하는 중입니다');
  updateMainButton();
}

// 녹음을 표준 MIDI 파일(.mid)로 만든다. 다른 음악 프로그램에서도 열 수 있다.
function takeToMidiFile(take) {
  const TICKS_PER_SECOND = 960; // 4분음표 480틱, 템포 120 기준
  const varLen = (value) => {
    const bytes = [value & 0x7f];
    while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
    return bytes;
  };
  const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20];
  let lastTick = 0;
  for (const event of take.events) {
    const tick = Math.round(event.t * TICKS_PER_SECOND);
    track.push(...varLen(tick - lastTick), ...event.data);
    lastTick = tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const size = track.length;
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
    ...track,
  ]);
}

function saveTake() {
  if (!rec.take) return;
  const d = rec.take.at;
  const pad = (n) => String(n).padStart(2, '0');
  const name =
    `piano-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.mid`;
  const url = URL.createObjectURL(new Blob([takeToMidiFile(rec.take)], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setMessage(`${name} 파일로 저장했습니다`, 'good');
}

// ---------- 회차 종료와 결과 ----------

function isPerfect() {
  const s = state.stats;
  return s.wrong === 0 && s.timing === 0 && s.miss === 0;
}

function accuracy(total) {
  return total ? Math.round((state.stats.ok / total) * 100) : 0;
}

function finishPass() {
  stopTempo();
  state.finished = true;
  const total = state.steps.length;
  const compare = saveResult(total);
  state.compare = compare;
  const improved = compare.previous && compare.now.mistakes < compare.previous.mistakes;

  if (state.loop) {
    let text = isPerfect() ? '퍼펙트!' : `틀림 ${compare.now.mistakes}`;
    if (improved) text += ` (지난번 ${compare.previous.mistakes}에서 줄었습니다)`;
    setMessage(`${state.pass}회차 ${text} · 다시 시작합니다`, 'good');
    if (isPerfect() || improved) confetti();
    state.pass++;
    state.loopTimer = setTimeout(() => {
      if (state.mode === 'tempo') startTempo(true);
      else prepareSession(true);
    }, 900);
    return;
  }

  osmd.cursor.hide();
  setMessage(isPerfect() ? '퍼펙트!' : '완주', 'good');
  showResult(true);
  if (isPerfect() || improved) confetti();
}

// ---------- 기록: 같은 곡, 같은 구간, 같은 손, 같은 모드의 지난 결과와 비교한다 ----------

function mistakeCount() {
  const s = state.stats;
  return s.wrong + s.timing + s.miss;
}

function saveResult(total) {
  const now = { mistakes: mistakeCount(), accuracy: accuracy(total), at: Date.now() };
  const key = [$('title').textContent, state.from, state.to, $('hand').value, state.mode].join('|');
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem('piano-history') || '{}');
  } catch {
    all = {};
  }
  const entry = all[key] ?? {};
  const previous = entry.last ?? null;
  const best = entry.best ?? null;
  const newBest = Boolean(best) && now.mistakes < best.mistakes;
  all[key] = { last: now, best: !best || now.mistakes < best.mistakes ? now : best };
  try {
    localStorage.setItem('piano-history', JSON.stringify(all));
  } catch {
    // 저장이 안 되면 다음 비교만 빠진다
  }
  return { now, previous, best, newBest };
}

function showCompare(final) {
  const box = $('result-compare');
  const compare = state.compare;
  if (!final || !compare) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { now, previous, newBest } = compare;
  const text = $('compare-text');
  $('compare-nums').hidden = !previous;
  if (!previous) {
    text.textContent = '첫 기록입니다. 다음부터는 이 기록과 비교합니다.';
    text.className = '';
    return;
  }
  $('compare-prev').textContent = previous.mistakes;
  $('compare-now').textContent = now.mistakes;
  const diff = previous.mistakes - now.mistakes;
  if (diff > 0) {
    text.textContent =
      `지난번보다 ${diff}개 줄었습니다` + (newBest ? ' · 최고 기록입니다' : '');
    text.className = 'good';
  } else if (diff === 0) {
    text.textContent = now.mistakes === 0 ? '이번에도 퍼펙트입니다' : '지난번과 같습니다';
    text.className = now.mistakes === 0 ? 'good' : '';
  } else {
    text.textContent = `지난번보다 ${-diff}개 많았습니다. 한 번 더 해보세요`;
    text.className = '';
  }
  $('compare-now').className = diff > 0 ? 'good' : '';
}

// ---------- 효과: 고쳐 쳤을 때의 반짝임, 연속 성공 표시, 색종이 ----------

const calmMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function burstAt(x, y) {
  if (calmMotion) return;
  const burst = document.createElement('div');
  burst.className = 'burst';
  burst.style.left = `${x}px`;
  burst.style.top = `${y}px`;
  for (let i = 0; i < 8; i++) {
    const dot = document.createElement('i');
    dot.style.setProperty('--a', `${i * 45}deg`);
    burst.append(dot);
  }
  sheet.append(burst);
  setTimeout(() => burst.remove(), 700);
}

function celebrateFix(notes) {
  const origin = sheet.getBoundingClientRect();
  for (const n of notes) {
    const head = noteHeads(n.note)[0];
    if (!head) continue;
    const box = head.getBoundingClientRect();
    burstAt(box.left + box.width / 2 - origin.left, box.top + box.height / 2 - origin.top);
  }
}

const COMBO_MILESTONES = [10, 25, 50, 100, 200, 300, 500];

// 틀리지 않고 한 번에 맞힌 자리가 이어진 개수. 5개부터 화면에 보인다.
function setCombo(value) {
  state.combo = value;
  const badge = $('combo');
  badge.hidden = value < 5;
  if (value < 5) return;
  badge.textContent = `${value} 연속`;
  const milestone = COMBO_MILESTONES.includes(value);
  badge.classList.remove('pop', 'big');
  void badge.offsetWidth; // 애니메이션 다시 시작
  badge.classList.add(milestone ? 'big' : 'pop');
  if (milestone) setMessage(`${value}개 연속으로 맞혔습니다`, 'good');
}

function confetti() {
  if (calmMotion) return;
  const colors = ['#16a34a', '#2563eb', '#d97706', '#db2777', '#7c3aed'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < 44; i++) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.5}s`;
    piece.style.animationDuration = `${1.4 + Math.random() * 1.1}s`;
    piece.style.setProperty('--drift', `${Math.random() * 120 - 60}px`);
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3200);
}

function showResult(final) {
  const s = state.stats;
  const total = state.steps.length;
  const judged = final
    ? total
    : state.mode === 'tempo'
      ? state.missPtr
      : state.pos;

  $('result-title').textContent = !final
    ? '지금까지 결과'
    : isPerfect()
      ? '퍼펙트!'
      : '완주했습니다';

  let body;
  if (final && isPerfect()) {
    body = state.mode === 'tempo' ? '음과 박자를 모두 맞혔습니다.' : '한 음도 틀리지 않았습니다.';
  } else if (state.mode === 'tempo') {
    body =
      `정확도 ${accuracy(judged)}%\n` +
      `박자 어긋남 ${s.timing} · 놓친 음 ${s.miss} · 틀린 음 ${s.wrong}`;
  } else {
    body = `정확도 ${accuracy(judged)}%\n틀린 횟수 ${s.wrong}번`;
  }
  if (state.pass > 1) body += `\n(${state.pass}회차 기준)`;
  $('result-body').textContent = body;

  const box = $('result-measures');
  box.replaceChildren();
  // 틀린 마디가 이어져 있으면 하나의 구간으로 묶는다(예: 5, 6, 7마디 → 5–7마디).
  const measures = [...state.perMeasure.entries()].sort((a, b) => a[0] - b[0]);
  const groups = [];
  for (const [measure, count] of measures) {
    const last = groups.at(-1);
    if (last && measure === last.to + 1) {
      last.to = measure;
      last.count += count;
    } else {
      groups.push({ from: measure, to: measure, count });
    }
  }
  for (const group of groups) {
    const chip = document.createElement('button');
    const name = group.from === group.to ? `${group.from}마디` : `${group.from}–${group.to}마디`;
    chip.textContent = `${name} · ${group.count}번`;
    chip.addEventListener('click', () => setRange(group.from, group.to, true));
    box.append(chip);
  }
  $('result-hint').textContent = groups.length
    ? '틀린 구간입니다. 누르면 그 구간만 반복 연습합니다.' +
      (state.pass > 1 ? ' (반복한 회차 전체 합계)' : '')
    : '';

  showCompare(final);
  $('result').hidden = false;
}

function updateStatus() {
  const total = state.steps.length;
  const step = state.steps[Math.min(state.pos, total - 1)];
  $('progress').textContent =
    step?.measure != null ? `${step.measure} / ${state.lastMeasure}마디` : '–';

  // 아래쪽 줄의 점수: 큰 숫자는 정확도, 옆은 틀린 내용.
  const s = state.stats;
  const judged = state.mode === 'tempo' ? state.missPtr : state.pos;
  $('stat-main').textContent = judged ? `${accuracy(judged)}%` : '–';
  const parts = [];
  if (state.loop) parts.push(`${state.pass}회차`);
  if (state.mode === 'tempo') parts.push(`박자 ${s.timing}`, `놓침 ${s.miss}`);
  parts.push(`틀림 ${s.wrong}`);
  $('stat-sub').textContent = parts.join(' · ');
  $('stat-sub').classList.toggle('has-mistakes', s.wrong + s.timing + s.miss > 0);
}

// ---------- 음표 색칠 ----------

// 악보 그림에서 그 음표의 머리 부분을 찾는다.
function noteHeads(note) {
  const graphical = osmd.rules.GNote(note);
  if (!graphical) return [];
  let heads = [];
  try {
    heads = graphical.getNoteheadSVGs?.() ?? [];
  } catch {
    heads = [];
  }
  if (!heads.length) {
    const group = graphical.getSVGGElement?.();
    if (!group) return [];
    heads = [...group.querySelectorAll('.vf-notehead')];
    if (!heads.length) heads = [group];
  }
  return heads;
}

function colorNote(note, color) {
  for (const head of noteHeads(note)) {
    for (const path of head.querySelectorAll('path')) {
      path.setAttribute('fill', color);
      path.setAttribute('stroke', color);
    }
  }
}

function paint(note, color) {
  state.paint.set(note, color);
  colorNote(note, color);
}

function clearPaint() {
  for (const note of state.paint.keys()) colorNote(note, COLOR_PLAIN);
  state.paint.clear();
}

// 확대/축소나 화면 회전으로 악보를 다시 그린 뒤 색과 커서를 복원한다.
function rerenderKeepingProgress() {
  if (!state.loaded) return;
  osmd.zoom = state.zoom;
  osmd.render();
  osmd.cursor.reset();
  state.cursorPos = 0;
  for (const [note, color] of state.paint) colorNote(note, color);
  if (state.finished && !state.loop) {
    osmd.cursor.hide();
  } else {
    osmd.cursor.show();
    moveCursorToStep();
  }
  drawRangeOverlay();
}

// ---------- 피아노 연결 ----------

// 똑같은 신호가 아주 짧은 간격(0.02초 안)으로 다시 오면 겹쳐 들어온 것으로 보고 버린다.
// 사람이 같은 건반을 이렇게 빨리 다시 누를 수는 없다.
const lastMessageAt = new Map();

function isEcho(status, d1, d2) {
  const key = (status << 16) | (d1 << 8) | d2;
  const now = performance.now();
  const previous = lastMessageAt.get(key);
  lastMessageAt.set(key, now);
  return previous !== undefined && now - previous < 20;
}

function onMidiMessage(status, d1, d2) {
  if (isEcho(status, d1, d2)) return;
  const command = status & 0xf0;
  const isNote = command === 0x90 || command === 0x80;
  const isPedal = command === 0xb0 && d1 === 64;
  if (rec.active && !state.playing && (isNote || isPedal)) {
    rec.events.push({ t: nowSec() - rec.start, data: [status, d1, d2] });
  }
  if (command === 0x90 && d2 > 0) handleNoteOn(d1);
}

function onLinkState({ connected, name, reconnecting }) {
  const el = $('link');
  if (connected) {
    el.textContent = name || '연결됨';
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

async function tryBluetooth(showAll) {
  if (!bluetoothSupported()) {
    setMessage('이 브라우저는 블루투스 연결을 지원하지 않습니다. 안드로이드 크롬에서 열어주세요.', 'bad');
    return;
  }
  try {
    setMessage('피아노를 선택하면 연결을 시작합니다. 길면 30초 정도 걸릴 수 있습니다.');
    await connectBluetooth(onMidiMessage, onLinkState, showAll);
    $('connect-all').hidden = true;
    setMessage('피아노가 연결되었습니다', 'good');
  } catch (error) {
    if (error.name === 'NotFoundError') {
      // 선택 창을 그냥 닫은 경우: 목록에 피아노가 없었을 수 있다.
      $('connect-all').hidden = false;
      setMessage('목록에 피아노가 없었다면 "모든 기기 보기"를 눌러보세요');
      return;
    }
    console.error(error);
    const seen = error.visible ? ` [보이는 서비스: ${error.visible}]` : '';
    setMessage(`연결 실패: ${error.message}${seen}`, 'bad');
  }
}

$('connect').addEventListener('click', () => tryBluetooth(false));
$('connect-all').addEventListener('click', () => tryBluetooth(true));

$('connect-usb').addEventListener('click', async () => {
  if (!webMidiSupported()) {
    setMessage('이 브라우저는 MIDI 기기 연결을 지원하지 않습니다.', 'bad');
    return;
  }
  try {
    const count = await connectWebMidi(onMidiMessage, onLinkState);
    setMessage(
      count
        ? 'MIDI 기기가 연결되었습니다'
        : '피아노가 아직 안 보입니다. MIDI BLE Connect에서 피아노를 연결하면 자동으로 잡힙니다.',
      count ? 'good' : 'bad'
    );
  } catch (error) {
    console.error(error);
    setMessage('MIDI 연결 실패: ' + error.message, 'bad');
  }
});

// 이전에 MIDI 사용을 허용한 적이 있으면 버튼을 누르지 않아도 바로 연결한다.
// 한 번 연결해 두면 피아노가 나중에 잡혀도 자동으로 반영된다.
async function autoConnectMidi() {
  if (!webMidiSupported() || !navigator.permissions) return;
  try {
    const permission = await navigator.permissions.query({ name: 'midi' });
    if (permission.state !== 'granted') return;
    await connectWebMidi(onMidiMessage, onLinkState);
  } catch {
    // 자동 연결이 안 되면 버튼으로 연결하면 된다
  }
}

// ---------- 화면 조작 ----------

$('restart').addEventListener('click', () => {
  if (!state.loaded) return;
  if (state.mode !== 'tempo') {
    newPractice();
  } else if (state.running) {
    clearTimeout(state.loopTimer);
    stopTempo();
    setMessage('정지했습니다');
  } else {
    state.perMeasure = new Map();
    state.pass = 1;
    startTempo();
  }
});

$('listen-play').addEventListener('click', () => {
  if (!state.loaded) return;
  if (!state.listening) {
    startListening();
  } else if (state.paused) {
    resumePlayback();
    setMessage('이어서 들려주는 중입니다');
  } else {
    pausePlayback();
    setMessage('일시정지했습니다. 재생 버튼을 누르면 이어집니다');
  }
});

$('listen-stop').addEventListener('click', () => {
  if (!state.listening) return;
  prepareSession();
  setMessage('듣기를 멈췄습니다');
});

// 악보를 누르면: 구간을 고르는 중이면 그 마디를 구간으로, 아니면 그 마디부터 들려준다.
sheet.addEventListener('click', (event) => {
  if (!state.loaded) return;
  const measure = measureAt(event.clientX, event.clientY);
  if (measure == null) return;
  if (state.picking) {
    pickMeasure(measure);
    return;
  }
  if (state.running || rec.active) return; // 템포 연습이나 녹음 중에는 방해하지 않는다
  startListening(measure);
});

$('range-pick').addEventListener('click', () => {
  if (!state.loaded) return;
  if (state.picking) {
    state.picking = null;
    setMessage('구간 설정을 취소했습니다');
    updateMainButton();
    drawRangeOverlay();
  } else if (rangeIsPartial()) {
    setRange(state.firstMeasure, state.lastMeasure, false);
    setMessage('구간을 해제했습니다. 전체를 연습합니다');
  } else {
    prepareSession();
    state.picking = { first: null };
    setMessage('반복할 첫 마디를 악보에서 누르세요');
    updateMainButton();
  }
});

$('record').addEventListener('click', () => {
  if (rec.active) stopRecording();
  else startRecording();
});
$('take-play').addEventListener('click', playTake);
$('take-save').addEventListener('click', saveTake);
$('take-delete').addEventListener('click', () => {
  if (state.playing && !state.listening) stopPlayback();
  rec.take = null;
  setMessage('녹음을 지웠습니다');
  updateMainButton();
});

$('sound-out').addEventListener('change', (event) => {
  state.soundOut = event.target.value;
  sound.setTarget(state.soundOut);
  savePrefs();
  if (state.soundOut === 'piano' && !getMidiOutputs().length) {
    setMessage('피아노로 보내는 통로가 안 잡혀서 폰 스피커로 재생합니다. 피아노 연결을 먼저 해주세요.', 'bad');
  }
});

$('show-result').addEventListener('click', () => {
  if (state.loaded) showResult(state.finished && !state.loop);
});
$('result-close').addEventListener('click', () => {
  $('result').hidden = true;
});
$('result-again').addEventListener('click', () => {
  $('result').hidden = true;
  if (state.mode === 'tempo') {
    state.perMeasure = new Map();
    state.pass = 1;
    startTempo();
  } else {
    newPractice();
  }
});

// 메뉴(왼쪽)와 설정(아래쪽) 패널 열고 닫기. 바깥의 어두운 부분을 눌러도 닫힌다.
function setPanel(id, open) {
  $(id).hidden = !open;
  $(`${id}-toggle`).setAttribute('aria-expanded', String(open));
}

for (const id of ['menu', 'settings']) {
  $(`${id}-toggle`).addEventListener('click', () => setPanel(id, $(id).hidden));
  $(id).addEventListener('click', (event) => {
    if (event.target === $(id) || event.target.closest('[data-close]')) setPanel(id, false);
  });
}

// 위쪽 줄의 곡 이름은 곡 선택 상자에서 지금 고른 곡을 따른다.
function showTitle() {
  $('title').textContent = $('song').selectedOptions[0]?.textContent ?? '';
}

$('hand').addEventListener('change', () => state.loaded && newPractice());

$('mode').addEventListener('click', (event) => {
  const mode = event.target.closest('button')?.dataset.mode;
  if (!mode || mode === state.mode) return;
  state.mode = mode;
  savePrefs();
  syncControls();
  if (state.loaded) newPractice();
});

$('bpm').addEventListener('change', (event) => {
  const value = Math.round(Number(event.target.value));
  state.bpm = Math.min(240, Math.max(20, value || 60));
  event.target.value = state.bpm;
  savePrefs();
  if (state.loaded) newPractice();
});

$('tol').addEventListener('change', (event) => {
  state.tol = Number(event.target.value);
  savePrefs();
});

$('metronome').addEventListener('change', (event) => {
  state.metronome = event.target.checked;
  savePrefs();
});

$('loop').addEventListener('change', (event) => {
  state.loop = event.target.checked;
  updateStatus();
});

function applyRange() {
  const clamp = (v) =>
    Math.min(state.lastMeasure, Math.max(state.firstMeasure, Math.round(Number(v)) || state.firstMeasure));
  let from = clamp($('from').value);
  let to = clamp($('to').value);
  if (from > to) [from, to] = [to, from];
  state.from = from;
  state.to = to;
  syncControls();
  if (state.loaded) newPractice();
}

$('from').addEventListener('change', applyRange);
$('to').addEventListener('change', applyRange);
$('range-all').addEventListener('click', () => {
  $('from').value = state.firstMeasure;
  $('to').value = state.lastMeasure;
  applyRange();
});

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

// 곡 선택 상자는 항상 지금 화면에 있는 곡 이름을 보여준다.
let currentSong = 'hanon1';
let openedFile = null; // 마지막으로 연 악보 파일 { name, data }

$('song').addEventListener('change', async (event) => {
  const value = event.target.value;
  event.target.value = currentSong; // 실제로 바뀐 뒤에만 표시를 바꾼다
  if (value === 'open') {
    $('file').click();
  } else if (value === 'hanon1') {
    if (await loadScore(buildHanon1())) currentSong = 'hanon1';
  } else if (value === 'opened' && openedFile) {
    if (await loadScore(openedFile.data)) currentSong = 'opened';
  }
  $('song').value = currentSong;
  showTitle();
  if (value !== 'open') setPanel('menu', false);
});

$('file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    if (!(await loadScore(reader.result))) return; // 실패하면 이전 곡이 그대로 남는다
    const name = file.name.replace(/\.(musicxml|xml|mxl)$/i, '').replace(/_/g, ' ');
    openedFile = { name, data: reader.result };
    const option = $('song-opened');
    option.textContent = name;
    option.hidden = false;
    currentSong = 'opened';
    $('song').value = 'opened';
    showTitle();
    setPanel('menu', false);
  };
  reader.onerror = () => setMessage('파일을 읽지 못했습니다', 'bad');
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
    const taken = state.mode === 'wait' ? state.hit : step.hits;
    const next = [...expected].find((m) => !taken.has(m));
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
  window.pianoDebug = {
    state, rec, sound, handleNoteOn, onMidiMessage, debugPlay, startTempo, nowSec, takeToNotes,
    takeToMidiFile, measureBoxes,
  };
}

loadPrefs();
syncControls();
loadScore(buildHanon1()).then(autoConnectMidi);
setTimeout(() => sound.preloadSamples(), 1500);
