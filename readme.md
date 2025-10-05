# hypermidi
a MIDI renderer.

# Usage
```js
import WavEncoder from 'wav-encoder'
import { Renderer } from 'hypermidi'
import fs from 'node:fs'
console.clear()
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
// channelData is two Float32Arrays (left and right) at the specified sample rate
// You can then encode it to WAV using wav-encoder or any other library
let audioData = {
    sampleRate: renderer.sampleRate,
    channelData,
}
let buffer = WavEncoder.encode.sync(audioData, {
    float: true
})
fs.writeFileSync('out.wav', Buffer.from(buffer));
```