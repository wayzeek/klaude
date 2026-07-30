/**
 * Deterministic WAV fixtures.
 *
 * The analysis code has no test coverage and the only real recordings are
 * gitignored and up to 85 MB, so regression fixtures are generated from this
 * file instead. Nothing here may use Math.random or the clock: the whole point
 * is that the same arguments always produce the same bytes.
 */

const PITCH_INDEX = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 }

export function writeWavBuffer({ sampleRate, channels, float32, samples }) {
  const numFrames = samples[0].length
  const bytesPerSample = float32 ? 4 : 2
  const dataSize = numFrames * channels * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(float32 ? 3 : 1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  buf.writeUInt16LE(channels * bytesPerSample, 32)
  buf.writeUInt16LE(bytesPerSample * 8, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)

  let offset = 44
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < channels; ch++) {
      const value = Math.max(-1, Math.min(1, samples[ch][frame]))
      if (float32) {
        buf.writeFloatLE(value, offset)
        offset += 4
      } else {
        buf.writeInt16LE(Math.round(value * 32767), offset)
        offset += 2
      }
    }
  }
  return buf
}

/** Semitone offsets of a minor and major triad from the tonic. */
const TRIAD = { minor: [0, 3, 7], major: [0, 4, 7] }

/**
 * A clip with a kick on every beat and a sustained triad over it.
 *
 * The kick is a decaying 55 Hz sine with a short click, which gives the onset
 * detector something unambiguous to find. The triad sits in the chroma window
 * (80 Hz to 2 kHz) so key detection has real pitch content to correlate.
 */
export function synthClip({ sampleRate = 44100, seconds, bpm, key, channels = 2 }) {
  const [tonicName, mode] = key.split(' ')
  const tonic = PITCH_INDEX[tonicName]
  if (tonic === undefined) throw new Error(`Unknown tonic: ${tonicName}`)
  const intervals = TRIAD[mode]
  if (!intervals) throw new Error(`Unknown mode: ${mode}`)

  const numFrames = Math.round(seconds * sampleRate)
  const beatFrames = Math.round((60 / bpm) * sampleRate)
  const mono = new Float32Array(numFrames)

  // Sustained triad, rooted two octaves above the kick so it lands inside the
  // chroma band rather than under it.
  for (const semitones of intervals) {
    const midi = 48 + tonic + semitones
    const hz = 440 * Math.pow(2, (midi - 69) / 12)
    for (let i = 0; i < numFrames; i++) {
      mono[i] += 0.12 * Math.sin((2 * Math.PI * hz * i) / sampleRate)
    }
  }

  // Kick on every beat.
  const decayFrames = Math.round(0.12 * sampleRate)
  for (let beatStart = 0; beatStart < numFrames; beatStart += beatFrames) {
    for (let i = 0; i < decayFrames && beatStart + i < numFrames; i++) {
      const envelope = Math.exp(-6 * (i / decayFrames))
      mono[beatStart + i] += 0.6 * envelope * Math.sin((2 * Math.PI * 55 * i) / sampleRate)
    }
  }

  const samples = []
  for (let ch = 0; ch < channels; ch++) samples.push(mono)
  return writeWavBuffer({ sampleRate, channels, float32: false, samples })
}

/** Kick frequency and decay, chosen so onset detection can resolve the hits. */
const RHYTHM_KICK_HZ = 150
const RHYTHM_KICK_DECAY = 0.03
/** How much louder an accented kick is than a plain one. */
const RHYTHM_ACCENT_GAIN = 1.6

/**
 * A rhythm-only clip: one kick per beat, nothing pitched.
 *
 * Deliberately separate from synthClip rather than an option on it, for two
 * measured reasons.
 *
 * The sustained triad makes synthClip unusable for rhythm. Pure sines are not
 * bin-aligned to the 1024-point onset FFT, so their leakage shifts every frame
 * and generates continuous flux. On an 8 second 120 BPM clip the triad alone
 * produces 236 onsets and an 83.35 BPM estimate, which is also what the full
 * clip reports: the kicks contribute nothing to the measurement.
 *
 * And 55 Hz is too low to resolve. Its 18 ms period against a 23 ms window
 * yields roughly two onsets per hit, 31 for 16 kicks. At 150 Hz over a 30 ms
 * decay the detector reports 15, which is correct to within an edge frame.
 *
 * `accentEvery` makes every Nth kick (starting with the first) louder than the
 * rest, so a meter detector has an actual downbeat to find. Without it every
 * beat is bit-identical, which is a meter detector's null case, not a fixture
 * that can prove one works. Default is 0 (no accent, every kick identical) so
 * every existing caller's fixture bytes are unchanged.
 *
 * `offBeatGain` adds a second kick halfway between each beat, at that gain
 * relative to the on-beat kick's 0.6; `offBeatSkipEvery` leaves the off-beat
 * kick out on every Nth beat (0 means never skip, a busy off-beat on every
 * single beat) so the pattern is syncopated rather than a uniform doubled
 * pulse. Both default to off (0), so every existing caller's fixture bytes
 * are unchanged. This is what reproduces a broken-beat tempo error: see
 * `findTempo`'s "syncopated" test in grid.test.mjs.
 */
export function rhythmClip({
  sampleRate = 44100,
  seconds,
  bpm,
  channels = 2,
  accentEvery = 0,
  offBeatGain = 0,
  offBeatSkipEvery = 0,
}) {
  const numFrames = Math.round(seconds * sampleRate)
  const beatFrames = Math.round((60 / bpm) * sampleRate)
  const decayFrames = Math.round(RHYTHM_KICK_DECAY * sampleRate)
  const mono = new Float32Array(numFrames)

  const addKick = (start, gain) => {
    for (let i = 0; i < decayFrames && start + i < numFrames; i++) {
      const envelope = Math.exp(-6 * (i / decayFrames))
      mono[start + i] += gain * envelope * Math.sin((2 * Math.PI * RHYTHM_KICK_HZ * i) / sampleRate)
    }
  }

  let beatIndex = 0
  for (let beatStart = 0; beatStart < numFrames; beatStart += beatFrames, beatIndex++) {
    const accented = accentEvery > 0 && beatIndex % accentEvery === 0
    addKick(beatStart, accented ? 0.6 * RHYTHM_ACCENT_GAIN : 0.6)
    if (offBeatGain > 0) {
      const skip = offBeatSkipEvery > 0 && beatIndex % offBeatSkipEvery === offBeatSkipEvery - 1
      if (!skip) addKick(beatStart + Math.round(beatFrames / 2), offBeatGain)
    }
  }

  const samples = []
  for (let ch = 0; ch < channels; ch++) samples.push(mono)
  return writeWavBuffer({ sampleRate, channels, float32: false, samples })
}
