# hypermidi
a MIDI renderer.

# Usage'
To use this package, you first need a soundfont (`.sf2` file), and a MIDI file (`.mid`).
```js
import { Renderer } from 'hypermidi'
let renderer = new Renderer({ // all options are optional
    threadCount: 8,
    sampleRate: 48000,
    enableCC: true,
    audioBufferSize: 512,
    chorus: {
        enabled: true,
        rate: 0.8,
        depth: 0.006,
        mix: 0.5
    },
    logging: {
        info: true,
        warn: true,
        error: true
    }
})
renderer.loadSoundfont('path/to/soundfont.sf2') // load a soundfont
let channelData = await renderer.render('path/to/midi/file.mid') // render a MIDI file
// channelData is an array of two Float32Arrays (left and right) at the specified sample rate
// You can then encode it to WAV using wav-encoder or any other library
```
You can also make your own event list and render it.
```js
let notes = [
    {
        type: 'note',
        note: 60,
        velocity: 1,
        time: 0,
        duration: 1,
        channel: 0
    }
]
let channelData = await renderer.renderNotes(notes)
```