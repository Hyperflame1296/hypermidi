// import: local interfaces
import { ControlChangeSampleEvent } from '../interfaces/ControlChangeSampleEvent.js';
import { NoteSampleEvent } from '../interfaces/NoteSampleEvent.js';
import { PitchBendSampleEvent } from '../interfaces/PitchBendSampleEvent.js';

// definition
type SampleEvent =
    | NoteSampleEvent
    | ControlChangeSampleEvent
    | PitchBendSampleEvent
export {
    SampleEvent
}