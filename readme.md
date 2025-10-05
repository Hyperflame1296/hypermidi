# hypermidi
a MIDI renderer, for fun ig

# Usage
To use this package, you first need a soundfont (`.sf2` file), and a MIDI file (`.mid`).  
Below is an example of how to use the `Renderer`:
```js
import { Renderer } from 'hypermidi'
let renderer = new Renderer({ // all options are optional
    threadCount: 8,
    sampleRate: 48000,
    enableCC: true,
    enablePitchBend: true,
    audioBufferSize: 512,
    chorus: {
        enabled: true,
        rate: 0.8,
        depth: 0.006,
        mix: 0.5
    },
    logging: {
        info: false,
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
Below is an example of rendering a strummed C major chord:
```js
let notes = [
    {
        type: 'note',
        note: 60, // C
        velocity: 1,
        time: 0.0,
        duration: 1,
        channel: 0
    },
    {
        type: 'note',
        note: 64, // E
        velocity: 1,
        time: 0.25,
        duration: 1,
        channel: 0
    },
    {
        type: 'note',
        note: 67, // G
        velocity: 1,
        time: 0.5,
        duration: 1,
        channel: 0
    }
]
renderer.loadSoundfont('path/to/soundfont.sf2')
let channelData = await renderer.renderNotes(notes)
```