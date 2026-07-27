/**
 * WAV decoding and sample access.
 *
 * Lifted out of analyze.mjs so the rebuild pipeline can reuse it. The parsing
 * is unchanged: same accepted encodings, same error messages, same behaviour
 * on a truncated data chunk.
 */

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

/**
 * Decode a WAV buffer into something the DSP can read samples from.
 *
 * `readSample` is a closure rather than a copied Float32Array because a full
 * decode of a five minute stereo file is ~50 MB per stem, and the pipeline
 * holds several stems at once.
 */
export function decodeWav(buf) {
  const wav = parseWav(buf)
  const { channels, sampleRate, dataOffset, float32 } = wav
  const bytesPerSample = float32 ? 4 : 2
  const frameBytes = channels * bytesPerSample
  const numFrames = Math.floor(wav.dataSize / frameBytes)
  if (numFrames === 0) throw new Error('No audio data')

  const readSample = float32
    ? (frame, ch) => buf.readFloatLE(dataOffset + frame * frameBytes + ch * 4)
    : (frame, ch) => buf.readInt16LE(dataOffset + frame * frameBytes + ch * 2) / 32768

  const readMono =
    channels === 1
      ? (frame) => readSample(frame, 0)
      : (frame) => (readSample(frame, 0) + readSample(frame, 1)) / 2

  return {
    channels,
    sampleRate,
    numFrames,
    duration: numFrames / sampleRate,
    float32,
    readSample,
    readMono,
  }
}
