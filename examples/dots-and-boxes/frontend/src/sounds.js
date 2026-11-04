// Pencil-on-paper sounds for Dots & Boxes, synthesized with the Web Audio
// API (no audio files): a filtered noise burst is a pencil stroke, a run
// of short ones a scribble, and a flourish ends the game. Everything is a
// no-op outside a browser (play-test.mjs imports the plugin in Node) and
// while the player has muted the page (remembered in localStorage).

const STORAGE_KEY = "dab-sound";
const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";

let ctx = null;
let master = null;
let noise = null;
let enabled = readEnabled();

function readEnabled() {
  if (!inBrowser) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function soundEnabled() {
  return enabled;
}

export function setSoundEnabled(on) {
  enabled = !!on;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {}
  if (enabled) unlockAudio();
}

// Browsers only start audio after a user gesture: call this from a
// pointerdown/keydown listener. Safe to call any number of times.
export function unlockAudio() {
  if (!inBrowser || !enabled) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

function ready() {
  if (!enabled) return false;
  unlockAudio();
  return ctx !== null && ctx.state === "running";
}

function noiseBuffer() {
  if (noise) return noise;
  const seconds = 1;
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise = buf;
  return buf;
}

// One graphite stroke starting at `at` (AudioContext seconds): band-passed
// noise with a quick attack, a slow fade and a slight downward sweep, the
// way a pencil slows at the end of a line.
function stroke(at, { dur = 0.18, freq = 1800, q = 0.9, gain = 0.3, sweep = 0.7 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.loop = true;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;

  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.setValueAtTime(freq, at);
  band.frequency.exponentialRampToValueAtTime(Math.max(200, freq * sweep), at + dur);
  band.Q.value = q;

  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 500;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.015);
  env.gain.setValueAtTime(gain, at + dur * 0.45);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  src.connect(band).connect(high).connect(env).connect(master);
  src.start(at);
  src.stop(at + dur + 0.05);
}

// A soft wooden tap: the pencil touching the paper.
function tap(at, { freq = 900, gain = 0.06, dur = 0.06 } = {}) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, at + dur);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(env).connect(master);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/// A line being drawn, `delayMs` from now.
export function playStroke(delayMs = 0) {
  if (!ready()) return;
  const t = ctx.currentTime + delayMs / 1000;
  tap(t, { freq: 700 + Math.random() * 300, gain: 0.04 });
  stroke(t + 0.01, {
    dur: 0.2 + Math.random() * 0.08,
    freq: 1500 + Math.random() * 900,
    gain: 0.28,
  });
}

/// A box being shaded in: several quick back-and-forth strokes.
export function playScribble(delayMs = 0) {
  if (!ready()) return;
  const t0 = ctx.currentTime + delayMs / 1000;
  const passes = 6;
  for (let i = 0; i < passes; i++) {
    stroke(t0 + i * 0.075, {
      dur: 0.085,
      freq: 2200 + (i % 2) * 500 + Math.random() * 300,
      q: 1.2,
      gain: 0.16,
      sweep: 0.9,
    });
  }
}

/// The game is over: a short flourish and a pencil laid down.
export function playFinish(delayMs = 0) {
  if (!ready()) return;
  const t0 = ctx.currentTime + delayMs / 1000;
  const notes = [1200, 1700, 2400];
  notes.forEach((f, i) => stroke(t0 + i * 0.11, { dur: 0.14, freq: f, gain: 0.22, sweep: 1.1 }));
  tap(t0 + 0.45, { freq: 520, gain: 0.08, dur: 0.12 });
  tap(t0 + 0.47, { freq: 780, gain: 0.05, dur: 0.1 });
}
