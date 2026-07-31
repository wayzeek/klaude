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

    // YIN step 1: the squared difference function. Computed from lag 1, not
    // minLag - step 2's cumulative mean has to start its running sum at the
    // true beginning of the series or its first few terms are wrong (see
    // below), so the values it sums over have to exist.
    for (let lag = 1; lag <= maxLag; lag++) {
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
    // The recurrence is d'(t) = d(t) / mean(d(1..t)) - YIN's own definition,
    // with the running sum starting at tau=1. It must not start at minLag:
    // doing that forces normalised[minLag] to exactly 1 by construction
    // (d(minLag) * 1 / d(minLag)), regardless of what the signal actually
    // looks like at that lag. Step 3 cannot tell that forced 1 apart from "no
    // dip here", so a true period sitting exactly at minLag - a fundamental at
    // maxHz, the top of the declared range - could never be the first
    // qualifying dip, and its octave below (a real dip, correctly normalised)
    // won every time. Starting the sum at 1 makes normalised[minLag] a real
    // measurement, so that boundary is reachable like any other lag.
    // Written as d(t) * count / running so there is no division inside the
    // loop. `count` must be the number of terms actually accumulated, which is
    // why it is incremented alongside `running` rather than derived from the
    // lag - a count that is off by one shifts every value the YIN_THRESHOLD is
    // compared against.
    let running = 0
    let count = 0
    for (let lag = 1; lag <= maxLag; lag++) {
      running += difference[lag]
      count++
      normalised[lag] = running > 0 ? (difference[lag] * count) / running : 1
    }

    // YIN step 3: the first dip below the absolute threshold, not the global
    // minimum. Taking the global minimum reintroduces the octave error the
    // normalisation just removed. The search starts at minLag itself, now
    // that step 2 gives it a real value instead of a forced 1.
    let bestLag = -1
    for (let lag = minLag; lag < maxLag; lag++) {
      if (normalised[lag] >= YIN_THRESHOLD) continue
      while (lag + 1 <= maxLag && normalised[lag + 1] < normalised[lag]) lag++
      bestLag = lag
      break
    }
    if (bestLag < 0) {
      // Nothing cleared the threshold. Fall back to the global minimum, and let
      // the clarity value carry how weak the evidence is.
      let lowest = Infinity
      for (let lag = minLag; lag <= maxLag; lag++) {
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
  // `lag === minLag` is now a legitimate result (see step 3 above) and has a
  // valid neighbour at `minLag - 1`, since `difference`/`normalised` are
  // computed from lag 1 and minLag is always >= 2. Only `lag < minLag` (never
  // produced by the search, kept as a defensive bound) and `lag >= maxLag`
  // lack a full three-point neighbourhood to interpolate.
  if (lag < minLag || lag >= maxLag) return lag
  const before = values[lag - 1]
  const at = values[lag]
  const after = values[lag + 1]
  const denominator = 2 * (2 * at - before - after)
  if (denominator === 0) return lag
  return lag + (after - before) / denominator
}

/**
 * A binary heap, used only to build `RunningMedian` below. `less(a, b)` is
 * the ordering: a min-heap passes `(a, b) => a < b`, a max-heap `(a, b) => a >
 * b`. Insert and remove-root are both O(log n); nothing here ever needs to
 * remove an arbitrary element, so that is the whole interface.
 */
class Heap {
  constructor(less) {
    this.less = less
    this.items = []
  }

  get size() {
    return this.items.length
  }

  peek() {
    return this.items[0]
  }

  push(value) {
    const items = this.items
    items.push(value)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(items[i], items[parent])) break
      ;[items[i], items[parent]] = [items[parent], items[i]]
      i = parent
    }
  }

  pop() {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length) {
      items[0] = last
      const n = items.length
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = 2 * i + 2
        let best = i
        if (left < n && this.less(items[left], items[best])) best = left
        if (right < n && this.less(items[right], items[best])) best = right
        if (best === i) break
        ;[items[i], items[best]] = [items[best], items[i]]
        i = best
      }
    }
    return top
  }
}

/**
 * Running median over a stream of numbers, in O(log n) per push instead of
 * the O(n log n) a full re-sort costs every time a value arrives.
 *
 * This exists because `segmentNotes` used to re-sort the whole current note's
 * pitch history on every frame to keep a running median as the note's
 * reference pitch, which makes a held note's cost quadratic in its own frame
 * count - measured directly at 78ms/5,000 frames, 314ms/10,000, 1.36s/20,000.
 * A long pad or a slow section makes exactly this shape.
 *
 * `median` matches `sorted[Math.floor(n / 2)]` for the n values pushed so far
 * - the "upper of the two middles" convention the old code used (not an
 * average of the two middles), which is what makes this a drop-in
 * replacement rather than a behaviour change. Standard two-heap streaming
 * median, with the push order chosen to land on that specific convention:
 * `lower` (a max-heap) always ends up with `floor(n/2)` elements and `upper`
 * (a min-heap) with `ceil(n/2)`, so `upper`'s minimum is the
 * `(floor(n/2)+1)`-th smallest value overall - exactly `sorted[floor(n/2)]` -
 * except when `n` is odd and `lower` holds the one extra element, in which
 * case `lower`'s own maximum is that same value.
 */
class RunningMedian {
  constructor() {
    this.lower = new Heap((a, b) => a > b)
    this.upper = new Heap((a, b) => a < b)
  }

  push(value) {
    this.lower.push(value)
    this.upper.push(this.lower.pop())
    if (this.upper.size > this.lower.size) {
      this.lower.push(this.upper.pop())
    }
  }

  get value() {
    return this.lower.size > this.upper.size ? this.lower.peek() : this.upper.peek()
  }
}

/**
 * A pitch track becomes a list of notes.
 *
 * Median-filters the MIDI values first, so one bad frame in the middle of a
 * held note does not split it in two. Then walks the track, starting a new note
 * whenever voicing drops, pitch moves more than the tolerance, or a caller-
 * supplied re-articulation onset falls inside the note (see `onsets` below).
 */
export function segmentNotes(
  track,
  { minFrames = DEFAULT_MIN_FRAMES, semitoneTolerance = DEFAULT_SEMITONE_TOLERANCE, onsets = [] } = {},
) {
  const { frames, hopSeconds } = track
  if (!frames.length) return []
  const smoothed = medianFilter(frames, MEDIAN_WIDTH)

  // Neither "pitch moved" nor "voicing dropped" fires when a note is
  // re-struck at the same pitch with no silence in between - a repeated bass
  // note, which is most of a dance-music bassline. That case has no signal in
  // the pitch track itself; it only shows up as an amplitude attack, which is
  // why callers that care about it (bass.mjs) measure one separately and pass
  // it in here as `onsets` (seconds) rather than this module computing it -
  // segmentNotes only ever sees a pitch track, and the lead transcriber,
  // which calls this with no onsets, gets exactly today's behaviour.
  // Onsets are converted to frame indices once, up front, on the assumption
  // that they share this track's hop (true for every real caller: bass.mjs
  // measures onsets on the same audio at the same hop) - a caller on a
  // different hop still works, just rounds to the nearest frame instead of
  // landing exactly on one.
  const forceSplitAt = new Set()
  for (const seconds of onsets) {
    const index = Math.round((seconds - frames[0].seconds) / hopSeconds)
    if (index >= 0 && index < frames.length) forceSplitAt.add(index)
  }

  const notes = []
  let current = null
  const close = (endIndex) => {
    if (!current) return
    const length = endIndex - current.startIndex
    if (length >= minFrames) {
      notes.push({
        startSec: frames[current.startIndex].seconds,
        endSec: frames[current.startIndex].seconds + length * hopSeconds,
        midi: current.median.value,
        clarity: current.clarity / current.count,
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
    // `i > current.startIndex` keeps an onset landing on a note's own first
    // frame from closing it before it has any content - that would just
    // reopen an identical note one frame later, for free (a dropped
    // zero-length fragment plus a fresh start), so skipping it is a pure
    // efficiency win, not a behaviour difference.
    else if (current && forceSplitAt.has(i) && i > current.startIndex) close(i)
    if (!current) current = { startIndex: i, reference: midi, median: new RunningMedian(), count: 0, clarity: 0 }
    current.median.push(midi)
    current.count++
    current.clarity += frames[i].clarity
    // Track the running median as the reference, so a slow glide eventually
    // becomes a new note rather than one note that drifts a fifth.
    current.reference = current.median.value
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
