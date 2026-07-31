import { describe, expect, it } from 'vitest'
import { rhythmClip } from '../__fixtures__/make-wav.mjs'
import { decodeWav } from '../decoded-audio.mjs'
import { ONSET_HOP, computeNovelty } from '../dsp.mjs'
import { LowConfidenceGridError, beatPhase, detectGrid, detectMeter, findTempo, reconcileTempo } from './grid.mjs'
import { MIN_MATCH_CONFIDENCE } from './metadata.mjs'

function decodedOf(bpm, opts = {}) {
  const audio = decodeWav(rhythmClip({ seconds: 16, bpm, ...opts }))
  const hopSeconds = ONSET_HOP / audio.sampleRate
  const novelty = computeNovelty(audio.readSample, audio.numFrames, audio.channels)
  return { audio, novelty, hopSeconds }
}

describe('findTempo', () => {
  // 120 and 128 are the two measured regressions from the ratio-search design
  // this replaced: 120 is the clip on which the old estimateTempo+octave-fold
  // path locked onto a factor-of-three error (83.35 BPM), and 128 is the clip
  // on which the ratio search's per-beat MEAN scoring let a musically
  // meaningless 2/3 ratio (85.07 BPM) outscore the truth. 138/160 are the real
  // recording's tempo and the precision gap the old integer-hop autocorrelation
  // could not close (161.5 instead of 160). 90/100 are the double-time ties the
  // tempo prior below was added to resolve. The rest fill out the range this
  // module has to cover.
  const SWEEP_BPMS = [90, 100, 110, 120, 128, 138, 140, 150, 160, 174]

  for (const bpm of SWEEP_BPMS) {
    it(`recovers ${bpm} BPM within 1 BPM, confidently`, () => {
      const { novelty, hopSeconds } = decodedOf(bpm)
      const tempo = findTempo(novelty, hopSeconds)
      expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1)
      expect(tempo.confidence).toBeGreaterThanOrEqual(0.25)
    })
  }

  it('halts rather than guessing when there is no rhythm to measure', () => {
    const { novelty, hopSeconds } = decodedOf(120)
    novelty.fill(0)
    const tempo = findTempo(novelty, hopSeconds)
    expect(tempo.confidence).toBe(0)
  })

  /**
   * The bug this module shipped with: Bicep's "Glue" (broken beat, true tempo
   * 130 BPM) was detected as 104 BPM at confidence 0.19, below the 0.25 gate.
   * `periodScore` summed onset energy on the beat and subtracted onset energy
   * on the off-beat, on the reasoning that the true tempo's off-beats are
   * empty. That holds on a four-on-the-floor clip - every fixture this module
   * had before this test - and fails on syncopated material, where the
   * off-beats are busy by construction: at Glue's true 130 BPM, off-beat
   * energy measured 88% of on-beat energy, while at the wrong 104 BPM it was
   * only 48%, so the subtraction preferred whichever candidate's off-beats
   * happened to be emptiest rather than the candidate that was correct.
   *
   * `offBeatSkipEvery: 4` makes the off-beat kick busy on 3 of every 4 beats
   * (skipped on the 4th) rather than every single beat, so the pattern is
   * genuinely syncopated rather than a uniform doubled pulse a tracker could
   * dismiss as "really double time". At 32 seconds and 130 BPM this fixture
   * reproduces the exact wrong answer (104 BPM) against the code before this
   * fix, and is proven by mutation: reverting `periodScore` to subtract
   * off-beat energy again makes this test fail.
   */
  it('recovers the true tempo on a syncopated (broken-beat) pattern, not the tempo whose off-beats look emptiest', () => {
    const bpm = 130
    const { novelty, hopSeconds } = decodedOf(bpm, { seconds: 32, offBeatGain: 0.6, offBeatSkipEvery: 4 })
    const tempo = findTempo(novelty, hopSeconds)
    expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1)
    expect(tempo.confidence).toBeGreaterThanOrEqual(0.25)
  })

  /**
   * The confidence gate must still reject a genuine guess after the fix
   * above. Removing the off-beat subtraction makes `periodScore` a plain sum
   * of onset energy at candidate beat positions, and incoherent noise still
   * has real energy at every hop - the risk is that the gate stops meaning
   * anything once nothing is subtracted. This is a stronger case than pure
   * silence (already covered above): the curve is never zero, so the low
   * score has to come from no candidate period explaining it any better than
   * its neighbours, not from an empty sum. The generator is the same seeded
   * LCG used elsewhere in this codebase's fixtures (see bands.test.mjs),
   * not Math.random, so the test is deterministic.
   */
  it('still refuses to guess a tempo from incoherent noise with no periodicity', () => {
    const { hopSeconds } = decodedOf(120)
    let seed = 424242
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const novelty = new Float32Array(20000)
    for (let i = 0; i < novelty.length; i++) novelty[i] = rand() * 0.1
    const tempo = findTempo(novelty, hopSeconds)
    expect(tempo.confidence).toBeLessThan(0.25)
  })

  /**
   * The bug the syncopation fix above reopened: on a plain, unsyncopated
   * clip, on-beat sum alone cannot tell a slow tempo from its own double,
   * because a candidate at twice the true tempo places a beat on every real
   * hit plus one on every true silence, and the silences contribute nothing -
   * both candidates' sums tie exactly. Measured directly: at 70 BPM (this
   * test), the true candidate and its double, 140 BPM, both score 15.673 on
   * raw on-beat sum. A tie leaves the tempo prior (centred on 120 BPM) to
   * decide, and for a genuinely slow track it decides wrongly - prior(140) =
   * 0.894 against prior(70) = 0.254. Against the code with the syncopation
   * fix but no octave correction, this test fails with `tempo.bpm` at 140,
   * not 70.
   *
   * This is not hypothetical: DOOM's "Funeral for the Damned" is 67 BPM, and
   * against that same code it read as 134 BPM at confidence 0.68 - a wrong
   * answer confident enough to clear the gate and build a bar grid twice too
   * fast. The bar itself, not just the number, would have been wrong: every
   * downstream quantisation step inherits a beat grid at the wrong rate.
   *
   * This assertion is on `tempo.bpm` alone, not confidence: on this
   * particular fixture - a bare click with no accent and nothing else in the
   * signal, closer to a worst case than anything real music produces -
   * `tempo.confidence` comes out at 0 even after the fix, correctly halting
   * the pipeline rather than shipping a guess (see `detectGrid`'s
   * `LowConfidenceGridError`). What this test proves is narrower and more
   * important: whatever tempo the pipeline does or doesn't commit to, it is
   * no longer confusable with the wrong octave.
   */
  it('does not confuse a slow tempo with its own double on a plain, unaccented clip', () => {
    const bpm = 70
    const { novelty, hopSeconds } = decodedOf(bpm)
    const tempo = findTempo(novelty, hopSeconds)
    expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1)
  })

  /**
   * Two points the octave-halving fix does not reach: at 193 and 197 BPM -
   * both unusual tempos, not anywhere a real track is likely to sit - the
   * winner is wrong (96.5 and 98.5, roughly half) and only marginally over
   * the old 0.25 gate (0.2555 and 0.2517). `findTempo` on its own has no
   * fix for this - it is `detectGrid`'s `MIN_TEMPO_CONFIDENCE` (0.26) that
   * catches it, so this test calls `findTempo` directly to pin the exact
   * confidence values the gate has to clear, and `detectGrid`'s own test
   * below proves the gate itself stops the run.
   */
  it('is only marginally confident on the two BPMs a 0.25 gate would have let through wrong', () => {
    for (const bpm of [193, 197]) {
      const { novelty, hopSeconds } = decodedOf(bpm)
      const tempo = findTempo(novelty, hopSeconds)
      expect(Math.abs(tempo.bpm - bpm)).toBeGreaterThan(1)
      expect(tempo.confidence).toBeLessThan(0.26)
      expect(tempo.confidence).toBeGreaterThanOrEqual(0.25)
    }
  })
})

describe('beatPhase', () => {
  it('places beat one on a kick, not between kicks', () => {
    const bpm = 120
    const { novelty, hopSeconds } = decodedOf(bpm)
    const beatSeconds = 60 / bpm
    const beatHops = beatSeconds / hopSeconds
    const phase = beatPhase(novelty, beatHops)
    const phaseSeconds = phase.offsetHops * hopSeconds
    // The generator puts a kick at frame 0, so the phase should be near a
    // whole beat, not near a half beat.
    const offBeat = Math.abs((phaseSeconds % beatSeconds) - beatSeconds / 2)
    expect(offBeat).toBeGreaterThan(beatSeconds * 0.25)
  })
})

describe('detectMeter', () => {
  /**
   * Measured contrast, mirroring how the flux-based approach's blindness was
   * proven: the same clip, only `accentEvery` changed. Unaccented, every beat
   * is bit-identical, so low-band energy at each bar position should be
   * indistinguishable and confidence should sit near zero. Accented, the
   * downbeat genuinely carries more low-end energy (raw FFT magnitude scales
   * with amplitude, unlike normalised flux), so confidence should be
   * meaningfully higher. This is the demonstration that the representation
   * detectMeter is built on can actually carry an accent, where flux could not.
   */
  it('is confident about a downbeat only when the audio actually has one', () => {
    const bpm = 120
    const beatSeconds = 60 / bpm

    const plain = decodedOf(bpm)
    const plainPhase = beatPhase(plain.novelty, beatSeconds / plain.hopSeconds)
    const plainMeter = detectMeter(plain.audio, beatSeconds, plainPhase.offsetHops * plain.hopSeconds)

    const accented = decodedOf(bpm, { accentEvery: 4 })
    const accentedPhase = beatPhase(accented.novelty, beatSeconds / accented.hopSeconds)
    const accentedMeter = detectMeter(accented.audio, beatSeconds, accentedPhase.offsetHops * accented.hopSeconds)

    expect(plainMeter.confidence).toBeLessThan(0.2)
    expect(accentedMeter.confidence).toBeGreaterThan(0.25)
    expect(accentedMeter.confidence).toBeGreaterThan(plainMeter.confidence * 2)
  })

  it('finds the correct meter and downbeat position on an accented fixture', () => {
    const bpm = 120
    const accentEvery = 4
    const { audio, novelty, hopSeconds } = decodedOf(bpm, { accentEvery })
    const beatSeconds = 60 / bpm
    const phase = beatPhase(novelty, beatSeconds / hopSeconds)
    const phaseSeconds = phase.offsetHops * hopSeconds
    const meter = detectMeter(audio, beatSeconds, phaseSeconds)
    expect(meter.beatsPerBar).toBe(accentEvery)

    // Ground truth, independent of the module's own phase estimate: accented
    // kicks land at absolute times n * accentEvery * beatSeconds. The detected
    // downbeat should be near one of them, regardless of which one.
    const downbeatSeconds = phaseSeconds + meter.downbeatOffset * beatSeconds
    const barSeconds = beatSeconds * accentEvery
    const offsetIntoBar = ((downbeatSeconds % barSeconds) + barSeconds) % barSeconds
    const distanceToNearestAccent = Math.min(offsetIntoBar, barSeconds - offsetIntoBar)
    expect(distanceToNearestAccent).toBeLessThan(beatSeconds * 0.5)
  })

  /**
   * The branch a `BEATS_PER_BAR_PRIOR` favouring 4 would have suppressed, and
   * the reason it was removed rather than kept at an unvalidated weight.
   * Measured directly before removal: on this fixture the raw margin between
   * `contrastAt(beats, 3)` and `contrastAt(beats, 4)` was 0.41-0.50 across the
   * full BPM sweep - as decisive as this module's measurements get - yet a
   * prior discount of 0.4 pushed the correct answer's confidence from ~0.50
   * down to ~0.20, under the 0.25 gate. A weight that cannot help on any real
   * recording this module has been checked against (see `detectMeter`'s own
   * comment) and demonstrably suppresses a decisive correct answer on the one
   * synthetic case built to test it is worse than no weight.
   */
  it('reaches beatsPerBar 3 on a genuine three-beat fixture, and still reaches 4 on a four-beat one', () => {
    const bpm = 120
    const beatSeconds = 60 / bpm

    const three = decodedOf(bpm, { accentEvery: 3 })
    const threePhase = beatPhase(three.novelty, beatSeconds / three.hopSeconds)
    const threeMeter = detectMeter(three.audio, beatSeconds, threePhase.offsetHops * three.hopSeconds)
    expect(threeMeter.beatsPerBar).toBe(3)
    expect(threeMeter.confidence).toBeGreaterThanOrEqual(0.25)

    const four = decodedOf(bpm, { accentEvery: 4 })
    const fourPhase = beatPhase(four.novelty, beatSeconds / four.hopSeconds)
    const fourMeter = detectMeter(four.audio, beatSeconds, fourPhase.offsetHops * four.hopSeconds)
    expect(fourMeter.beatsPerBar).toBe(4)
    expect(fourMeter.confidence).toBeGreaterThanOrEqual(0.25)
  })
})

describe('detectGrid', () => {
  it('exposes a bar clock built from tempo, phase and meter', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(grid.beatsPerBar).toBe(4)
    expect(grid.barSeconds).toBeCloseTo(grid.beatSeconds * 4, 3)
    expect(grid.beatAt(4) - grid.beatAt(0)).toBeCloseTo(grid.barSeconds, 3)
    expect(grid.barAt(1) - grid.barAt(0)).toBeCloseTo(grid.barSeconds, 3)
  })

  it('starts both clocks on a downbeat, not on an arbitrary beat of the bar', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(grid.downbeatSeconds).toBeCloseTo(grid.phaseSeconds + grid.downbeatOffset * grid.beatSeconds, 6)
    expect(grid.beatAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.barAt(0)).toBeCloseTo(grid.downbeatSeconds, 6)
    expect(grid.downbeatOffset).toBeGreaterThanOrEqual(0)
    expect(grid.downbeatOffset).toBeLessThan(grid.beatsPerBar)
  })

  it('converts a duration to bars', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(grid.secondsToBars(grid.barSeconds * 8)).toBeCloseTo(8, 3)
  })

  it('reports a confidence for each of the three measurements', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    for (const field of ['tempo', 'phase', 'meter']) {
      expect(grid.confidence[field], field).toBeGreaterThanOrEqual(0)
      expect(grid.confidence[field], field).toBeLessThanOrEqual(1)
    }
  })

  // Same ten BPMs as the findTempo sweep, now through the full pipeline
  // including meter - which round 2 could not clear at 90 BPM (0.231, just
  // under the gate) until this round's spread-based contrast and the fix to
  // a boundary artifact (a zero-padded final beat manufacturing a spurious
  // bar-length signal on clips whose beat count divided evenly by 4) gave it
  // enough margin (0.522).
  for (const bpm of [90, 100, 110, 120, 128, 138, 140, 150, 160, 174]) {
    it(`clears every gate end to end at ${bpm} BPM on a four-beat accented fixture`, () => {
      const grid = detectGrid(rhythmClip({ seconds: 16, bpm, accentEvery: 4 }))
      expect(grid.bpm).toBeCloseTo(bpm, 0)
      expect(grid.beatsPerBar).toBe(4)
      const barSeconds = grid.beatSeconds * 4
      const offsetIntoBar = ((grid.downbeatSeconds % barSeconds) + barSeconds) % barSeconds
      const distanceToNearestAccent = Math.min(offsetIntoBar, barSeconds - offsetIntoBar)
      expect(distanceToNearestAccent).toBeLessThan(grid.beatSeconds * 0.5)
    })
  }

  // Mirrors the four-beat sweep above on a genuinely three-beat fixture - the
  // coverage gap a code reviewer found: nothing in this suite had ever
  // exercised beatsPerBar 3 winning. Every one of these was the exact case
  // that exposed the boundary artifact above at 90 BPM specifically (a
  // zero-padded last beat wrongly flipped 3 to 4 there before the fix).
  for (const bpm of [90, 100, 110, 120, 128, 138, 140, 150, 160, 174]) {
    it(`reaches beatsPerBar 3 end to end at ${bpm} BPM on a three-beat accented fixture`, () => {
      const grid = detectGrid(rhythmClip({ seconds: 16, bpm, accentEvery: 3 }))
      expect(grid.bpm).toBeCloseTo(bpm, 0)
      expect(grid.beatsPerBar).toBe(3)
      const barSeconds = grid.beatSeconds * 3
      const offsetIntoBar = ((grid.downbeatSeconds % barSeconds) + barSeconds) % barSeconds
      const distanceToNearestAccent = Math.min(offsetIntoBar, barSeconds - offsetIntoBar)
      expect(distanceToNearestAccent).toBeLessThan(grid.beatSeconds * 0.5)
    })
  }

  it('refuses to call a meter when the beat carries no real accent', () => {
    // Same clip, no accent: every beat is bit-identical, so there is nothing
    // for the low-band measurement to find either, and detectGrid must still
    // refuse rather than pick an arbitrary downbeat.
    expect(() => detectGrid(rhythmClip({ seconds: 16, bpm: 120 }))).toThrow(LowConfidenceGridError)
  })

  /**
   * The end-to-end proof for `MIN_TEMPO_CONFIDENCE`: at 193 BPM, `findTempo`
   * alone would have returned the wrong tempo (96.5, see the findTempo test
   * above) at confidence 0.2555 - over the general 0.25 gate, meaning
   * `detectGrid` would have built a bar grid at roughly half the true rate
   * and every quantised note downstream would have inherited that error.
   * The tempo-specific 0.26 floor stops it here instead, on the same
   * fixture, before phase or meter are even measured.
   */
  it('refuses a tempo that is only marginally over the general gate but still wrong', () => {
    expect(() => detectGrid(rhythmClip({ seconds: 16, bpm: 193, accentEvery: 4 }))).toThrow(LowConfidenceGridError)
  })

  it('halts rather than guessing when there is no rhythm to measure', () => {
    // A sustained triad with no kick has nothing for the beat tracker.
    const silent = rhythmClip({ seconds: 16, bpm: 120 })
    // Zero out the whole data chunk: pure silence, no onsets at all.
    silent.fill(0, 44)
    expect(() => detectGrid(silent)).toThrow(LowConfidenceGridError)
  })

  it('names which measurement failed, so the message can be useful', () => {
    const silent = rhythmClip({ seconds: 16, bpm: 120 })
    silent.fill(0, 44)
    try {
      detectGrid(silent)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LowConfidenceGridError)
      expect(['tempo', 'phase', 'meter']).toContain(error.field)
    }
  })
})

describe('reconcileTempo', () => {
  const GATE = 0.26

  it('passes the detector through unchanged when there is no known tempo', () => {
    const result = reconcileTempo(120, 0.5, null, GATE)
    expect(result).toEqual({ bpm: 120, confidence: 0.5, agreement: 'none' })
  })

  it('treats a known tempo below MIN_MATCH_CONFIDENCE as no known tempo at all', () => {
    // Confidence 0.3 means the search itself was not confident it found the
    // right song - trusting its tempo would risk building the grid on a
    // completely different track's number, which is worse than no prior.
    const result = reconcileTempo(120, 0.1, { bpm: 200, matchConfidence: 0.3 }, GATE)
    expect(result.agreement).toBe('none')
    expect(result.bpm).toBe(120)
  })

  it('treats a known tempo with a missing matchConfidence as untrusted, never as maximally trusted', () => {
    // `?? 1` used to mean "no confidence reported? assume a perfect match" -
    // measured directly against this exact shape: a cached bpm of 200 with
    // no matchConfidence field elevated to confidence 1.0 and beat a
    // detected 104. It must instead be treated as no known tempo at all.
    const result = reconcileTempo(104, 0.19, { bpm: 200 }, GATE)
    expect(result.agreement).toBe('none')
    expect(result.bpm).toBe(104)
  })

  it('treats a known tempo with a non-finite matchConfidence as untrusted, not as clearing the gate by comparing false', () => {
    const result = reconcileTempo(104, 0.19, { bpm: 200, matchConfidence: NaN }, GATE)
    expect(result.agreement).toBe('none')
    expect(result.bpm).toBe(104)
  })

  it('treats a known tempo with an out-of-range but finite matchConfidence as untrusted, never producing an out-of-range confidence', () => {
    // Unlike reconcileKey, the "known, detector unsure" branch below has no
    // later clamp - a raw finite-but-invalid matchConfidence (e.g. 5) would
    // otherwise flow straight into `0.5 + 0.5 * matchConfidence` and produce
    // a confidence outside [0, 1].
    const result = reconcileTempo(104, 0.19, { bpm: 200, matchConfidence: 5 }, GATE)
    expect(result.agreement).toBe('none')
    expect(result.bpm).toBe(104)
    expect(result.confidence).toBeLessThanOrEqual(1)
  })

  it('case 1: agrees within tolerance and raises confidence even over a low raw score', () => {
    // The detector's own confidence (0.05) is a guess; it happens to be
    // right, and agreement with the known tempo is what proves that, not
    // the raw score - so confidence is raised well above the detector's own.
    const result = reconcileTempo(130, 0.05, { bpm: 130.2, matchConfidence: 0.9, source: 'deezer' }, GATE)
    expect(result.agreement).toBe('agree')
    expect(result.bpm).toBe(130.2)
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('case 2: known tempo trusted outright when the detector is unsure and wrong', () => {
    // Mirrors the real failure this module exists to fix: the detector
    // returns a different number (104) at a confidence below its own gate.
    // Pinned to the exact formula (0.5 + 0.5 * matchConfidence), not just
    // ">= GATE": a loose bound like that cannot tell this formula apart from
    // a broken one that just returns `gate` - see reconcileTempo's own
    // comment on this branch for why `gate` can never actually win here.
    const result = reconcileTempo(104, 0.19, { bpm: 130, matchConfidence: 1, source: 'deezer' }, GATE)
    expect(result.agreement).toBe('known')
    expect(result.bpm).toBe(130)
    expect(result.confidence).toBe(1)
  })

  it('case 2: pins the low end of the formula at matchConfidence right on MIN_MATCH_CONFIDENCE', () => {
    // The lowest `known.matchConfidence` that can reach this branch at all -
    // anything below MIN_MATCH_CONFIDENCE is treated as no known tempo (see
    // the "below MIN_MATCH_CONFIDENCE" case above), so 0.5 + 0.5 * 0.6 = 0.8
    // is the floor of what this branch can ever return, always above `gate`.
    const result = reconcileTempo(104, 0.19, { bpm: 130, matchConfidence: MIN_MATCH_CONFIDENCE, source: 'deezer' }, GATE)
    expect(result.agreement).toBe('known')
    expect(result.confidence).toBe(0.8)
  })

  it('case 2: does not let a caller-supplied gate inflate confidence past what the match quality earned', () => {
    // The two tests above both use `GATE` (0.26), which is below every value
    // this branch's formula can ever produce (floor 0.8) - so on its own,
    // neither one can tell this formula apart from the pre-fix
    // `Math.max(gate, 0.5 + 0.5 * matchConfidence)`, since gate never wins at
    // that value either way (verified: reintroducing that exact `Math.max`
    // leaves both those tests passing unchanged). A `gate` above the
    // formula's floor is what actually distinguishes them - unrealistic for
    // today's one real caller (see reconcileTempo's own comment on this
    // branch) but not excluded by this exported, independently unit-tested
    // function's own contract, and this is the case that would have caught a
    // silent regression back to inflating confidence with `Math.max`. That
    // inflation would itself be a form of the exact "confidence laundering"
    // this file was built to stop (see metadata.mjs) - letting a match-
    // quality-derived number quietly clear a threshold it did not actually
    // earn - so returning the plain formula here, un-inflated, is the
    // correct behaviour, not just today's dead-code cleanup.
    const result = reconcileTempo(104, 0.19, { bpm: 130, matchConfidence: MIN_MATCH_CONFIDENCE, source: 'deezer' }, 0.95)
    expect(result.agreement).toBe('known')
    expect(result.confidence).toBe(0.8)
  })

  it('case 3: flags a material disagreement instead of silently choosing either side', () => {
    const result = reconcileTempo(120, 0.6, { bpm: 90, matchConfidence: 0.9, source: 'deezer' }, GATE)
    expect(result.agreement).toBe('disagreement')
    expect(result.detectedBpm).toBe(120)
    expect(result.knownBpm).toBe(90)
  })

  it('is tolerant of small measurement noise (Glue: detector 130, Deezer 130.01)', () => {
    const result = reconcileTempo(130, 0.473, { bpm: 130.01, matchConfidence: 0.9, source: 'deezer' }, GATE)
    expect(result.agreement).toBe('agree')
  })
})

describe('detectGrid with a known tempo', () => {
  it('case 1 end to end: agreement raises confidence and keeps the (matching) bpm', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 130, accentEvery: 4 }), {
      knownTempo: { bpm: 130.2, matchConfidence: 0.9, source: 'test' },
    })
    expect(grid.tempoAgreement).toBe('agree')
    expect(grid.bpm).toBeCloseTo(130.2, 5)
    expect(grid.confidence.tempo).toBeGreaterThan(0.8)
  })

  /**
   * Real, measured case (not a hand-picked confidence): on this fixture's
   * own accented click at 82 BPM, `findTempo` alone returns the WRONG octave
   * (164 BPM) at confidence 0.173 - comfortably under the 0.26 gate. Without
   * a known tempo this fixture would halt the run (a correct, safe outcome).
   * With one, `detectGrid` must recover the true 82 BPM instead of building
   * the whole bar grid at double rate.
   */
  it('case 2 end to end: recovers when the detector is unsure and wrong', () => {
    const grid = detectGrid(rhythmClip({ seconds: 16, bpm: 82, accentEvery: 4 }), {
      knownTempo: { bpm: 82, matchConfidence: 0.9, source: 'test' },
    })
    expect(grid.tempoAgreement).toBe('known')
    expect(grid.bpm).toBe(82)
  })

  it('case 3 end to end: halts on a material disagreement rather than picking a side', () => {
    // 120 BPM is confidently and correctly detected on its own (see the
    // sweep above); a known tempo of 90 is far outside tolerance.
    expect(() =>
      detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }), {
        knownTempo: { bpm: 90, matchConfidence: 0.9, source: 'test' },
      }),
    ).toThrow(LowConfidenceGridError)
  })

  it('a disagreement message names both numbers, not just "not confident enough"', () => {
    try {
      detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }), {
        knownTempo: { bpm: 90, matchConfidence: 0.9, source: 'test' },
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LowConfidenceGridError)
      expect(error.grid.tempoAgreement).toBe('disagreement')
      expect(error.message).toContain('90')
      expect(error.message).toMatch(/12\d/)
    }
  })

  it('a known tempo that is too weak a match is ignored, same as no known tempo at all', () => {
    // matchConfidence 0.3 is under MIN_MATCH_CONFIDENCE - this must behave
    // exactly like the no-knownTempo sweep above, not like case 1 or 2.
    const withWeakMatch = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }), {
      knownTempo: { bpm: 200, matchConfidence: 0.3, source: 'test' },
    })
    const withoutKnownTempo = detectGrid(rhythmClip({ seconds: 16, bpm: 120, accentEvery: 4 }))
    expect(withWeakMatch.bpm).toBe(withoutKnownTempo.bpm)
    expect(withWeakMatch.tempoAgreement).toBe('none')
  })
})
