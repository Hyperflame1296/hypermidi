// import: interfaces
import { Sample } from 'soundfont2'

// definition
interface SampleObject {
    sample: Sample
    pcm: [Float32Array, Float32Array]
    velocity?: number
    attack: number
    release: number
    attenuation: number
}
export {
    SampleObject
}