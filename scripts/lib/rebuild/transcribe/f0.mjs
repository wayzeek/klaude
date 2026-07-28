/**
 * Monophonic pitch tracking, shared by the bass and lead transcribers.
 *
 * The algorithm is YIN's difference function with cumulative mean
 * normalisation. Plain autocorrelation is simpler and wrong for this job: it
 * peaks just as strongly at twice the true period as at the period itself, so
 * it reports the octave below roughly as often as the right note. #42 requires
 * correct octaves, not just pitch classes, so the normalisation step - which
 * exists precisely to penalise those higher-lag peaks - is not optional.
 *
 * The existing chroma primitive cannot be reused for any of this. It collapses
 * octaves into pitch classes and excludes everything below 80 Hz, which is most
 * of a bassline.
 */

/** Absolute clarity a frame needs to count as voiced. Clarity is 1 minus YIN's
 *  normalised difference at the chosen lag, so 0.55 means the waveform repeats
 *  at that period with less than 45% residual. */
const DEFAULT_VOICED_THRESHOLD = 0.55
/** And it needs this much signal. Below it we are tracking the noise floor. */
const DEFAULT_RMS_FLOOR = 0.005
/** YIN's own absolute threshold: the first lag whose normalised difference
 *  falls below this wins, rather than the global minimum. Taking the first
 *  qualifying dip is what prevents the octave-below error. */
const YIN_THRESHOLD = 0.15

/** A note has to hold for this many frames to be a note rather than a wobble. */
const DEFAULT_MIN_FRAMES = 4
/** Pitch has to move this far to count as a new note rather than vibrato. */
const DEFAULT_SEMITONE_TOLERANCE = 0.6
/** Median filter width, in frames, applied to the pitch track before
 *  segmenting. Removes single-frame octave jumps without smearing real note
 *  boundaries, which are several frames wide at any usable hop. */
const MEDIAN_WIDTH = 5

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440)
}

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12)
}

/**
 * F0 per hop.
 *
 * `windowSize` must be at least twice the longest period being searched, or the
 * difference function has no room to see a full cycle. At 44.1 kHz a 30 Hz
 * fundamental has a 1470-sample period, so the bass default is 4096.
 */
export function trackF0(
  audio,
  {
    minHz = 30,
    maxHz = 400,
    windowSize = 4096,
    hop = 512,
    voicedThreshold = DEFAULT_VOICED_THRESHOLD,
    rmsFloor = DEFAULT_RMS_FLOOR,
  } = {},
) {
  const { sampleRate, numFrames, readMono } = audio
  const hopSeconds = hop / sampleRate
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz))
  const maxLag = Math.min(windowSize - 1, Math.ceil(sampleRate / minHz))
  const frames = []
  if (numFrames < windowSize || maxLag <= minLag) return { hopSeconds, frames }

  const buffer = new Float32Array(windowSize)
  const difference = new Float32Array(maxLag + 1)
  const normalised = new Float32Array(maxLag + 1)
  const count = Math.floor((numFrames - windowSize) / hop) + 1

  for (let index = 0; index < count; index++) {
    const start = index * hop
    let power = 0
    for (let i = 0; i < windowSize; i++) {
      buffer[i] = readMono(start + i)
      power += buffer[i] * buffer[i]
    }
    const rms = Math.sqrt(power / windowSize)
    const seconds = start / sampleRate

    if (rms < rmsFloor) {
      frames.push({ seconds, hz: null, midi: null, clarity: 0, rms, voiced: false })
      continue
    }

    // YIN step 1: the squared difference function.
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      const limit = windowSize - lag
      for (let i = 0; i < limit; i++) {
        const delta = buffer[i] - buffer[i + lag]
        sum += delta * delta
      }
      difference[lag] = sum
    }

    // YIN step 2: cumulative mean normalisation. This is the step that kills
    // the octave-below error - a lag at twice the true period has a difference
    // just as low, but by then the running mean has caught up with it.
    //
    // The recurrence is d'(t) = d(t) / mean(d(minLag..t)), written as
    // d(t) * count / running so there is no division inside the loop. `count`
    // must be the number of terms actually accumulated, which is why it is
    // incremented alongside `running` rather than derived from the lag - a
    // count that is off by one makes d'(minLag+1) come out at 2 instead of 1
    // and shifts every value the YIN_THRESHOLD is compared against.
    let running = 0
    let count = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      running += difference[lag]
      count++
      normalised[lag] = running > 0 ? (difference[lag] * count) / running : 1
    }

    // YIN step 3: the first dip below the absolute threshold, not the global
    // minimum. Taking the global minimum reintroduces the octave error the
    // normalisation just removed.
    let bestLag = -1
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (normalised[lag] >= YIN_THRESHOLD) continue
      while (lag + 1 <= maxLag && normalised[lag + 1] < normalised[lag]) lag++
      bestLag = lag
      break
    }
    if (bestLag < 0) {
      // Nothing cleared the threshold. Fall back to the global minimum, and let
      // the clarity value carry how weak the evidence is.
      let lowest = Infinity
      for (let lag = minLag + 1; lag <= maxLag; lag++) {
        if (normalised[lag] < lowest) {
          lowest = normalised[lag]
          bestLag = lag
        }
      }
    }

    // Parabolic interpolation around the chosen lag, so pitch resolution is not
    // limited to whole samples. At 44.1 kHz and 400 Hz, one sample of lag is
    // most of a semitone, which would make every note sharp or flat by chance.
    const refined = interpolate(normalised, bestLag, minLag, maxLag)
    const hz = sampleRate / refined
    const clarity = Math.max(0, Math.min(1, 1 - normalised[bestLag]))
    const voiced = clarity >= voicedThreshold && hz >= minHz && hz <= maxHz

    frames.push({
      seconds,
      hz: voiced ? hz : null,
      midi: voiced ? hzToMidi(hz) : null,
      clarity,
      rms,
      voiced,
    })
  }
  return { hopSeconds, frames }
}

function interpolate(values, lag, minLag, maxLag) {
  if (lag <= minLag || lag >= maxLag) return lag
  const before = values[lag - 1]
  const at = values[lag]
  const after = values[lag + 1]
  const denominator = 2 * (2 * at - before - after)
  if (denominator === 0) return lag
  return lag + (after - before) / denominator
}

/**
 * A pitch track becomes a list of notes.
 *
 * Median-filters the MIDI values first, so one bad frame in the middle of a
 * held note does not split it in two. Then walks the track, starting a new note
 * whenever voicing drops or pitch moves more than the tolerance.
 */
export function segmentNotes(
  track,
  { minFrames = DEFAULT_MIN_FRAMES, semitoneTolerance = DEFAULT_SEMITONE_TOLERANCE } = {},
) {
  const { frames, hopSeconds } = track
  if (!frames.length) return []
  const smoothed = medianFilter(frames, MEDIAN_WIDTH)

  const notes = []
  let current = null
  const close = (endIndex) => {
    if (!current) return
    const length = endIndex - current.startIndex
    if (length >= minFrames) {
      const midis = current.midis.slice().sort((a, b) => a - b)
      notes.push({
        startSec: frames[current.startIndex].seconds,
        endSec: frames[current.startIndex].seconds + length * hopSeconds,
        midi: midis[Math.floor(midis.length / 2)],
        clarity: current.clarity / current.midis.length,
      })
    }
    current = null
  }

  for (let i = 0; i < frames.length; i++) {
    const midi = smoothed[i]
    if (midi === null) {
      close(i)
      continue
    }
    if (current && Math.abs(midi - current.reference) > semitoneTolerance) close(i)
    if (!current) current = { startIndex: i, reference: midi, midis: [], clarity: 0 }
    current.midis.push(midi)
    current.clarity += frames[i].clarity
    // Track the running median as the reference, so a slow glide eventually
    // becomes a new note rather than one note that drifts a fifth.
    const sorted = current.midis.slice().sort((a, b) => a - b)
    current.reference = sorted[Math.floor(sorted.length / 2)]
  }
  close(frames.length)
  return notes
}

function medianFilter(frames, width) {
  const half = Math.floor(width / 2)
  const out = new Array(frames.length).fill(null)
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].voiced) continue
    const window = []
    for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) {
      if (frames[j].voiced) window.push(frames[j].midi)
    }
    if (!window.length) continue
    window.sort((a, b) => a - b)
    out[i] = window[Math.floor(window.length / 2)]
  }
  return out
}
