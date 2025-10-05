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
    new Float32Array(workerData.arrayBuffer[0]),
    new Float32Array(workerData.arrayBuffer[1])
]
var cc = {
    modulation: new Float32Array(16),
    pan: new Float32Array(16),
    volume: new Float32Array(16),
    expression: new Float32Array(16),
    chorus: new Float32Array(16),
}
let ccMap = {
    0x01: Array.from({ length: 16 }, () => []), // modulation
    0x0a: Array.from({ length: 16 }, () => []), // pan
    0x07: Array.from({ length: 16 }, () => []), // volume
    0x0b: Array.from({ length: 16 }, () => []),  // expression
    0x5d: Array.from({ length: 16 }, () => []),  // chorus
}
for (let ev of workerData.cc) {
    if (ccMap[ev.n] && ev.c < 16)
        ccMap[ev.n][ev.c].push(ev);
}
for (let ctrl of Object.values(ccMap))
    for (let list of ctrl) list.sort((a, b) => a.t - b.t)
// Chorus state (persistent between samples!)
let chorusBufferL = new Float32Array(2048);
let chorusBufferR = new Float32Array(2048);
let chorusIndex = 0;
let chorusPhase = 0;

function getCCValue(list, t) {
    let lo = 0, hi = list.length - 1, lastVal = undefined;
    while (lo <= hi) {
        let mid = (lo + hi) >> 1;
        if (list[mid].t <= t) { lastVal = list[mid].v; lo = mid + 1; }
        else hi = mid - 1;
    }
    return lastVal;
}
let lerp = (a, b, t) => a + (b - a) * t
for (let i = 0; i < workerData.data.length; i++) {
    let sampleEvent: SampleEvent = workerData.data[i]
    if (!sampleEvent)
        continue
    if (sampleEvent.c < 0 || sampleEvent.c >= 16) continue;
    switch (sampleEvent.k) {
        case 'note':
            let start = Math.floor(sampleEvent.t * workerData.sampleRate)
            let stop = Math.floor((sampleEvent.t + sampleEvent.d) * workerData.sampleRate)
            let sample = samples[sampleEvent.n]
            if (start >= channelData[0].length)
                continue
            // pitch bend disabled for now
            let bend = (pitchbend[sampleEvent.c] ?? 0)
            let pbNote = (bend / 8192) * 12
            let pcm = /*[
                bend == 0 ? sample.pcm[0] : this.#transpose(sample.pcm[0], sampleEvent.n, sampleEvent.n + pbNote),
                bend == 0 ? sample.pcm[1] : this.#transpose(sample.pcm[1], sampleEvent.n, sampleEvent.n + pbNote)
            ]*/sample.pcm;
            let bufSize = workerData.opts?.audioBufferSize
            let release = Math.floor(sample.release * workerData.sampleRate)
            let attack = Math.floor(sample.attack * workerData.sampleRate)
            for (let j = 0; j < pcm[0].length; j += bufSize) {
                let data = [
                    pcm[0].subarray(j, j + bufSize),
                    pcm[1].subarray(j, j + bufSize)
                ]
                if (workerData.opts?.enableCC) {
                    let t = (start + j) / workerData.sampleRate
                    let c = sampleEvent.c
                    cc.modulation[c] = getCCValue(ccMap[0x01][c], t) ?? 0.0;
                    cc.volume[c]     = getCCValue(ccMap[0x07][c], t) ?? 0.787;
                    cc.expression[c] = getCCValue(ccMap[0x0b][c], t) ?? 1.0;
                    cc.chorus[c]     = getCCValue(ccMap[0x5d][c], t) ?? 0.0;
                    cc.pan[c]        = getCCValue(ccMap[0x0a][c], t) ?? 0.5;
                }
                for (let k = 0; k < data[0].length; k++) {
                    let index = start + j + k
                    if (index >= stop + release) break
                    if (index >= channelData[0].length || index >= channelData[1].length) break
                    if (!data[0][k] && !data[1][k]) continue
                    let o0 = channelData[0][index] ?? 0.0,
                        o1 = channelData[1][index] ?? 0.0
                    let a = index >= start + attack ? 1 : (index - start) / attack
                    let r = index >= stop ? 1 - (index - stop) / release : 1
                    let m = cc.modulation[sampleEvent.c]
                    let v = cc.volume[sampleEvent.c] * cc.expression[sampleEvent.c]
                    let y0 = data[0][k] * sample.attenuation * ((sample.velocity ?? sampleEvent.v) * (sample.velocity ?? sampleEvent.v)) * (r * r) * (a * a) * v * (1 - cc.pan[sampleEvent.c]),
                        y1 = data[1][k] * sample.attenuation * ((sample.velocity ?? sampleEvent.v) * (sample.velocity ?? sampleEvent.v)) * (r * r) * (a * a) * v * (cc.pan[sampleEvent.c] - 0)

                    // code written by ChatGPT
                    {
                        if (cc.chorus[sampleEvent.c] <= 0 || !workerData.opts?.chorus?.enabled) { // little integration by me to ignore chorus when its value is 0
                            channelData[0][index] = o0 + y0;
                            channelData[1][index] = o1 + y1;
                        } else {
                            // Write current dry signal into delay buffer
                            chorusBufferL[chorusIndex] = y0;
                            chorusBufferR[chorusIndex] = y1;

                            // Two LFOs — slightly phase-shifted for stereo widening
                            let lfoL = Math.sin(chorusPhase * 2 * Math.PI);
                            let lfoR = Math.sin((chorusPhase + 0.25) * 2 * Math.PI); // 90° offset for right channel

                            // Calculate modulated delay offsets per channel
                            let delaySamplesL = (workerData.opts?.chorus?.depth ?? 0.006 + lfoL * (workerData.opts?.chorus?.depth ?? 0.006)) * workerData.sampleRate;
                            let delaySamplesR = (workerData.opts?.chorus?.depth ?? 0.006 + lfoR * (workerData.opts?.chorus?.depth ?? 0.006)) * workerData.sampleRate;

                            // === LEFT ===
                            let readIndexL = (chorusIndex - delaySamplesL + chorusBufferL.length) % chorusBufferL.length;
                            let i0L = Math.floor(readIndexL);
                            let i1L = (i0L + 1) % chorusBufferL.length;
                            let fracL = readIndexL - i0L;
                            let delayedL = lerp(chorusBufferL[i0L], chorusBufferL[i1L], fracL);

                            // === RIGHT ===
                            let readIndexR = (chorusIndex - delaySamplesR + chorusBufferR.length) % chorusBufferR.length;
                            let i0R = Math.floor(readIndexR);
                            let i1R = (i0R + 1) % chorusBufferR.length;
                            let fracR = readIndexR - i0R;
                            let delayedR = lerp(chorusBufferR[i0R], chorusBufferR[i1R], fracR);

                            // Mix wet/dry (scaled by CC)
                            let mix = (workerData.opts?.chorus?.mix ?? 0.5) * cc.chorus[sampleEvent.c];
                            let wet0 = y0 * (1 - mix) + delayedL * mix;
                            let wet1 = y1 * (1 - mix) + delayedR * mix;

                            // Advance chorus state
                            chorusPhase += (workerData.opts?.chorus?.rate ?? 0.8) / workerData.sampleRate;
                            if (chorusPhase >= 1) chorusPhase -= 1;
                            chorusIndex = (chorusIndex + 1) % chorusBufferL.length;

                            // Write output
                            channelData[0][index] = o0 + wet0;
                            channelData[1][index] = o1 + wet1;
                        }
                    }
                }
            }
            break
    }
    //i % 2000 === 0 ? console.log(`Thread ID: ${workerData.id} - [${color.blueBright(i.toLocaleString())} / ${color.blueBright(workerData.data.length.toLocaleString())}] events rendered...`) : void 0
}
parentPort?.postMessage({ id: workerData.id, done: true })