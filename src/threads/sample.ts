// import: constants
import { parentPort, workerData } from 'node:worker_threads'
import color from 'cli-color'

// import: types
import { SampleEvent } from '../types/SampleEvent.js'

// code
let samples = workerData.samples.map(s => ({
    pcm: [new Float32Array(s.pcm[0]), new Float32Array(s.pcm[1])],
    velocity: s.velocity,
    attack: s.attack,
    release: s.release,
    attenuation: s.attenuation
}))
let pitchbend = {}
let globalStart = workerData.data[0]?.t ?? 0
let channelData = [
    new Float32Array(workerData.sab[0]),
    new Float32Array(workerData.sab[1])
]
//console.log(workerData.data.length, 'events to process for thread', workerData.id)
for (let i = 0; i < workerData.data.length; i++) {
    let sampleEvent: SampleEvent = workerData.data[i]
    if (!sampleEvent)
        continue
    switch (sampleEvent.k) {
        case 'note':
            let start = Math.floor(sampleEvent.t * workerData.sampleRate)
            let stop = Math.floor((sampleEvent.t + sampleEvent.d) * workerData.sampleRate)
            let sample = samples[sampleEvent.n]
            if (start >= channelData[0].length)
                continue
            let bend = (pitchbend[sampleEvent.c] ?? 0)
            let pbNote = (bend / 8192) * 12
            let pcm = /*[
                bend == 0 ? sample.pcm[0] : this.#transpose(sample.pcm[0], sampleEvent.n, sampleEvent.n + pbNote),
                bend == 0 ? sample.pcm[1] : this.#transpose(sample.pcm[1], sampleEvent.n, sampleEvent.n + pbNote)
            ]*/sample.pcm;
            var cc = {
                modulation: {},
                volume: {},
                expression: {}
            }
            for (let k = 0; k < pcm[0].length; k++) {
                let index = start + k
                let release = Math.floor(sample.release * workerData.sampleRate)
                let attack = Math.floor(sample.attack * workerData.sampleRate)
                let ramp = 2.0
                if (index >= stop + release) break
                if (index >= channelData[0].length || index >= channelData[1].length) break
                if (!pcm[0][k] && !pcm[1][k]) continue
                let o0 = channelData[0][index] ?? 0.0,
                    o1 = channelData[1][index] ?? 0.0
                let a = index >= start + attack ? 1 : (index - start) / attack
                let r = index >= stop ? 1 - (index - stop) / release : 1
                if (workerData.opts?.enableCC)
                    for (let ev of workerData.cc.reverse()) {
                        if (ev.t > index / workerData.sampleRate) break
                        if (ev.c !== sampleEvent.c) continue
                        switch (ev.n) {
                            case 0x01: // modulation
                                cc.modulation[sampleEvent.c] = ev.v
                                break
                            case 0x07: // volume
                                cc.volume[sampleEvent.c] = ev.v
                                break
                            case 0x0b: // expression
                                cc.expression[sampleEvent.c] = ev.v
                                break
                        }
                    }
                let m = cc.modulation[sampleEvent.c] ?? 1.0
                let v = (cc.volume[sampleEvent.c] ?? 1.0) * (cc.expression[sampleEvent.c] ?? 1.0)
                let y0 = pcm[0][k] * sample.attenuation * (sample.velocity ?? sampleEvent.v) ** ramp * r ** ramp * a ** ramp * v,
                    y1 = pcm[1][k] * sample.attenuation * (sample.velocity ?? sampleEvent.v) ** ramp * r ** ramp * a ** ramp * v
                channelData[0][index] = o0 + y0
                channelData[1][index] = o1 + y1
            }
            break
    }
    //i % 2000 === 0 ? console.log(`Thread ID: ${workerData.id} - [${color.blueBright(i.toLocaleString())} / ${color.blueBright(workerData.data.length.toLocaleString())}] events rendered...`) : void 0
}
parentPort?.postMessage({ id: workerData.id, done: true })