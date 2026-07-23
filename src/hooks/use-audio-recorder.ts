/**
 * =============================================================================
 * USE AUDIO RECORDER HOOK
 * =============================================================================
 *
 * Records Strudel's audio output to WAV format.
 * Recording is independent from playback - start/stop whenever you want.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { encodeWAV, downloadBlob, generateRecordingFilename } from '@/lib/wav-encoder'

type AudioRecorderState = {
  isRecording: boolean
  duration: number
  error: string | null
  recordedBlob: Blob | null
  recordedUrl: string | null
}

/**
 * Hook for recording Strudel audio to WAV.
 */
export function useAudioRecorder() {
  const [state, setState] = useState<AudioRecorderState>({
    isRecording: false,
    duration: 0,
    error: null,
    recordedBlob: null,
    recordedUrl: null,
  })

  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef<number>(0)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Float32Array[][]>([[], []]) // [left, right]
  const sampleRateRef = useRef<number>(44100)
  const destinationGainRef = useRef<GainNode | null>(null)
  const recordedUrlRef = useRef<string | null>(null)

  /**
   * Remove the capture processor and restore Strudel's direct audio path.
   * Every exit from a recording (stop, failed start, unmount) must run this,
   * or the destination gain can stay wired to a dead processor - muting
   * everything.
   */
  const restoreRouting = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.onaudioprocess = null
        processorRef.current.disconnect()
      } catch {}
      processorRef.current = null
    }
    if (destinationGainRef.current) {
      const getAudioContextFn = (window as any).getAudioContext
      const audioContext = getAudioContextFn?.() as AudioContext | undefined
      try {
        destinationGainRef.current.disconnect()
      } catch {}
      if (audioContext) {
        try {
          destinationGainRef.current.connect(audioContext.destination)
        } catch (e) {
          console.error('Error restoring audio routing:', e)
        }
      }
      destinationGainRef.current = null
    }
  }, [])

  /**
   * Start recording. Returns { ok, error } so remote (API-driven) recording
   * can acknowledge success or failure to the server.
   */
  const startRecording = useCallback(async (): Promise<{ ok: boolean; error: string | null }> => {
    if (state.isRecording) return { ok: true, error: null }

    const fail = (error: string) => {
      setState(prev => ({ ...prev, error }))
      return { ok: false, error }
    }

    // Dismiss any previous recording using ref (avoids stale closure)
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current)
      recordedUrlRef.current = null
    }

    setState({ isRecording: false, duration: 0, error: null, recordedBlob: null, recordedUrl: null })

    // Get AudioContext from Strudel
    const getAudioContextFn = (window as any).getAudioContext
    if (typeof getAudioContextFn !== 'function') {
      return fail('Start playback first')
    }

    const audioContext = getAudioContextFn() as AudioContext
    if (!audioContext) {
      return fail('No audio context')
    }

    sampleRateRef.current = audioContext.sampleRate

    // Get the audio controller
    const getController = (window as any).getSuperdoughAudioController
    if (typeof getController !== 'function') {
      return fail('Audio controller not found')
    }

    const controller = getController()
    if (!controller?.output?.destinationGain) {
      return fail('destinationGain not found')
    }

    const destinationGain = controller.output.destinationGain as GainNode
    destinationGainRef.current = destinationGain

    // Reset audio chunks
    chunksRef.current = [[], []]

    // Create ScriptProcessorNode to capture raw PCM data
    const bufferSize = 4096
    const processor = audioContext.createScriptProcessor(bufferSize, 2, 2)

    processor.onaudioprocess = (e) => {
      const left = new Float32Array(e.inputBuffer.getChannelData(0))
      const right = new Float32Array(e.inputBuffer.getChannelData(1))
      chunksRef.current[0].push(left)
      chunksRef.current[1].push(right)

      // Pass through to output
      e.outputBuffer.getChannelData(0).set(left)
      e.outputBuffer.getChannelData(1).set(right)
    }

    // Insert processor in the audio chain
    processorRef.current = processor
    try {
      destinationGain.disconnect()
      destinationGain.connect(processor)
      processor.connect(audioContext.destination)
    } catch (e) {
      console.error('Failed to connect recording chain:', e)
      // Tear down the half-built chain so a failed insert can't silence everything
      restoreRouting()
      return fail('Failed to connect')
    }

    // Start timer
    setState({ isRecording: true, duration: 0, error: null, recordedBlob: null, recordedUrl: null })
    startTimeRef.current = Date.now()

    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
      setState(prev => ({ ...prev, duration: elapsed }))
    }, 500)

    console.log('Recording started')
    return { ok: true, error: null }
  }, [state.isRecording])

  /**
   * Stop recording. Returns the encoded WAV blob (also kept in state for the
   * preview toast), or null if nothing was captured.
   */
  const stopRecording = useCallback((): Blob | null => {
    if (!state.isRecording) return null

    // Stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // Disconnect the processor and restore the direct audio path
    restoreRouting()

    // Merge chunks and encode WAV
    const mergeChunks = (chunks: Float32Array[]): Float32Array => {
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
      const result = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      return result
    }

    const leftChannel = mergeChunks(chunksRef.current[0])
    const rightChannel = mergeChunks(chunksRef.current[1])

    const durationSecs = leftChannel.length / sampleRateRef.current
    console.log(`Recording stopped. Duration: ${durationSecs.toFixed(1)}s`)

    // Create blob and URL for preview
    if (leftChannel.length > 0) {
      const wavBlob = encodeWAV([leftChannel, rightChannel], sampleRateRef.current)
      const url = URL.createObjectURL(wavBlob)
      recordedUrlRef.current = url // Track URL in ref for cleanup
      console.log(`Recording ready: ${(wavBlob.size / 1024).toFixed(1)} KB`)

      // Reset recording state but keep the blob for preview
      chunksRef.current = [[], []]
      setState({ isRecording: false, duration: 0, error: null, recordedBlob: wavBlob, recordedUrl: url })
      return wavBlob
    }

    recordedUrlRef.current = null
    chunksRef.current = [[], []]
    setState({ isRecording: false, duration: 0, error: null, recordedBlob: null, recordedUrl: null })
    return null
  }, [state.isRecording, restoreRouting])

  /**
   * Download the recorded audio.
   */
  const downloadRecording = useCallback(() => {
    if (state.recordedBlob) {
      const filename = generateRecordingFilename()
      downloadBlob(state.recordedBlob, filename)
    }
  }, [state.recordedBlob])

  /**
   * Dismiss the recording preview without downloading.
   */
  const dismissRecording = useCallback(() => {
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current)
      recordedUrlRef.current = null
    }
    setState(prev => ({ ...prev, recordedBlob: null, recordedUrl: null }))
  }, [])

  // Cleanup on unmount - restoring routing matters most: leaving the
  // destination gain wired to a dead processor mutes Strudel entirely.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      restoreRouting()
      if (recordedUrlRef.current) {
        URL.revokeObjectURL(recordedUrlRef.current)
      }
    }
  }, [restoreRouting])

  return {
    isRecording: state.isRecording,
    duration: state.duration,
    error: state.error,
    recordedBlob: state.recordedBlob,
    recordedUrl: state.recordedUrl,
    startRecording,
    stopRecording,
    downloadRecording,
    dismissRecording,
  }
}

/**
 * Format seconds as MM:SS.
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
