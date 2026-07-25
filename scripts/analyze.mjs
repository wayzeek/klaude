#!/usr/bin/env node
/**
 * Analyze a WAV recording - the agent's ears.
 *
 * Reports what a producer would listen for: loudness over time, dynamics,
 * frequency balance, stereo width, clipping, and how the energy arc moves
 * across the piece. Pure Node, no dependencies.
 *
 * Usage:
 *   node scripts/analyze.mjs [file.wav] [--json]
 *
 * With no file, analyzes the newest WAV in recordings/.
 */

import fs from 'node:fs'
import path from 'node:path'

const WINDOW_SECONDS = 0.5
const FFT_SIZE = 4096
const SILENCE_DB = -55
const SPARK_CHARS = ' ▁▂▃▄▅▆▇█'
const SPARK_FLOOR_DB = -50
const SPARK_CEIL_DB = -8

export const BANDS = [
  { name: 'sub', lo: 20, hi: 60 },
  { name: 'bass', lo: 60, hi: 150 },
  { name: 'low-mid', lo: 150, hi: 400 },
  { name: 'mid', lo: 400, hi: 2000 },
  { name: 'high-mid', lo: 2000, hi: 6000 },
  { name: 'air', lo: 6000, hi: 16000 },
]

// --- WAV parsing -------------------------------------------------------------

function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let fmt = null
  let dataOffset = -1
  let dataSize = 0
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      }
    } else if (id === 'data') {
      dataOffset = offset + 8
      dataSize = Math.min(size, buf.length - dataOffset)
    }
    offset += 8 + size + (size % 2)
  }
  if (!fmt || dataOffset < 0) throw new Error('Missing fmt or data chunk')
  const pcm16 = fmt.format === 1 && fmt.bitsPerSample === 16
  const float32 = fmt.format === 3 && fmt.bitsPerSample === 32
  if (!pcm16 && !float32) {
    throw new Error(`Unsupported WAV encoding (format ${fmt.format}, ${fmt.bitsPerSample}-bit)`)
  }
  if (fmt.channels !== 1 && fmt.channels !== 2) {
    throw new Error(`Unsupported channel count (${fmt.channels}) - only mono and stereo`)
  }
  return { ...fmt, dataOffset, dataSize, float32 }
}

// --- FFT (iterative radix-2, in place) ----------------------------------------

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vRe = re[b] * curRe - im[b] * curIm
        const vIm = re[b] * curIm + im[b] * curRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }
}

const hannCache = new Map()

/** Hann window of length n, built once per size. */
function makeHann(n) {
  let window = hannCache.get(n)
  if (window) return window
  window = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  }
  hannCache.set(n, window)
  return window
}

const hann = makeHann(FFT_SIZE)

const toDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -Infinity)
const fmtDb = (db) => (db === -Infinity || db === null || Number.isNaN(db) ? '-inf' : db.toFixed(1))

// --- rhythm: onsets and tempo ---------------------------------------------------

/*
 * Loudness and frequency balance say how a mix sounds, never what it plays. A
 * track can be perfectly balanced and still be arrhythmic, in the wrong key, or
 * half the intended tempo. These two passes measure the musical content: where
 * the hits land, and which notes are sounding.
 */

const ONSET_FFT = 1024
const ONSET_HOP = 512
const CHROMA_FFT = 4096
const CHROMA_HOP = 2048
const MIN_BPM = 60
const MAX_BPM = 200
/** Peak must exceed its neighbourhood mean by this factor to count as a hit. */
const ONSET_THRESHOLD = 1.4
/** Half-window, in hops, for the adaptive onset threshold (~90ms each side). */
const ONSET_NEIGHBOURHOOD = 8

/**
 * Spectral flux novelty curve: how much the spectrum brightened at each hop.
 *
 * Percussive attacks add energy across many bins at once, so summing only the
 * positive frame-to-frame magnitude changes gives a curve that spikes on hits
 * and ignores sustained tones.
 */
function computeNovelty(readSample, numFrames, channels) {
  if (numFrames < ONSET_FFT * 2) return null
  const window = makeHann(ONSET_FFT)
  const re = new Float32Array(ONSET_FFT)
  const im = new Float32Array(ONSET_FFT)
  const bins = ONSET_FFT / 2
  const hops = Math.floor((numFrames - ONSET_FFT) / ONSET_HOP) + 1
  const novelty = new Float32Array(hops)
  let previous = null
  let current = new Float32Array(bins)

  for (let hop = 0; hop < hops; hop++) {
    const start = hop * ONSET_HOP
    for (let i = 0; i < ONSET_FFT; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += readSample(start + i, ch)
      re[i] = (sum / channels) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 1; bin < bins; bin++) {
      current[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    }
    if (previous) {
      let flux = 0
      let magnitude = 0
      for (let bin = 1; bin < bins; bin++) {
        const delta = current[bin] - previous[bin]
        if (delta > 0) flux += delta
        magnitude += current[bin]
      }
      // Normalise by the frame's own magnitude. Raw flux scales with loudness,
      // so a quiet attack would score below the numerical jitter of a loud
      // steady tone; the ratio is near zero for anything sustained and large
      // only for a genuine attack, whatever the level.
      novelty[hop] = magnitude > 0 ? flux / magnitude : 0
    }
    // Swap the buffers rather than reallocating each hop.
    const swap = previous ?? new Float32Array(bins)
    previous = current
    current = swap
  }
  return novelty
}

/**
 * Local peaks that stand clear of their surroundings, in seconds.
 *
 * The adaptive threshold alone is not enough: on sustained material the local
 * mean approaches zero and ordinary numerical jitter clears it, so a steady
 * drone reports a stream of imaginary hits. The absolute floor on normalised
 * flux is what makes "nothing is articulating" measurable.
 */
const ONSET_FLOOR = 0.045

function pickOnsets(novelty, hopSeconds) {
  const onsets = []
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    if (novelty[i] < ONSET_FLOOR) continue
    let sum = 0
    let count = 0
    const from = Math.max(0, i - ONSET_NEIGHBOURHOOD)
    const to = Math.min(novelty.length - 1, i + ONSET_NEIGHBOURHOOD)
    for (let j = from; j <= to; j++) {
      sum += novelty[j]
      count++
    }
    const localMean = sum / count
    if (localMean > 0 && novelty[i] > localMean * ONSET_THRESHOLD) onsets.push(i * hopSeconds)
  }
  return onsets
}

/**
 * Tempo from the novelty curve's self-similarity.
 *
 * Autocorrelation peaks at the beat period. Which multiple of the beat wins is
 * arbitrary (a four-on-the-floor kick correlates just as well at the bar), so
 * the result is folded into a musically plausible range at the end.
 */
function estimateTempo(novelty, hopSeconds) {
  if (!novelty || novelty.length < 16) return null
  let mean = 0
  for (const value of novelty) mean += value
  mean /= novelty.length
  const centred = Float32Array.from(novelty, (value) => value - mean)

  const minLag = Math.max(1, Math.round(60 / (MAX_BPM * hopSeconds)))
  const maxLag = Math.min(centred.length - 1, Math.round(60 / (MIN_BPM * hopSeconds)))
  if (maxLag <= minLag) return null

  let bestLag = -1
  let bestScore = 0
  let scoreSum = 0
  let scoreCount = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i] * centred[i + lag]
    const score = sum / (centred.length - lag)
    scoreSum += Math.abs(score)
    scoreCount++
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestLag < 0 || bestScore <= 0) return null

  let bpm = 60 / (bestLag * hopSeconds)
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2

  const averageScore = scoreCount ? scoreSum / scoreCount : 0
  const confidence = averageScore > 0 ? Math.min(1, bestScore / (averageScore * 4)) : 0
  return { bpm, confidence }
}

// --- harmony: chroma and key ----------------------------------------------------

const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/**
 * Krumhansl-Kessler key profiles: how strongly each scale degree is expected to
 * sound in a major and a minor key. Correlating a measured chroma against all
 * 24 rotations is the standard way to name a key from audio.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** Restrict chroma to where pitch actually lives; kicks and hiss only blur it. */
const CHROMA_MIN_HZ = 80
const CHROMA_MAX_HZ = 2000

/** Energy per pitch class, summed over the whole clip. */
function computeChroma(readSample, numFrames, channels, sampleRate) {
  if (numFrames < CHROMA_FFT * 2) return null
  const window = makeHann(CHROMA_FFT)
  const re = new Float32Array(CHROMA_FFT)
  const im = new Float32Array(CHROMA_FFT)
  const bins = CHROMA_FFT / 2
  const binHz = sampleRate / CHROMA_FFT

  // Precompute each bin's pitch class once.
  const binPitchClass = new Int8Array(bins).fill(-1)
  for (let bin = 1; bin < bins; bin++) {
    const hz = bin * binHz
    if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) continue
    const midi = 69 + 12 * Math.log2(hz / 440)
    binPitchClass[bin] = ((Math.round(midi) % 12) + 12) % 12
  }

  const chroma = new Array(12).fill(0)
  const hops = Math.floor((numFrames - CHROMA_FFT) / CHROMA_HOP) + 1
  for (let hop = 0; hop < hops; hop++) {
    const start = hop * CHROMA_HOP
    for (let i = 0; i < CHROMA_FFT; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += readSample(start + i, ch)
      re[i] = (sum / channels) * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let bin = 1; bin < bins; bin++) {
      const pitchClass = binPitchClass[bin]
      if (pitchClass < 0) continue
      chroma[pitchClass] += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0)
  return total > 0 ? chroma.map((value) => value / total) : null
}

function correlate(a, b) {
  const meanA = a.reduce((x, y) => x + y, 0) / a.length
  const meanB = b.reduce((x, y) => x + y, 0) / b.length
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den > 0 ? num / den : 0
}

/** Best-matching key, plus the runner-up so ambiguity is visible. */
function detectKey(chroma) {
  if (!chroma) return null
  const scored = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12])
    scored.push({ name: `${PITCH_NAMES[tonic]} major`, score: correlate(rotated, MAJOR_PROFILE) })
    scored.push({ name: `${PITCH_NAMES[tonic]} minor`, score: correlate(rotated, MINOR_PROFILE) })
  }
  scored.sort((a, b) => b.score - a.score)
  return { best: scored[0], runnerUp: scored[1], chroma }
}

/** Normalise "F minor", "Fm", "f:minor" to one comparable form. */
export function normalizeKeyName(text) {
  if (!text) return null
  const match = String(text)
    .trim()
    .match(/^([A-Ga-g])\s*([b#]?)\s*[:\s-]*\s*(maj|major|min|minor|m)?/i)
  if (!match) return null
  const [, letter, accidental, quality] = match
  const mode = quality && /^m(in)?/i.test(quality) && quality.toLowerCase() !== 'maj' ? 'minor' : 'major'
  return `${letter.toUpperCase()}${accidental === '#' ? '#' : accidental === 'b' ? 'b' : ''} ${mode}`
}

/** Enharmonic spellings so "D#" and "Eb" compare equal. */
const ENHARMONIC = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' }

const PITCH_INDEX = (() => {
  const index = new Map()
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
  names.forEach((name, i) => index.set(name, i))
  flats.forEach((name, i) => index.set(name, i))
  return index
})()

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]

/** The seven pitch classes of a key like "F minor". */
function scaleOf(key) {
  const [note, mode] = key.split(' ')
  const tonic = PITCH_INDEX.get(ENHARMONIC[note] ?? note)
  if (tonic === undefined) return null
  const steps = mode === 'minor' ? MINOR_STEPS : MAJOR_STEPS
  return new Set(steps.map((step) => (tonic + step) % 12))
}

/**
 * Are two key names close enough that the audio cannot tell them apart?
 *
 * Key detection finds the pitch content reliably but not which of its notes is
 * home. A relative major and minor (C major, A minor) are the same seven pitch
 * classes, so nothing spectral can separate them. Neighbours a fifth apart
 * (C major, G major) differ by one note, as do F minor and C minor, and a
 * detector fed a bass note plus its own fifth harmonic routinely prefers the
 * neighbour over the tonic.
 *
 * No threshold can flag one of those without flagging all of them, so the line
 * is drawn well past them: a mismatch is reported only when the note sets
 * genuinely diverge. Crying wolf on a correct track would cost more than
 * missing a subtle error, because a check nobody trusts gets ignored, and the
 * faults this exists to catch are named exactly by scripts/check.mjs anyway.
 */
const KEY_MIN_SHARED_NOTES = 5

function keysMatch(a, b) {
  if (!a || !b) return false
  const canonical = (key) => {
    const [note, mode] = key.split(' ')
    return `${ENHARMONIC[note] ?? note} ${mode}`
  }
  if (canonical(a) === canonical(b)) return true
  const scaleA = scaleOf(a)
  const scaleB = scaleOf(b)
  if (!scaleA || !scaleB) return false
  let shared = 0
  for (const pitchClass of scaleA) if (scaleB.has(pitchClass)) shared++
  return shared >= KEY_MIN_SHARED_NOTES
}

// --- analysis ------------------------------------------------------------------

export function analyzeWavBuffer(buf, expectations = {}) {
  const wav = parseWav(buf)
  const { channels, sampleRate, dataOffset, float32 } = wav
  const bytesPerSample = float32 ? 4 : 2
  const frameBytes = channels * bytesPerSample
  const numFrames = Math.floor(wav.dataSize / frameBytes)
  if (numFrames === 0) throw new Error('No audio data')

  const duration = numFrames / sampleRate
  const winSize = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate))

  const readSample = float32
    ? (frame, ch) => buf.readFloatLE(dataOffset + frame * frameBytes + ch * 4)
    : (frame, ch) => buf.readInt16LE(dataOffset + frame * frameBytes + ch * 2) / 32768

  // Decode pass: per-window loudness (mean channel power, so anti-phase
  // stereo still measures as loud) + stereo correlation + clipping.
  const windows = []
  let clippedSamples = 0
  let acc = { sum2: 0, sumL2: 0, sumR2: 0, sumLR: 0, peak: 0, n: 0 }

  const flushWindow = (startFrame) => {
    if (acc.n === 0) return
    const corrDen = Math.sqrt(acc.sumL2 * acc.sumR2)
    windows.push({
      startFrame,
      sum2: acc.sum2,
      n: acc.n,
      rmsDb: toDb(Math.sqrt(acc.sum2 / acc.n)),
      peak: acc.peak,
      corr: channels === 2 && corrDen > 0 ? acc.sumLR / corrDen : null,
      bands: null,
    })
    acc = { sum2: 0, sumL2: 0, sumR2: 0, sumLR: 0, peak: 0, n: 0 }
  }

  let windowStart = 0
  for (let i = 0; i < numFrames; i++) {
    const l = readSample(i, 0)
    const r = channels === 2 ? readSample(i, 1) : l
    if (float32) {
      if (Math.abs(l) >= 1 || Math.abs(r) >= 1) clippedSamples++
    } else if (l >= 32766.5 / 32768 || l <= -1 || r >= 32766.5 / 32768 || r <= -1) {
      clippedSamples++
    }
    acc.sum2 += channels === 2 ? (l * l + r * r) / 2 : l * l
    acc.sumL2 += l * l
    acc.sumR2 += r * r
    acc.sumLR += l * r
    const amp = Math.max(Math.abs(l), Math.abs(r))
    if (amp > acc.peak) acc.peak = amp
    acc.n++
    if (acc.n >= winSize) {
      flushWindow(windowStart)
      windowStart = i + 1
    }
  }
  flushWindow(windowStart)

  // Spectral pass: consecutive Hann-windowed FFT frames covering each whole
  // analysis window (not just a slice of it), per channel, powers averaged.
  // Bins map to exactly one band by center frequency - no double counting.
  const binHz = sampleRate / FFT_SIZE
  const binBand = new Int8Array(FFT_SIZE / 2)
  binBand.fill(-1)
  for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
    const hz = bin * binHz
    for (let b = 0; b < BANDS.length; b++) {
      if (hz >= BANDS[b].lo && hz < BANDS[b].hi) {
        binBand[bin] = b
        break
      }
    }
  }

  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  for (const w of windows) {
    const wEnd = w.startFrame + w.n
    // Frames start inside the window; the last one may extend past its end
    // (or past EOF, where it slides back) so short tails are still heard.
    const starts = []
    for (let s = w.startFrame; s + FFT_SIZE <= wEnd; s += FFT_SIZE) starts.push(s)
    if (starts.length === 0 && numFrames >= FFT_SIZE) {
      starts.push(Math.min(w.startFrame, numFrames - FFT_SIZE))
    }
    if (starts.length === 0) continue

    const bands = new Array(BANDS.length).fill(0)
    for (const start of starts) {
      for (let ch = 0; ch < channels; ch++) {
        for (let i = 0; i < FFT_SIZE; i++) {
          re[i] = readSample(start + i, ch) * hann[i]
          im[i] = 0
        }
        fft(re, im)
        for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
          const b = binBand[bin]
          if (b >= 0) bands[b] += (re[bin] * re[bin] + im[bin] * im[bin]) / channels
        }
      }
    }
    // Normalize by frame count so windows with more FFT frames don't weigh more
    w.bands = bands.map((v) => v / starts.length)
  }

  // Aggregates over non-silent windows.
  const active = windows.filter((w) => w.rmsDb > SILENCE_DB)
  const rmsDbs = active.map((w) => w.rmsDb).sort((a, b) => a - b)
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null)
  const quietDb = pct(rmsDbs, 0.1)
  const loudDb = pct(rmsDbs, 0.95)
  const loudnessRange = quietDb !== null && loudDb !== null ? loudDb - quietDb : null
  const peak = windows.reduce((m, w) => Math.max(m, w.peak), 0)
  const corrs = active.map((w) => w.corr).filter((c) => c !== null)
  const avgCorr = corrs.length ? corrs.reduce((a, c) => a + c, 0) / corrs.length : null

  // Sample-weighted overall loudness (equal window weighting would let a
  // short loud tail window dominate).
  let activeSum2 = 0
  let activeN = 0
  for (const w of active) {
    activeSum2 += w.sum2
    activeN += w.n
  }
  const overallRmsDb = activeN ? toDb(Math.sqrt(activeSum2 / activeN)) : -Infinity

  const bandTotals = new Array(BANDS.length).fill(0)
  for (const w of active) {
    if (!w.bands) continue
    for (let b = 0; b < BANDS.length; b++) bandTotals[b] += w.bands[b]
  }
  const bandSum = bandTotals.reduce((a, v) => a + v, 0)
  const bandPct = bandTotals.map((v) => (bandSum > 0 ? (100 * v) / bandSum : 0))

  // Spectral tilt: power per Hz per band, in dB relative to the densest band.
  // Percentages hide the highs (low bands hold most raw energy in any mix);
  // density comparisons are how "too dull / too harsh" actually shows up.
  const densities = bandTotals.map((v, i) => v / (BANDS[i].hi - BANDS[i].lo))
  const maxDensity = Math.max(...densities)
  const bandTiltDb = densities.map((d) =>
    d > 0 && maxDensity > 0 ? 10 * Math.log10(d / maxDensity) : -Infinity,
  )

  // Leading/trailing silence.
  let leadSilence = 0
  while (leadSilence < windows.length && windows[leadSilence].rmsDb <= SILENCE_DB) leadSilence++
  let tailSilence = 0
  while (tailSilence < windows.length - leadSilence && windows[windows.length - 1 - tailSilence].rmsDb <= SILENCE_DB) {
    tailSilence++
  }

  // Segments: the arc, coarse enough to read at a glance.
  const numSegments = Math.max(4, Math.min(16, Math.round(duration / 30)))
  const segments = []
  for (let s = 0; s < numSegments; s++) {
    const from = Math.floor((s * windows.length) / numSegments)
    const to = Math.floor(((s + 1) * windows.length) / numSegments)
    const segActive = windows.slice(from, to).filter((w) => w.rmsDb > SILENCE_DB)
    let sum2 = 0
    let n = 0
    const bands = new Array(BANDS.length).fill(0)
    for (const w of segActive) {
      sum2 += w.sum2
      n += w.n
      if (w.bands) for (let b = 0; b < BANDS.length; b++) bands[b] += w.bands[b]
    }
    const segBandSum = bands.reduce((a, v) => a + v, 0)
    segments.push({
      startSec: (from * winSize) / sampleRate,
      endSec: (to * winSize) / sampleRate,
      rmsDb: n ? toDb(Math.sqrt(sum2 / n)) : -Infinity,
      bandPct: bands.map((v) => (segBandSum > 0 ? (100 * v) / segBandSum : 0)),
      silent: segActive.length === 0,
    })
  }

  // Sparkline of the loudness arc.
  const buckets = Math.min(60, windows.length)
  let spark = ''
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor((i * windows.length) / buckets)
    const to = Math.max(from + 1, Math.floor(((i + 1) * windows.length) / buckets))
    let maxDb = -Infinity
    for (let w = from; w < to; w++) maxDb = Math.max(maxDb, windows[w].rmsDb)
    const t = (maxDb - SPARK_FLOOR_DB) / (SPARK_CEIL_DB - SPARK_FLOOR_DB)
    const level = Math.max(0, Math.min(SPARK_CHARS.length - 1, Math.round(t * (SPARK_CHARS.length - 1))))
    spark += SPARK_CHARS[level]
  }

  // Musical content: where the hits land and which notes are sounding.
  const hopSeconds = ONSET_HOP / sampleRate
  const novelty = computeNovelty(readSample, numFrames, channels)
  const onsets = novelty ? pickOnsets(novelty, hopSeconds) : []
  const tempo = estimateTempo(novelty, hopSeconds)
  const key = detectKey(computeChroma(readSample, numFrames, channels, sampleRate))

  // Onsets per second is a blunt but honest rhythm-density measure: near zero
  // means nothing is articulating, however loud the mix is.
  const onsetRate = duration > 0 ? onsets.length / duration : 0

  const expectedKey = normalizeKeyName(expectations.key)
  const detectedKey = key ? normalizeKeyName(key.best.name) : null

  const notes = buildNotes({
    duration,
    peak,
    clippedSamples,
    numSamples: numFrames * channels,
    loudnessRange,
    overallRmsDb,
    bandPct,
    bandTiltDb,
    avgCorr,
    leadSilenceSec: (leadSilence * winSize) / sampleRate,
    tailSilenceSec: (tailSilence * winSize) / sampleRate,
    activeRatio: windows.length ? active.length / windows.length : 0,
    onsetRate,
    onsetCount: onsets.length,
    tempo,
    expectedBpm: expectations.bpm ? Number(expectations.bpm) : null,
    key,
    expectedKey,
    detectedKey,
  })

  return {
    duration,
    sampleRate,
    channels,
    overallRmsDb,
    peakDb: toDb(peak),
    quietDb,
    loudDb,
    loudnessRange,
    clippedSamples,
    avgCorr,
    bandPct,
    bandTiltDb,
    spark,
    segments,
    leadSilenceSec: (leadSilence * winSize) / sampleRate,
    tailSilenceSec: (tailSilence * winSize) / sampleRate,
    onsetCount: onsets.length,
    onsetRate,
    tempo,
    key,
    expectedBpm: expectations.bpm ? Number(expectations.bpm) : null,
    expectedKey,
    notes,
  }
}

function buildNotes(m) {
  const notes = []
  const band = (name) => m.bandPct[BANDS.findIndex((b) => b.name === name)] ?? 0
  const tilt = (name) => m.bandTiltDb[BANDS.findIndex((b) => b.name === name)] ?? -Infinity

  if (m.activeRatio === 0) {
    notes.push('SILENT: no audible content at all - was anything playing?')
    return notes
  }
  if (m.clippedSamples > m.numSamples * 0.0001) {
    notes.push(`clipping: ${m.clippedSamples} samples hit full scale - back the master or the loudest layer off`)
  } else if (m.peak > 0.98) {
    notes.push('peaks touch full scale - one more layer will clip; leave headroom')
  }
  if (m.overallRmsDb < -30) {
    notes.push(`very quiet overall (${fmtDb(m.overallRmsDb)} dB RMS) - raise gains or you lose presence`)
  }
  if (m.loudnessRange !== null) {
    if (m.loudnessRange < 4) {
      notes.push('flat dynamics: quiet and loud sections are nearly the same level - contrast is what makes drops land')
    } else if (m.loudnessRange > 8) {
      notes.push(`healthy dynamics (${m.loudnessRange.toFixed(1)} dB between quiet and loud sections)`)
    }
  }
  if (band('sub') + band('bass') > 65) {
    notes.push('bass-dominated mix - fine on big speakers, muddy on small ones; consider more mid/high content')
  }
  if (band('low-mid') > 35) {
    notes.push('low-mids dominate (150-400Hz) - the classic mud zone; carve space with hpf/lpf')
  }
  if (tilt('high-mid') < -35 && tilt('air') < -40) {
    notes.push('almost no highs - the mix will feel dull or underwater; add hats, brightness, or open a filter')
  } else if (tilt('high-mid') < -28) {
    notes.push('highs are weak - a touch more hat/percussion brightness would open the mix up')
  }
  if (tilt('mid') < -22 && (band('bass') > 30 || band('sub') > 15)) {
    notes.push('hollow middle: melodic content sits far below the bass - raise chords/leads or open their filters')
  }
  if (band('sub') < 2 && band('bass') < 8) {
    notes.push('almost no low end - no physical weight; add bass or kick energy')
  }
  if (m.avgCorr !== null) {
    if (m.avgCorr > 0.985) notes.push('essentially mono - pan, jux, or stereo effects would add width')
    else if (m.avgCorr < 0) notes.push('negative stereo correlation - phase issues, will partially cancel on mono speakers')
  }
  if (m.leadSilenceSec > 3) notes.push(`${m.leadSilenceSec.toFixed(0)}s of silence at the start`)
  if (m.tailSilenceSec > 3) notes.push(`${m.tailSilenceSec.toFixed(0)}s of silence at the end`)

  // --- rhythm ---
  if (m.onsetRate < 0.5) {
    notes.push(
      `almost no rhythmic articulation (${m.onsetRate.toFixed(1)} onsets/sec) - this is drifting texture, not a groove`,
    )
  } else if (m.onsetRate > 24) {
    notes.push(
      `extremely dense (${m.onsetRate.toFixed(0)} onsets/sec) - individual hits will smear into a buzz`,
    )
  }
  // Only claim a tempo disagreement when there is a tempo to disagree with.
  // Autocorrelation returns *something* for noise or drifting texture, and
  // asserting a mismatch off that sends the author chasing a phantom.
  const tempoIsTrustworthy = m.tempo && m.tempo.confidence >= 0.35 && m.onsetCount >= 8
  if (tempoIsTrustworthy && m.expectedBpm) {
    const ratio = m.tempo.bpm / m.expectedBpm
    // A detected half or double tempo is an artefact of which beat multiple
    // correlated best, not a real disagreement worth reporting.
    const isMultiple = [0.5, 1, 2].some((factor) => Math.abs(ratio - factor) < 0.04)
    if (!isMultiple) {
      notes.push(
        `TEMPO MISMATCH: measured ~${m.tempo.bpm.toFixed(0)} BPM but the track intends ${m.expectedBpm} - check setcpm()`,
      )
    }
  }
  if (m.tempo && !tempoIsTrustworthy && m.onsetRate >= 0.5) {
    notes.push('no steady pulse detected - the rhythm reads as unmetered or the timing is too loose to lock onto')
  }

  // --- harmony ---
  // A key claim is only worth contradicting when the audio has a clear tonal
  // centre. Without that guard, noise reports "no clear tonal centre" AND a
  // confident-sounding mismatch against whatever scored highest, which is
  // self-contradictory and worse than saying nothing.
  if (m.key) {
    const margin = m.key.best.score - m.key.runnerUp.score
    const hasTonalCentre = m.key.best.score >= 0.55
    if (!hasTonalCentre) {
      notes.push('no clear tonal centre - the harmony is ambiguous, atonal, or buried under percussion')
    } else if (m.expectedKey && m.detectedKey && !keysMatch(m.detectedKey, m.expectedKey)) {
      notes.push(
        `KEY MISMATCH: the notes sounding belong to ${m.key.best.name}, not the ${m.expectedKey} this track claims - a chord may have voiced to silence, or a layer is transposed wrong`,
      )
    } else if (margin < 0.03) {
      notes.push(
        `key is ambiguous between ${m.key.best.name} and ${m.key.runnerUp.name} - add the defining third or seventh to commit`,
      )
    }
  }
  return notes
}

// --- report ---------------------------------------------------------------------

const fmtTime = (sec) => {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const describeConfidence = (value) =>
  value >= 0.7 ? 'confident' : value >= 0.45 ? 'likely' : value >= 0.25 ? 'weak' : 'very weak'

/**
 * Pitch classes in note order with a level block each. The markers must not be
 * '#' or 'b' or they read as accidentals on the note name beside them.
 */
function formatChroma(chroma) {
  const max = Math.max(...chroma)
  return PITCH_NAMES.map((name, i) => {
    const level = max > 0 ? chroma[i] / max : 0
    const block = level > 0.66 ? '█' : level > 0.33 ? '▓' : level > 0.12 ? '░' : '·'
    return `${name}${block}`
  }).join(' ')
}

export function formatReport(r, label) {
  const lines = []
  lines.push(
    `${label} - ${fmtTime(r.duration)} ${r.channels === 2 ? 'stereo' : 'mono'} ${(r.sampleRate / 1000).toFixed(1)}kHz`,
  )
  lines.push('')
  const range =
    r.loudnessRange !== null
      ? `quiet ${fmtDb(r.quietDb)} → loud ${fmtDb(r.loudDb)} (range ${r.loudnessRange.toFixed(1)} dB)`
      : 'no audible content'
  lines.push(`LOUDNESS  avg ${fmtDb(r.overallRmsDb)} dB RMS · peak ${fmtDb(r.peakDb)} dB · ${range}`)
  if (r.avgCorr !== null) {
    const width = r.avgCorr > 0.985 ? 'mono' : r.avgCorr > 0.7 ? 'narrow' : r.avgCorr >= 0.2 ? 'healthy width' : 'very wide'
    lines.push(`STEREO    correlation ${r.avgCorr.toFixed(2)} (${width})`)
  }
  lines.push(`CLIPPING  ${r.clippedSamples === 0 ? 'none' : `${r.clippedSamples} samples at full scale`}`)

  // What it plays, as opposed to how it sounds.
  const tempoLabel = r.tempo
    ? `~${r.tempo.bpm.toFixed(0)} BPM (${describeConfidence(r.tempo.confidence)})${
        r.expectedBpm ? ` · intends ${r.expectedBpm}` : ''
      }`
    : 'no pulse detected'
  lines.push(`TEMPO     ${tempoLabel} · ${r.onsetRate.toFixed(1)} onsets/sec (${r.onsetCount} hits)`)

  if (r.key) {
    const margin = r.key.best.score - r.key.runnerUp.score
    const certainty = margin < 0.03 ? 'ambiguous' : describeConfidence(r.key.best.score)
    lines.push(
      `KEY       ${r.key.best.name} (${certainty})${
        r.expectedKey ? ` · claims ${r.expectedKey}` : ''
      } · next best ${r.key.runnerUp.name}`,
    )
    lines.push(`CHROMA    ${formatChroma(r.key.chroma)}`)
  }
  lines.push('')
  lines.push('BALANCE   ' + BANDS.map((b, i) => `${b.name} ${r.bandPct[i].toFixed(0)}%`).join(' · '))
  lines.push(
    'TILT      ' +
      BANDS.map((b, i) => `${b.name} ${r.bandTiltDb[i] === -Infinity ? '-inf' : r.bandTiltDb[i].toFixed(0)}`).join(' · ') +
      '  (dB/Hz vs loudest band)',
  )
  lines.push('')
  lines.push(`ARC       |${r.spark}|`)
  lines.push(`          ${fmtTime(0)}${' '.repeat(Math.max(1, r.spark.length - fmtTime(r.duration).length - 4))}${fmtTime(r.duration)}`)
  lines.push('')
  lines.push('SEGMENTS   time        level    sub/bass/lowmid/mid/himid/air')
  for (const s of r.segments) {
    const rangeLabel = `${fmtTime(s.startSec)}-${fmtTime(s.endSec)}`.padEnd(12)
    if (s.silent) {
      lines.push(`  ${rangeLabel}(silence)`)
    } else {
      const mix = s.bandPct.map((p) => p.toFixed(0).padStart(2)).join('/')
      lines.push(`  ${rangeLabel}${fmtDb(s.rmsDb).padStart(6)} dB  ${mix}`)
    }
  }
  if (r.notes.length) {
    lines.push('')
    lines.push('NOTES')
    for (const n of r.notes) lines.push(`  - ${n}`)
  }
  return lines.join('\n')
}

// --- CLI ------------------------------------------------------------------------

function newestRecording() {
  const dir = path.join(process.cwd(), 'recordings')
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (!files.length) throw new Error('No recordings found in recordings/')
  return path.join(dir, files[0].f)
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href

/** Read `--flag value` and `--flag=value` alike. */
function readOption(args, name) {
  const inline = args.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

if (isMain) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const expectations = {
    bpm: readOption(args, 'expect-bpm'),
    key: readOption(args, 'expect-key'),
  }
  // Option values must not be mistaken for the input filename.
  const optionValues = new Set([expectations.bpm, expectations.key].filter(Boolean))
  let file = args.find((a) => !a.startsWith('--') && !optionValues.has(a))
  try {
    if (!file) file = newestRecording()
    const result = analyzeWavBuffer(fs.readFileSync(file), expectations)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatReport(result, path.relative(process.cwd(), file)))
    }
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
