// 소리 내기: 폰 스피커(간단한 합성음) 또는 연결된 피아노(MIDI 출력).
import { getMidiOutputs } from './midi.js?v=9';

let ctx = null;
let master = null;
let wanted = 'phone'; // 사용자가 고른 출력
let usedPiano = false;
const voices = new Set();

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

function synthNote(midi, velocity, delay, duration) {
  if (!ctx) return;
  const at = ctx.currentTime + Math.max(0, delay);
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const peak = 0.05 + 0.3 * (velocity / 127) ** 1.6;
  // 피아노처럼 누르고 있어도 소리가 줄어들고, 낮은 음일수록 오래 남는다.
  const decay = Math.min(2.2, Math.max(0.25, 0.9 * 2 ** ((60 - midi) / 24)));

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.linearRampToValueAtTime(peak, at + 0.006);
  envelope.gain.setTargetAtTime(0.0001, at + 0.006, decay);

  const release = ctx.createGain();
  release.gain.setValueAtTime(1, at + duration);
  release.gain.linearRampToValueAtTime(0.0001, at + duration + 0.15);

  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.value = freq;
  const bright = ctx.createOscillator();
  bright.type = 'triangle';
  bright.frequency.value = freq * 2;
  const brightGain = ctx.createGain();
  brightGain.gain.value = 0.22;

  body.connect(envelope);
  bright.connect(brightGain).connect(envelope);
  envelope.connect(release).connect(master);

  for (const osc of [body, bright]) {
    osc.start(at);
    osc.stop(at + duration + 0.2);
    voices.add(osc);
    osc.onended = () => voices.delete(osc);
  }
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
  synthNote(midi, velocity, delay, duration);
}

// 녹음된 MIDI 메시지를 그대로 피아노로 보낸다(페달 포함).
export function sendRaw(data, delay) {
  usedPiano = true;
  const at = performance.now() + Math.max(0, delay) * 1000;
  for (const out of getMidiOutputs()) out.send(data, at);
}

export function stopAll() {
  for (const osc of voices) {
    try {
      osc.stop();
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
