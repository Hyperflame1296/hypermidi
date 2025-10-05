// import: classes
import { Worker } from 'node:worker_threads'

// import: constants
import fs from 'node:fs'
import midiParser from 'midi-parser-js'
import color from 'cli-color'
import sf2 from 'soundfont2'

// import: local interfaces
import { Limiter } from './interfaces/Limiter.js'
import { NoteSampleEvent } from './interfaces/NoteSampleEvent.js'
import { ControlChangeSampleEvent } from './interfaces/ControlChangeSampleEvent.js'
import { PitchBendSampleEvent } from './interfaces/PitchBendSampleEvent.js'
import { Synth } from './interfaces/Synth.js'
import { SampleObject } from './interfaces/SampleObject.js'
import { RendererOptions } from './interfaces/RendererOptions.js'

// import: local types
import { SampleEvent } from './types/SampleEvent.js'
// code
let lerp = (a: number, b: number, t: number) => a + (b - a) * t
let toLinear = (cb: number) => {
    return 10 ** (-(cb / 10) / 20)
}
let toTimeLinear = (tc: number) => {
    return 2 ** (tc / 1200)
}
let tags = {
    info:  `[${color.greenBright('HyperMIDI')}] - [${color.cyanBright('INFO')}] - `,
    warn:  `[${color.greenBright('HyperMIDI')}] - [${color.yellowBright('WARNING')}] - `,
    error: `[${color.greenBright('HyperMIDI')}] - [${color.redBright('ERROR')}] - `
}
class Renderer {
    sampleEvents: SampleEvent[] = []
    controlChangeEvents: ControlChangeSampleEvent[] = []
    events = []
    samples: SampleObject[] = []
    sampleRate: number = 48000
    volume: number = 1.0
    soundfont: sf2.SoundFont2
    limiter: Limiter = {
        attack: 0.01,
        release: 0.0001, // 0.001
        threshold: 0.3,
    }
    synth: Synth = {
        attack: 0.0,
        release: 0.25
    }
    threadCount: number = 8
    threads: Worker[] = []
    options: RendererOptions = {}
    constructor(options: RendererOptions = {}) {
        this.threadCount = options.threadCount ?? 8
        this.options.sampleRate = options.sampleRate ?? 48000
        this.options.enableCC = options.enableCC ?? true
        this.options.audioBufferSize = options.audioBufferSize ?? 512
        this.options.chorus = {
            enabled: options.chorus?.enabled ?? true,
            rate: options.chorus?.rate ?? 0.8,
            depth: options.chorus?.depth ?? 0.006,
            mix: options.chorus?.mix ?? 0.5
        }
        this.options.logging = {
            info: options.logging?.info ?? false,
            warn: options.logging?.warn ?? true,
            error: options.logging?.error ?? true
        }
    }
    #getSample(preset: number, bank: number, note: number): SampleObject {
        let p = this.soundfont.presets.find(p => p.header.bank === bank && p.header.preset === preset)
        if (!p)
            throw new Error(`No such MIDI preset \'${preset.toString().padStart(3, '0')}:${bank.toString().padStart(3, '0')}\'.`)
        let z = p.zones.find(z => note >= (z.keyRange?.lo ?? 0) && note <= (z.keyRange?.hi ?? 127)) ?? p.zones[0]
        if (!z)
            throw new Error(`No preset zone matches note \`${note}\`.`)
        let i = z.instrument
        if (!i)
            throw new Error(`No instrument in preset zone.`)
        let iz = i.zones.find(z => note >= (z.keyRange?.lo ?? 0) && note <= (z.keyRange?.hi ?? 127) && note >= (z.generators[43]?.range.lo ?? 0) && note <= (z.generators[43]?.range.hi ?? 127)) ?? i.zones[0]
        if (!iz)
            throw new Error('No instrument zone matches note \`${note}\`.')
        if (!iz.sample)
            throw new Error('No sample for instrument zone.')
        let root = iz.generators[58]?.value ?? iz.sample.header.originalPitch ?? 60
        let fine = (iz.generators[52]?.value ?? 0) + (iz.sample.header.pitchCorrection ?? 0)
        let coarse = iz.generators[51]?.value ?? 0
        let rate = iz.sample.header.sampleRate
        let pcm = this.#resample(
            this.#transpose(
                Float32Array.from(iz.sample.data, (x: number) => x / 32768), 
                (root - fine / 100) - coarse, 
                note
            ), 
            rate, 
            this.options.sampleRate
        )
        return {
            sample: iz.sample,
            pcm: [pcm, pcm],
            velocity: iz.generators[47]?.value,
            attack: this.synth.attack ?? toTimeLinear(iz.generators[34]?.value ?? -Infinity),
            release: this.synth.release ?? toTimeLinear(iz.generators[38]?.value ?? -Infinity),
            attenuation: toLinear(iz.generators[48]?.value ?? 0)
        }
    }
    #transpose(data: Float32Array, root: number, note: number) {
        let diff = note - root;
        let ratio = 2 ** (diff / 12);
        let len = Math.floor(data.length / ratio);
        let out = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            let j = Math.floor(i * ratio)
            let k = Math.ceil (i * ratio)
            let t = (i * ratio) - j
            out[i] = lerp(data[j] ?? 0, data[k] ?? 0, t)
        }
        return out
    }
    #resample(data: Float32Array, orate: number, rate: number) {
        let mul = rate / orate
        let len = Math.floor(data.length * mul)
        let out = new Float32Array(len)
        for (let i = 0; i < len; i++) {
            // linear interpolation
            let j = Math.floor(i / mul)
            let k = Math.ceil (i / mul)
            let t = (i / mul) - j
            out[i] = lerp(data[j] ?? 0, data[k] ?? 0, t)
        }
        return out
    }
    loadSoundfont(path:string) {
        let start = performance.now()
        if (this.options.logging?.info) console.log(tags.info + 'Loading soundfont...')
        this.soundfont = new sf2.SoundFont2(fs.readFileSync(path))
        if (this.options.logging?.info) console.log(tags.info + 'Creating samples...')
        this.samples = Array(128).fill(0).map((x, i) => this.#getSample(0, 0, i))
        let end = performance.now()
        if (this.options.logging?.info) console.log(tags.info + `${color.greenBright('Finished loading soundfont!')} ${'(' + color.white(((end - start) / 1000).toFixed(1)) + 's)'}`)
    }
    async render(path: string) {
        let start = performance.now()
        if (this.options.logging?.info) console.log(tags.info + 'Loading MIDI...')
        let data = fs.readFileSync(path)
        if (this.options.logging?.info) console.log(tags.info + 'Parsing MIDI...')
        let midi = midiParser.parse(data)
        if (this.options.logging?.info) console.log(tags.info + 'Combining tracks...')
        var defaultBpm = 120
        let ppq = midi.timeDivision

        let combinedEvents = []
        let usPerQuarter = 60_000_000 / defaultBpm
        let secondsPerTick = usPerQuarter / ppq / 1_000_000
        for (let i = 0; i < midi.tracks; i++) {
            let t = midi.track[i]
            if (!t) continue
            let tick = 0
            for (let j = 0; j < t.event.length; j++) {
                let e = t.event[j]
                if (!e) continue
                tick += e.deltaTime
                switch (e.type) {
                    case 0xff: // meta
                        combinedEvents.push({
                            k: e.type,
                            m: e.metaType,
                            d: e.data,
                            c: e.channel,
                            t: tick
                        })
                        break
                    default:
                        combinedEvents.push({
                            k: e.type,
                            d: e.data,
                            c: e.channel,
                            t: tick
                        })
                        break
                }
                //j % 2000 === 0 ? console.log(`Track ${color.greenBright(i)} - [${color.blueBright(j.toLocaleString())} / ${color.blueBright(t.event.length.toLocaleString())}] events combined - Memory used: ${this.#formatSize(process.memoryUsage().heapTotal)}`) : void 0
            }
        }
        combinedEvents = combinedEvents.sort((a, b) => a.t - b.t)
        if (this.options.logging?.info) console.log(tags.info + 'Mapping events...')
        let l = 0
        let t = 0
        let noteMap: Map<string, [number, number][]> = new Map()
        let holdPedalNotes: Set<[number, number]>[] = Array(16).fill(false).map(() => new Set())
        let holdPedal: boolean[] = Array(16).fill(false)
        for (let e of combinedEvents) {
            let d = e.t - l
            t += d * secondsPerTick
            l = e.t
            switch (e.k) {
                case 0x08:
                    var key = `${e.c}${e.d[0]}`
                    if (!noteMap.get(key))
                        noteMap.set(key, [])
                    let n = noteMap.get(key).pop()
                    if (n) {
                        this.events.push({ 
                            s: 1,
                            k: 'note',
                            n: n[1][0], // MIDI note number
                            v: n[1][1] / 127, // velocity
                            t: n[0], // note on time
                            c: e.c, // channel
                            d: t - n[0] // note duration
                        })
                    }
                    break
                case 0x09: // note
                    var key = `${e.c}${e.d[0]}`
                    if (!noteMap.get(key))
                        noteMap.set(key, [])
                    if (e.d[1] <= 0) { // note off
                        let n = noteMap.get(key).pop()
                        if (n) {
                            this.events.push({ 
                                s: 1,
                                k: 'note',
                                n: n[1][0], // MIDI note number
                                v: n[1][1] / 127, // velocity
                                t: n[0], // note on time
                                c: e.c, // channel
                                d: t - n[0] // note duration
                            })
                        }
                    } else { // note on
                        if (holdPedal[e.c])
                            holdPedalNotes[e.c].add([
                                t,
                                e.d
                            ])
                        else 
                            noteMap.get(key).push([
                                t,
                                e.d
                            ])
                    }
                    break
                case 0x0b: // cc
                    if (e.d[0] === 0x40) { // hold pedal
                        if (e.d[1] >= 64) { // on
                            holdPedal[e.c] = true
                        } else { // off
                            holdPedal[e.c] = false
                            for (let n of holdPedalNotes[e.c]) {
                                this.events.push({ 
                                    s: 1,
                                    k: 'note',
                                    n: n[1][0], // MIDI note number
                                    v: n[1][1] / 127, // velocity
                                    t: n[0], // note on time
                                    c: e.c, // channel
                                    d: t - n[0] // note duration
                                })
                            }
                            holdPedalNotes[e.c].clear()
                        }
                    } else {
                        this.events.push({
                            s: 1,
                            k: 'cc',
                            t,
                            n: e.d[0], // cc number
                            v: e.d[1] / 127, // cc value,
                            c: e.c // channel
                        })
                    }
                    break
                case 0x0e: // pitch bend
                    this.events.push({
                        s: 1,
                        k: 'pitch',
                        t,
                        v: ((e.d[1] << 7) | e.d[0]) - 8192, // pitch bend amount
                        c: e.c // channel
                    })
                    break
                case 0xff: // meta
                    switch (e.m) {
                        case 0x51: // set tempo
                            usPerQuarter = e.d
                            secondsPerTick = usPerQuarter / ppq / 1_000_000
                            break
                    }
                    break
            }
        }
        combinedEvents = []
        return await this.renderNotes(this.events, start)
    }
    async renderNotes(events = [], start=performance.now()) {
        this.events = events.map(e => {
            if (e.s == 1) return e
            switch (e.type) {
                case 'note':
                    return ({
                        k: e.type,
                        n: e.note, // MIDI note number
                        v: (e.velocity ?? 1.0), // velocity
                        t: e.time, // note on time
                        c: e.channel ?? 0,
                        d: e.duration // note duration
                    })
                case 'cc':
                    return ({
                        k: e.type,
                        t: e.time,
                        n: e.cc, // cc number
                        v: (e.value ?? 1.0), // cc value
                        c: e.channel ?? 0,
                    })
                case 'pitch':
                    break
                default:
                    throw new Error(`Invalid event type: ${e.type}`)
            }
        })
        if (this.events.length === 0) throw new Error('There are no note events in this MIDI!');
        if (this.options.logging?.info) console.log(tags.info + 'Sorting events...')
        this.events = this.events.sort((a, b) => a.t - b.t)
        if (this.options.logging?.info) console.log(tags.info + 'Creating empty audio channel...')
        let length = this.events.findLast(v => !!v).t + (this.events.findLast(v => !!v).d ?? 0) + 1
        let sab = [
            new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * Math.floor(this.options.sampleRate * length)),
            new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * Math.floor(this.options.sampleRate * length))
        ]
        let channelData = [
            new Float32Array(sab[0]), 
            new Float32Array(sab[1])
        ]
        if (this.options.logging?.info) console.log(tags.info + 'Adding events...')
        let id = 0
        for (let e of this.events) {
            switch (e.k) {
                case 'note':
                    var noteSampleEvent: NoteSampleEvent = {
                        ...e,
                        id: id++
                    }
                    this.sampleEvents.push(noteSampleEvent)
                    break
                case 'cc':
                    var ccSampleEvent: ControlChangeSampleEvent = {
                        ...e,
                        id: id++
                    }
                    this.controlChangeEvents.push(ccSampleEvent)
                    break
                case 'pitch':
                    var pbSampleEvent: PitchBendSampleEvent = {
                        ...e,
                        id: id++
                    }
                    this.sampleEvents.push(pbSampleEvent)
                    break
            }
        }
        this.controlChangeEvents = this.controlChangeEvents.sort((a, b) => a.t - b.t)
        if (this.options.logging?.info) console.log(tags.info + 'Rendering...')
        let chunkSize = Math.ceil(this.sampleEvents.length / this.threadCount)
        let promises: Promise<void>[] = []
        for (let i = 0; i < this.threadCount; i++) {
            let start = i * chunkSize
            let end = Math.min(i * chunkSize + chunkSize, this.sampleEvents.length)
            let events = this.sampleEvents.slice(start, end)
            if (events.length <= 0) {
                promises.push(Promise.resolve())
                continue
            }
            let worker = new Worker(new URL('./threads/sample.js', import.meta.url), { 
                workerData: {
                    start, 
                    data: events,
                    sampleRate: this.options.sampleRate,
                    samples: this.samples.map(s => ({
                        pcm: [s.pcm[0].buffer, s.pcm[1].buffer], // SABs
                        velocity: s.velocity,
                        attack: s.attack,
                        release: s.release,
                        attenuation: s.attenuation
                    })),
                    cc: this.controlChangeEvents,
                    opts: this.options,
                    id: i,
                    sab
                } 
            })
            let p = new Promise<void>((res, rej) => {
                (worker as any).active = true
                worker.once('message', (msg) => {
                    if (msg.error) {
                        if (this.options.logging?.error) console.error(tags.error + `Thread ${msg.id + 1} has encountered an error: ${msg.error}`);
                        rej(new Error(msg.error));
                        return;
                    }
                    if (msg.done)
                        worker.terminate().then(() => {
                            res();
                            (worker as any).active = false
                        })
                })
                worker.once('error', (err) => {
                    rej(err)
                })
            })
            promises.push(p)
            this.threads[i] = worker
            if (this.options.logging?.info) console.log(tags.info + `Initialized thread ${i + 1} for events ${start.toLocaleString()} to ${end.toLocaleString()}!`);
        }
        
        this.sampleEvents = []
        await Promise.all(promises)
        this.threads = []
        if (this.options.logging?.info) console.log(tags.info + 'Applying limiter...')
        let gain = 1; // start with full gain

        for (let i = 0; i < channelData[0].length; i++) {
            let sample = [channelData[0][i], channelData[1][i]];
            let abs = (Math.abs(sample[0]) + Math.abs(sample[1])) / 2;

            let targetGain = abs > this.limiter.threshold ? this.limiter.threshold / abs : 1;

            // smooth gain: attack if reducing, release if increasing
            if (targetGain < gain) {
                gain -= (gain - targetGain) * this.limiter.attack;
            } else {
                gain += (targetGain - gain) * this.limiter.release;
            }

            channelData[0][i] = sample[0] * gain;
            channelData[1][i] = sample[1] * gain;
        }
        this.events = []
        this.sampleEvents = []
        let end = performance.now()
        if (this.options.logging?.info) console.log(tags.info + `${color.greenBright('Finished rendering!')} ${'(' + color.white(((end - start) / 1000).toFixed(1)) + 's)'}`)
        return channelData
    }
}
export {
    Renderer
}