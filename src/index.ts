// import: classes
import { Worker } from 'node:worker_threads'

// import: constants
import fs from 'node:fs'
import url from 'node:url';
import path from 'node:path';
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

// import: local classes
import { Player } from './modules/jmidiplayer/index.js'

// import: local types
import { SampleEvent } from './types/SampleEvent.js'
import { start } from 'node:repl';

// code
let __dirname = path.dirname(url.fileURLToPath(import.meta.url));
let lerp = (a: number, b: number, t: number) => a + (b - a) * t
let toLinear = (cb: number) => 10 ** (-(cb / 10) / 20)
let toTimeLinear = (tc: number) => 2 ** (tc / 1200)
let tags = {
    info:  `[${color.greenBright('HyperMIDI')}] - [${color.cyanBright('INFO')}] - `,
    warn:  `[${color.greenBright('HyperMIDI')}] - [${color.yellowBright('WARNING')}] - `,
    error: `[${color.greenBright('HyperMIDI')}] - [${color.redBright('ERROR')}] - `
}
/*
for future use:
let player = player
let data = new Uint8Array(player.tracks[1].packedBuffer)
let events = []
for (let i = 0; i < data.length; i += 8) {
    let tick = (
        (data[i + 0] << 0x18) +
        (data[i + 1] << 0x10) +
        (data[i + 2] << 0x08) +
        (data[i + 3] << 0x00)
    )
    let type = data[i + 4]
    switch (type) {
        case 0x08:
            events.push({
                type: 0x08,
                tick,
                channel: data[i + 5],
                note: data[i + 6]
            })
            break
        case 0x09:
            events.push({
                type: 0x09,
                tick,
                channel: data[i + 5],
                note: data[i + 6],
                velocity: data[i + 7],
            })
            break
    }
}
console.log(events)
events = []
*/
/**
 * An audio renderer.
 */
class Renderer {
    #sampleEventsSAB: SharedArrayBuffer
    #sampleEvents: Uint8Array<SharedArrayBuffer>
    #controlChangeEvents: ControlChangeSampleEvent[] = []
    #pitchBendEvents: PitchBendSampleEvent[] = []
    #events = []
    #samples: SampleObject[] = []
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
    #threads: Worker[] = []
    options: RendererOptions = {}
    #internalPlayer: Player = new Player
    constructor(options: RendererOptions = {}) {
        this.threadCount                = options.threadCount        ?? 8
        this.options.sampleRate         = options.sampleRate         ?? 48000
        this.options.enableCC           = options.enableCC           ?? true
        this.options.polyphonyLimit     = options.polyphonyLimit     ?? 0
        this.options.audioBufferSize    = options.audioBufferSize    ?? 512
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
        let sample: SampleObject = {
            sample: iz.sample,
            pcm: [pcm, pcm],
            velocity: iz.generators[47]?.value,
            attack: this.synth.attack ?? toTimeLinear(iz.generators[34]?.value ?? -Infinity),
            release: this.synth.release ?? toTimeLinear(iz.generators[38]?.value ?? -Infinity),
            attenuation: toLinear(iz.generators[48]?.value ?? 0)
        }
        return sample
    }
    #transpose(data: Float32Array, root: number, note: number): Float32Array {
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
    #resample(data: Float32Array, orate: number, rate: number): Float32Array {
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
    /**
     * Load a SoundFont file.
     * @param path Path to a `.sf2` file.
     */
    loadSoundfont(path: string): void {
        let start = performance.now()
        if (this.options.logging?.info) console.log(tags.info + 'Loading soundfont...')
        this.soundfont = new sf2.SoundFont2(fs.readFileSync(path))
        if (this.options.logging?.info) console.log(tags.info + 'Creating samples...')
        this.#samples = Array(128).fill(0).map((x, i) => this.#getSample(0, 0, i))
        let end = performance.now()
        if (this.options.logging?.info) console.log(tags.info + `${color.greenBright('Finished loading soundfont!')} ${'(' + color.white(((end - start) / 1000).toFixed(1)) + 's)'}`)
    }
    /**
     * Load a MIDI file.
     * @param path Path to a `.mid` or `.mid` file.
     */
    async loadMIDI(path: string): Promise<void> {
        let start = performance.now()
        if (this.options.logging?.info) console.log(tags.info + 'Loading MIDI...')
        await this.#internalPlayer.loadFile(path)
        let end = performance.now()
        if (this.options.logging?.info) console.log(tags.info + `${color.greenBright('Finished loading MIDI!')} ${'(' + color.white(((end - start) / 1000).toFixed(1)) + 's)'}`)
    }
    /**
     * Render the currently loaded MIDI file to an audio buffer.
     * @param path Path to a `.mid` or `.midi` file.
     */
    async render(): Promise<[Float32Array<SharedArrayBuffer>, Float32Array<SharedArrayBuffer>]> {
        if (this.#internalPlayer.tracksParsed <= 0)
            throw new Error('No MIDI is currently loaded!')
        let start = performance.now()
        if (this.options.logging?.info) console.log(tags.info + 'Combining tracks...')
        var defaultBpm = 120
        let ppq = this.#internalPlayer.ppqn

        let combinedEvents = []
        let usPerQuarter = 60_000_000 / defaultBpm
        let secondsPerTick = usPerQuarter / ppq / 1_000_000
        //let data = new Uint8Array(player.tracks[i].packedBuffer)
        for (let i = 0; i < this.#internalPlayer.trackCount; i++) {
            let t: ArrayBuffer = this.#internalPlayer.tracks[i].packedBuffer
            if (!t) continue
            let data = new Uint8Array(t)
            for (let j = 0; j < t.byteLength; j += 8) {
                let tick = (
                    (data[j + 0] << 0x18) +
                    (data[j + 1] << 0x10) +
                    (data[j + 2] << 0x08) +
                    (data[j + 3] << 0x00)
                )
                let type = data[j + 4]
                switch (type) {
                    case 0x51: // tempo change
                        combinedEvents.push({
                            k: 0x51,
                            d: (
                                (data[j + 5] << 0x10) +
                                (data[j + 6] << 0x08) +
                                (data[j + 7] << 0x00)
                            ),
                            t: tick
                        })
                        break
                    default:
                        combinedEvents.push({
                            k: type,
                            d: [data[j + 6], data[j + 7]],
                            c: data[j + 5],
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
        let noteMap: Map<string, [number, [number, number]][]> = new Map()
        let holdPedalNotes = Array(16).fill(false).map(() => new Set)
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
                        this.#events.push({ 
                            s: 1,
                            k: 'note',
                            n: n[1][0], // MIDI note number
                            v: n[1][1], // velocity
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
                            this.#events.push({ 
                                s: 1,
                                k: 'note',
                                n: n[1][0], // MIDI note number
                                v: n[1][1], // velocity
                                t: n[0], // note on time
                                c: e.c, // channel
                                d: t - n[0] // note duration
                            })
                        }
                    } else { // note on
                        if (holdPedal[e.c]) {
                            if (this.options.polyphonyLimit > 0 && holdPedalNotes[e.c].size >= this.options.polyphonyLimit)
                                continue
                            holdPedalNotes[e.c].add([
                                t,
                                e.d
                            ])
                        } else {
                            if (this.options.polyphonyLimit > 0 && noteMap.get(key).length >= this.options.polyphonyLimit)
                                noteMap.get(key).shift()
                            noteMap.get(key).push([
                                t,
                                e.d
                            ] as [number, [number, number]] & number)
                        }
                    }
                    break
                case 0x0b: // cc
                    if (e.d[0] === 0x40) { // hold pedal
                        if (e.d[1] >= 64) { // on
                            holdPedal[e.c] = true
                        } else { // off
                            holdPedal[e.c] = false
                            for (let n of holdPedalNotes[e.c]) {
                                if (!n)
                                    continue
                                this.#events.push({ 
                                    s: 1,
                                    k: 'note',
                                    n: n[1][0], // MIDI note number
                                    v: n[1][1], // velocity
                                    t: n[0], // note on time
                                    c: e.c, // channel
                                    d: t - n[0] // note duration
                                })
                            }
                            holdPedalNotes[e.c].clear()
                        }
                    } else if (this.options.enableCC) {
                        this.#events.push({
                            s: 1,
                            k: 'cc',
                            t,
                            n: e.d[0], // cc number
                            v: e.d[1] / 127, // cc value,
                            c: e.c // channel
                        })
                    }
                    break
                case 0x51: // tempo change
                    usPerQuarter = e.d
                    secondsPerTick = usPerQuarter / ppq / 1_000_000
                    break

            }
        }
        noteMap.clear()
        holdPedal = []
        holdPedalNotes = []
        combinedEvents = []
        return await this.renderNotes(this.#events, start)
    }
    /**
     * Render a group of notes.
     * @param events Array of note events.
     * @param start The time at which rendering started. Mostly used internally.
     */
    async renderNotes(events: any[] = [], start: number = performance.now()): Promise<[Float32Array<SharedArrayBuffer>, Float32Array<SharedArrayBuffer>]> {
        const EVENT_SIZE = 12
        this.#events = events.map(e => {
            if (e.s === 1) return e
            switch (e.type) {
                case 'note':
                    return ({
                        k: e.type,
                        n: e.note, // MIDI note number
                        v: Math.floor((e.velocity ?? 1.0) * 127), // velocity
                        t: e.time, // note on time
                        c: e.channel ?? 0,
                        d: e.duration // note duration
                    })
                case 'cc':
                    if (!this.options.enableCC) return
                    return ({
                        k: e.type,
                        t: e.time,
                        n: e.cc, // cc number
                        v: (e.value ?? 1.0), // cc value
                        c: e.channel ?? 0,
                    })
                default:
                    throw new Error(`Invalid event type: ${e.type}`)
            }
        })
        if (this.#events.length === 0) throw new Error('There are no note events in this MIDI!');
        if (this.options.logging?.info) console.log(tags.info + 'Sorting events...')
        this.#events = this.#events.sort((a, b) => a.t - b.t)
        if (this.options.logging?.info) console.log(tags.info + 'Creating sample event buffer...')
        this.#sampleEventsSAB = new SharedArrayBuffer(this.#events.length * 12)
        this.#sampleEvents = new Uint8Array(this.#sampleEventsSAB)
        if (this.options.logging?.info) console.log(tags.info + 'Creating empty audio channel...')
        let length = this.#events.findLast(v => !!v).t + (this.#events.findLast(v => !!v).d ?? 0) + 1
        let arrayBuffer: [SharedArrayBuffer, SharedArrayBuffer] = [
            new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * Math.floor(this.options.sampleRate * length)),
            new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * Math.floor(this.options.sampleRate * length))
        ]
        let channelData: [Float32Array<SharedArrayBuffer>, Float32Array<SharedArrayBuffer>] = [
            new Float32Array(arrayBuffer[0]), 
            new Float32Array(arrayBuffer[1])
        ]
        if (this.options.logging?.info) console.log(tags.info + 'Adding events...')
        let id = 0
        let eventCount = 0
        let offset = 0
        for (let e of this.#events) {
            if (!e)
                return
            /*
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
                    if (!this.options.enableCC) return
                    return ({
                        k: e.type,
                        t: e.time,
                        n: e.cc, // cc number
                        v: (e.value ?? 1.0), // cc value
                        c: e.channel ?? 0,
                    })
            */
            switch (e.k) {
                case 'note':
                    let t = Math.floor(e.t * this.sampleRate)
                    let d = Math.floor(e.d * this.sampleRate)
                    let bytes = [
                        (t >> 0x18) & 0xff, // time in samples
                        (t >> 0x10) & 0xff, 
                        (t >> 0x08) & 0xff, 
                        (t >> 0x00) & 0xff,   
                        (d >> 0x18) & 0xff, // duration in samples
                        (d >> 0x10) & 0xff,
                        (d >> 0x08) & 0xff,
                        (d >> 0x00) & 0xff,        
                        0x01              , // event type
                        e.c               , // channel
                        e.n               , // note number
                        e.v               , // velocity              
                    ]
                    for (let byte of bytes) {
                        this.#sampleEvents[offset++] = byte
                    }
                    eventCount++
                    break
                case 'cc':
                    if (!this.options.enableCC) continue
                    var ccSampleEvent: ControlChangeSampleEvent = {
                        ...e,
                        id: id++
                    }
                    this.#controlChangeEvents.push(ccSampleEvent)
                    break
            }
        }
        this.#events = []
        this.#controlChangeEvents = this.#controlChangeEvents.sort((a, b) => a.t - b.t)
        if (this.options.logging?.info) console.log(tags.info + 'Rendering...')
        let chunkSize = Math.ceil(eventCount / this.threadCount)
        let promises: Promise<void>[] = []
        let sharedSamples = this.#samples.map(s => ({
            pcm: [s.pcm[0].buffer, s.pcm[1].buffer],
            velocity: s.velocity,
            attack: s.attack,
            release: s.release,
            attenuation: s.attenuation
        }))
        for (let i = 0; i < this.threadCount; i++) {
            let startEvent = i * chunkSize
            let endEvent = Math.min(startEvent + chunkSize, eventCount)
            if (startEvent >= endEvent) {
                promises.push(Promise.resolve())
                continue
            }
            let start = startEvent * EVENT_SIZE, 
                end   = endEvent   * EVENT_SIZE
            let events = this.#sampleEvents.subarray(start, end)
            let worker = new Worker(path.join(__dirname, './threads/sample.js'), { 
                workerData: {
                    start, 
                    data: events,
                    sampleRate: this.options.sampleRate,
                    samples: sharedSamples,
                    cc: this.#controlChangeEvents,
                    pb: this.#pitchBendEvents,
                    opts: this.options,
                    id: i,
                    arrayBuffer
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
            this.#threads[i] = worker
            if (this.options.logging?.info) console.log(tags.info + `Initialized thread ${i + 1} for events ${(startEvent).toLocaleString()} to ${(endEvent).toLocaleString()}!`);
        }
        this.#sampleEventsSAB = new SharedArrayBuffer()
        this.#sampleEvents = new Uint8Array(this.#sampleEventsSAB)
        this.#controlChangeEvents = []
        this.#pitchBendEvents = []
        await Promise.all(promises)
        this.#threads = []
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
        let end = performance.now()
        if (this.options.logging?.info) console.log(tags.info + `${color.greenBright('Finished rendering!')} ${'(' + color.white(((end - start) / 1000).toFixed(1)) + 's)'}`)
        return channelData
    }
}
export {
    Renderer
}