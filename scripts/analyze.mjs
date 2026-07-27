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

import { decodeWav } from './lib/decoded-audio.mjs'
import {
  CHROMA_FFT,
  ONSET_HOP,
  PITCH_NAMES,
  computeChroma,
  computeNovelty,
  detectKey,
  estimateTempo,
  fft,
  fmtDb,
  makeHann,
  normalizeKeyName,
  keysMatch,
  pickOnsets,
  toDb,
} from './lib/dsp.mjs'

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

const hann = makeHann(FFT_SIZE)

export { normalizeKeyName } from './lib/dsp.mjs'

// --- analysis ------------------------------------------------------------------

export function analyzeWavBuffer(buf, expectations = {}) {
  const audio = decodeWav(buf)
  const { channels, sampleRate, numFrames, duration, float32, readSample } = audio
  const winSize = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate))

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
