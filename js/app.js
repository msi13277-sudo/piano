// ?v= 숫자는 브라우저가 예전 파일을 계속 쓰지 않게 하려는 것. index.html의 버전과 함께 올린다.
import { buildHanon1 } from './hanon.js?v=7';
import {
  bluetoothSupported,
  webMidiSupported,
  connectBluetooth,
  connectWebMidi,
} from './midi.js?v=7';

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
};

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function nowSec() {
  return performance.now() / 1000;
}

function setMessage(text, kind = '') {
  const el = $('message');
  el.textContent = text;
  el.className = kind;
}

function flashWrong() {
  stage.classList.remove('flash');
  void stage.offsetWidth; // 애니메이션 다시 시작
  stage.classList.add('flash');
}

// ---------- 설정 저장 ----------

const PREF_KEYS = ['mode', 'bpm', 'tol', 'metronome'];

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
  $('mode').value = state.mode;
  $('bpm').value = state.bpm;
  $('tol').value = String(state.tol);
  $('metronome').checked = state.metronome;
  $('loop').checked = state.loop;
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
  $('restart').textContent =
    state.mode === 'tempo' ? (state.running ? '정지' : '시작') : '처음부터';
}

// ---------- 악보 불러오기 ----------

async function loadScore(xml) {
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

// 한 회차 준비: 색칠과 점수를 지우고 커서를 구간 처음에 둔다.
function prepareSession(keepMessage = false) {
  clearTimeout(state.loopTimer);
  stopTempo();

  const wanted = (n) =>
    state.hand === 'both' || (state.hand === 'right' ? n.staff === 0 : n.staff !== 0);
  state.hand = $('hand').value;

  state.steps = state.allSteps
    .filter((s) => s.measure == null || (s.measure >= state.from && s.measure <= state.to))
    .map((s) => ({
      ...s,
      notes: s.notes.filter(wanted),
      hits: new Set(),
      result: null,
      off: false,
      sec: 0,
    }))
    .filter((s) => s.notes.length);

  const base = state.steps[0]?.beats ?? 0;
  for (const s of state.steps) s.sec = ((s.beats - base) * 60) / state.bpm;

  state.pos = 0;
  state.hit = new Set();
  state.stepMistake = false;
  state.finished = false;
  state.missPtr = 0;
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
}

function moveCursorToStep(force = false) {
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
  keepCursorVisible(force);
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
  if (!state.loaded) return;
  if (state.mode === 'tempo') tempoNoteOn(midi);
  else waitNoteOn(midi);
}

// ---------- 기다림 모드: 맞는 음을 쳐야 다음으로 넘어간다 ----------

function waitNoteOn(midi) {
  if (state.finished) return;
  const step = state.steps[state.pos];
  if (!step) return;
  const expected = expectedSet(step);

  if (!expected.has(midi)) {
    state.stepMistake = true;
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
  if (!state.stepMistake) state.stats.ok++;
  if (state.stepMistake) setMessage('');
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

let audio = null;

function ensureAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null; // 소리를 못 내도 판정은 계속한다
  }
}

function scheduleClick(delay, countIn) {
  if (!audio) return;
  const at = audio.currentTime + Math.max(0, delay);
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = countIn ? 1500 : 1000;
  gain.gain.setValueAtTime(0.25, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + 0.06);
}

function startTempo(keepMessage = false) {
  prepareSession(keepMessage);
  if (!state.steps.length) return;
  ensureAudio();
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
      scheduleClick(state.clickIndex * beat - t, state.clickIndex < 0);
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

  if (state.loop) {
    const text = isPerfect() ? '퍼펙트!' : `정확도 ${accuracy(total)}%`;
    setMessage(`${state.pass}회차 ${text} · 다시 시작합니다`, 'good');
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
  const measures = [...state.perMeasure.entries()].sort((a, b) => a[0] - b[0]);
  for (const [measure, count] of measures) {
    const chip = document.createElement('button');
    chip.textContent = `${measure}마디 · ${count}번`;
    chip.addEventListener('click', () => practiceMeasure(measure));
    box.append(chip);
  }
  $('result-hint').textContent = measures.length
    ? '틀린 마디입니다. 누르면 그 마디만 반복 연습합니다.' +
      (state.pass > 1 ? ' (반복한 회차 전체 합계)' : '')
    : '';

  $('result').hidden = false;
}

function practiceMeasure(measure) {
  state.from = measure;
  state.to = measure;
  state.loop = true;
  syncControls();
  newPractice();
}

function updateStatus() {
  const total = state.steps.length;
  const step = state.steps[Math.min(state.pos, total - 1)];
  $('progress').textContent =
    step?.measure != null ? `마디 ${step.measure} / ${state.lastMeasure}` : '–';

  const s = state.stats;
  const prefix = state.loop ? `${state.pass}회차 · ` : '';
  if (state.mode === 'tempo') {
    $('score').textContent =
      `${prefix}정확 ${s.ok} · 박자 ${s.timing} · 놓침 ${s.miss} · 틀림 ${s.wrong}`;
  } else {
    const done = state.pos;
    $('score').textContent = done
      ? `${prefix}정확도 ${accuracy(done)}% · 틀린 횟수 ${s.wrong}`
      : `${prefix}틀린 횟수 ${s.wrong}`;
  }
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

$('settings-toggle').addEventListener('click', (event) => {
  const panel = $('settings');
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});

$('hand').addEventListener('change', () => state.loaded && newPractice());

$('mode').addEventListener('change', (event) => {
  state.mode = event.target.value;
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
    const taken = state.mode === 'tempo' ? step.hits : state.hit;
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
  window.pianoDebug = { state, handleNoteOn, debugPlay, startTempo, nowSec };
}

loadPrefs();
syncControls();
loadScore(buildHanon1()).then(autoConnectMidi);
