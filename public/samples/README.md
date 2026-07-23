# Local Samples

Drop audio files (WAV/MP3/OGG) in this directory to use them in Strudel -
real instruments, field recordings, your own drum hits. Files here are served
at `http://localhost:3000/samples/...`.

## Using them in a pattern

Register the samples at the top of your code, then play them like any sound:

```javascript
samples({
  warmkick: '/samples/warmkick.wav',
  vinyl: '/samples/vinyl-crackle.wav',
})

$: s("warmkick*4")
$: s("vinyl").loopAt(4)
```

## Pitched instruments (multi-sample)

Map notes to files and Strudel picks the closest sample per note:

```javascript
samples({
  sax: { c3: '/samples/sax-c3.wav', g3: '/samples/sax-g3.wav' },
})

$: note("c3 eb3 g3 bb3").s("sax")
```

## Notes

- Keep names lowercase and unique - they share a namespace with built-in sounds.
- Subdirectories are fine: `/samples/kicks/deep.wav`.
- Tracks saved with local samples only replay on this machine, and strudel.cc
  share links can't resolve them.
