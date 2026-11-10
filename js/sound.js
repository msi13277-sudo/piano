// 소리 내기: 폰 스피커(녹음된 피아노 음색) 또는 연결된 피아노(MIDI 출력).
import { getMidiOutputs } from './midi.js?v=12';

// 피아노 음색: Salamander Grand Piano (Alexander Holm, CC BY 3.0).
// 단3도 간격으로 녹음된 30개 음을 받아 두고, 사이 음은 가장 가까운 음의 속도를 바꿔서 낸다.
const SAMPLE_NAMES = [
  'A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4',
  'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8',
];
const FIRST_SAMPLE_MIDI = 21; // A0

let ctx = null;
let master = null;
let wanted = 'phone'; // 사용자가 고른 출력
let usedPiano = false;
const voices = new Set();

const rawSamples = new Map(); // midi → 내려받은 파일
const buffers = new Map(); // midi → 재생 가능한 소리
let fetching = null;
let decoding = null;

// 앱이 열리면 미리 파일을 받아 둔다(소리를 내려면 화면을 한 번 눌러야 해서 해석은 그때 한다).
export function preloadSamples() {
  fetching ??= Promise.all(
    SAMPLE_NAMES.map(async (name, i) => {
      try {
        const url = new URL(`../samples/piano/${name}.mp3`, import.meta.url);
        const response = await fetch(url);
        if (response.ok) rawSamples.set(FIRST_SAMPLE_MIDI + 3 * i, await response.arrayBuffer());
      } catch {
        // 못 받은 음은 가까운 다른 음으로 대신한다
      }
    })
  );
  return fetching;
}

function decodeSamples() {
  if (!ctx) return Promise.resolve();
  decoding ??= preloadSamples().then(() =>
    Promise.all(
      [...rawSamples].map(async ([midi, data]) => {
        try {
          buffers.set(midi, await ctx.decodeAudioData(data));
        } catch {
          // 해석에 실패한 음은 건너뛴다
        }
      })
    )
  );
  return decoding;
}

// 피아노 음색이 준비될 때까지 기다린다(최대 4초). 피아노로 내보낼 때는 기다릴 필요가 없다.
export function whenReady() {
  if (getTarget() === 'piano' || !ctx) return Promise.resolve();
  return Promise.race([decodeSamples(), new Promise((resolve) => setTimeout(resolve, 4000))]);
}

export function setTarget(value) {
  wanted = value;
}

// 피아노를 골랐어도 출력이 안 잡혀 있으면 폰 스피커로 낸다.
export function getTarget() {
  return wanted === 'piano' && getMidiOutputs().length ? 'piano' : 'phone';
}

export function ensureAudio() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const limiter = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(limiter).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    decodeSamples();
  } catch {
    ctx = null; // 소리를 못 내도 나머지 기능은 계속 동작한다
  }
  return ctx;
}

// 메트로놈 소리. 항상 폰 스피커에서 난다.
export function click(delay, accent) {
  if (!ctx) return;
  const at = ctx.currentTime + Math.max(0, delay);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = accent ? 1500 : 1000;
  gain.gain.setValueAtTime(0.25, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.06);
}

function track(node) {
  voices.add(node);
  node.onended = () => voices.delete(node);
}

// 녹음된 피아노 음으로 낸다. 쓸 수 있는 음이 없으면 false.
function sampleNote(midi, velocity, delay, duration) {
  let nearest = null;
  let gap = Infinity;
  for (const key of buffers.keys()) {
    const d = Math.abs(key - midi);
    if (d < gap) {
      nearest = key;
      gap = d;
    }
  }
  if (nearest == null || gap > 4) return false;

  const at = ctx.currentTime + Math.max(0, delay);
  const source = ctx.createBufferSource();
  source.buffer = buffers.get(nearest);
  source.playbackRate.value = 2 ** ((midi - nearest) / 12);

  const level = 0.12 + 0.88 * (velocity / 127) ** 1.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, at);
  gain.gain.setValueAtTime(level, at + duration);
  gain.gain.linearRampToValueAtTime(0.0001, at + duration + 0.25); // 건반을 뗀 뒤의 여운

  source.connect(gain).connect(master);
  source.start(at);
  source.stop(at + duration + 0.3);
  track(source);
  return true;
}

// 피아노 음색을 아직 못 쓸 때만 쓰는 단순한 합성음.
function synthNote(midi, velocity, delay, duration) {
  const at = ctx.currentTime + Math.max(0, delay);
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const peak = 0.05 + 0.3 * (velocity / 127) ** 1.6;
  const decay = Math.min(2.2, Math.max(0.25, 0.9 * 2 ** ((60 - midi) / 24)));

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.linearRampToValueAtTime(peak, at + 0.006);
  envelope.gain.setTargetAtTime(0.0001, at + 0.006, decay);

  const release = ctx.createGain();
  release.gain.setValueAtTime(1, at + duration);
  release.gain.linearRampToValueAtTime(0.0001, at + duration + 0.15);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  osc.connect(envelope).connect(release).connect(master);
  osc.start(at);
  osc.stop(at + duration + 0.2);
  track(osc);
}

export function playNote(midi, velocity, delay, duration) {
  if (getTarget() === 'piano') {
    usedPiano = true;
    const at = performance.now() + Math.max(0, delay) * 1000;
    for (const out of getMidiOutputs()) {
      out.send([0x90, midi, velocity], at);
      out.send([0x80, midi, 0], at + duration * 1000);
    }
    return;
  }
  if (!ctx) return;
  if (!sampleNote(midi, velocity, delay, duration)) synthNote(midi, velocity, delay, duration);
}

// 녹음된 MIDI 메시지를 그대로 피아노로 보낸다(페달 포함).
export function sendRaw(data, delay) {
  usedPiano = true;
  const at = performance.now() + Math.max(0, delay) * 1000;
  for (const out of getMidiOutputs()) out.send(data, at);
}

export function sampleCount() {
  return buffers.size;
}

export function stopAll() {
  for (const node of voices) {
    try {
      node.stop();
    } catch {
      // 이미 멈춘 소리는 무시
    }
  }
  voices.clear();
  if (usedPiano) {
    usedPiano = false;
    for (const out of getMidiOutputs()) {
      try {
        out.send([0xb0, 123, 0]); // 모든 음 끄기
        out.send([0xb0, 64, 0]); // 페달 떼기
      } catch {
        // 출력이 끊겼으면 무시
      }
    }
  }
}
