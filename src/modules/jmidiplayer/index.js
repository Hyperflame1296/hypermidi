// 'THE BEER-WARE LICENSE' (Revision 42):
// <me@seq.wtf> wrote this file.
// As long as you retain this notice you can do whatever you want with this stuff.
// If we meet some day, and you think this stuff is worth it, you can buy me a beer in return.
// - James

// I can't be bothered to write a README, so I'll put it here.
// The main focus of this player is to be as efficient as I can make it, within reason.
// From my testing, it was able to load a 1.68 GiB MIDI file (~448M events) in 2 seconds
// and play it without any hiccups. (Ryzen 9 9900X @ 24 threads)
//
// [!] This is not a generic MIDI parser/player!
// - It does not support MIDI format 2 or SMPTE timecodes. The `load` function will throw
//   an error if you try loading a MIDI with those.
// - It does not support MIDI files with more than 0xFFFFFFFF (4,294,967,295) ticks.
// - The reported data is very barebones and doesn't use strings. You can check for `type`:
//   * 0x09 = Note On  | (these two have `channel`, `note` and `velocity`.)
//   * 0x08 = Note Off | (all integers, of course.)
//   * 0x0B = Control Change (has `ccNum` and `ccValue`). Only CC #64 (sustain) is processed.
//   * 0xFF with metaType 0x51 = Set Tempo (has `uspq`: microseconds per quarter note)
//   * 0xFF with metaType 0x2F = End of Track
// - All other events are ignored during parsing.
// - It WILL report a zero-velocity Note On as a Note On! That is intentional.
// - It has seeking capability via `.seek(tick)`, but it's 'dumb': it does not keep track
//   of active events, which may result in 'stuck' notes.
//
// The API is pretty simple:
// * Load with either `.loadFile(path)` or `.loadArrayBuffer(arrbuf)`. (async!)
// * Loading is multithreaded and will take up all available threads minus one. You can adjust
//   that by setting `.parseThreads`.
// * You can also monitor the loading progress by checking `.tracksParsed` against `.trackCount`.
// * The load function will return an array with two values: time taken to read into a usable
//   buffer, and time taken actually parsing the data. Both values are in milliseconds.
// * Control playback with `.play()`, `.pause()` and `.stop()`.
// * Listen to the `midiEvent` events.
// * You can also adjust the playback speed multiplier by writing to `.playbackSpeed`.
// * There's also a bunch of read-only getters defined at the bottom that you can use to extract
//   playback data.
//
// Good luck. [insert the MIT 'no warranty' clause here]



import EventEmitter from 'node:events';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEADER_LENGTH = 14;
const DEFAULT_TEMPO = 500000; // 120 bpm / 500ms/qn
const EVENT_SIZE = 8;
const EVENT_CODE = { NOTE_ON: 0x09, NOTE_OFF: 0x08, CONTROL_CHANGE: 0x0B, SET_TEMPO: 0x51, END_OF_TRACK: 0x2F };

class Player extends EventEmitter {
	// midi properties
	#format;
	#numTracks;
	#ppqn;
	#trackOffsets = [];
	#tempoEvents = [];

	// playback state
	#isPlaying = false;
	#currentTick = 0;
	#currentTempo = DEFAULT_TEMPO;
	#trackEventPointers = [];
	#playLoopInterval = null;
	#startTick = 0;
	#startTime = 0;
	#sampleRate = 5; // ms

	// loading state & file data
	#isLoading = false;
	#tracksParsed = 0;
	#totalEvents = 0;
	#totalTicks = 0;
	#songTime = 0;
	#tracks = [];
	#midiChunksByteLength = 0;

	// configurable properties
	#playbackSpeed = 1; // multiplier
	parseThreads; // accessed directly

	constructor() {
		super();

		this.parseThreads = Math.max(1, os.availableParallelism() - 1); // leave a thread for main
		this.setMaxListeners(this.parseThreads * 2);
	}

	#load(buffer, readTime) {
		return new Promise((resolve, reject) => {
			const start = performance.now();
			try {
				// reset state
				this.unload();
				this.#isLoading = true; // re-set the flag

				const buf = Buffer.from(buffer);

				// HEADER

				// sanity check: valid midi?
				const magic = buf.readUint32BE(0);
				if (magic !== 0x4d546864) { // MThd
					throw new Error(`Invalid MIDI magic! Expected 4d546864, got ${magic.toString(16).padStart(8, '0')}.`);
				}

				const length = buf.readUint32BE(4);
				if (length !== 6) {
					throw new Error(`Invalid header length! Expected 6, got ${length}.`);
				}

				this.#format = buf.readUint16BE(8);
				this.#numTracks = buf.readUint16BE(10);
				this.#tracks.length = this.#numTracks;

				if (this.#format === 0 && this.#numTracks > 1) {
					throw new Error(`Invalid track count! Format 0 MIDIs should only have 1 track, got ${this.#numTracks}.`);
				}

				if (this.#format >= 2) {
					throw new Error(`Unsupported MIDI format: ${this.#format}.`);
				}

				this.#ppqn = buf.readUint16BE(12);

				if (this.#ppqn === 0) {
					throw new Error(`Invalid PPQN/division value!`);
				}

				if ((this.#ppqn & 0x8000) !== 0) {
					throw new Error(`SMPTE timecode format is not supported!`);
				}

				// TRACK OFFSETS

				this.#trackOffsets = new Array(this.#numTracks);
				let currentOffset = HEADER_LENGTH;

				for (let i = 0; i < this.#numTracks; ++i) {
					if (currentOffset >= buf.length) {
						throw new Error(`Reached EOF while looking for track ${i}. Tracks reported in header: ${this.#numTracks}.`);
					}

					const trackMagic = buf.readUint32BE(currentOffset);

					if (trackMagic !== 0x4d54726b) { // MTrk
						throw new Error(`Invalid track ${i} magic! Expected 4d54726b, got ${trackMagic.toString(16).padStart(8, '0')}.`);
					}

					const trackLength = buf.readUint32BE(currentOffset + 4);
					this.#trackOffsets[i] = currentOffset;
					currentOffset += trackLength + 8;
				}
				this.#midiChunksByteLength = currentOffset;

				// SPAWN WORKERS

				this.#totalTicks = 0;
				this.#tracksParsed = 0;

				const tracksWithSize = this.#trackOffsets.map((offset, index) => ({ index, length: buf.readUint32BE(offset + 4)}));
				tracksWithSize.sort((a, b) => b.length - a.length);

				const numWorkers = Math.min(this.parseThreads, this.#numTracks);
				let workersFinished = 0;

				const workerTrackIndices = Array.from({ length: numWorkers }, () => ([]));
				const workerLoads = new Array(numWorkers).fill(0);

				for (const track of tracksWithSize) {
					let minLoad = Infinity;
					let minIndex = -1;
					for (let i = 0; i < numWorkers; ++i) {
						if (workerLoads[i] < minLoad) {
							minLoad = workerLoads[i];
							minIndex = i;
						}
					}

					workerTrackIndices[minIndex].push(track.index);
					workerLoads[minIndex] += track.length;
				}

				for (let i = 0; i < numWorkers; ++i) {
					const trackIndices = workerTrackIndices[i];

					if (trackIndices.length === 0) continue;

					const worker = new Worker(path.resolve(__dirname, 'threads/parser.js'), {
						workerData: {
							buffer: buffer,
							trackIndices,
							trackOffsets: this.#trackOffsets
						}
					});

					// if a worker errors out, kill the rest
					const terminateWorker = () => {
						if (worker.active) worker.terminate();
					}

					this.on('terminateWorkers', terminateWorker);

					worker.on('online', () => worker.active = true);

					worker.on('message', t => {
						this.#tracks[t.trackIndex] = {
							packedBuffer: t.packedBuffer,
							eventCount: t.packedBuffer ? t.packedBuffer.byteLength / EVENT_SIZE : 0,
							view: t.packedBuffer ? new DataView(t.packedBuffer) : null
						};
						this.#totalTicks = Math.max(this.#totalTicks, t.totalTicks);
						this.#tempoEvents.push(t.tempoEvents);
						++this.#tracksParsed;
					});

					worker.on('error', e => {
						this.unload();
						reject(e);
					});

					worker.on('exit', code => {
						this.off('terminateWorkers', terminateWorker);
						worker.removeAllListeners();
						worker.active = false;
						if (!this.#isLoading) return; // error cascade

						if (code !== 0) {
							this.unload();
							reject(new Error(`Worker stopped with exit code ${code}.`));
							return;
						}

						++workersFinished;

						if (workersFinished === numWorkers) {
							this.#isLoading = false;
							this.#tempoEvents = this.#tempoEvents.flat();
							this.#calculateSongTime();
							this.#totalEvents = this.#tracks.map(t => t?.eventCount || 0).reduce((a,b) => a + b, 0);
							this.emit('fileLoaded');
							buffer = null;
							resolve([readTime, performance.now() - start]);
						}
					});
				}
			} catch (e) {
				this.unload();
				reject(e);
			}
		});
	}

	async loadFile(filePath) {
		const start = performance.now();
		this.#isLoading = true;
		// node.js (libuv) has a 2 GiB I/O limit, so readFile would break here.
		// instead, we have to jump through hoops with ReadStreams.
		const fileHandle = await fs.promises.open(filePath);
		const stats = await fileHandle.stat();
		const buffer = new SharedArrayBuffer(stats.size);
		const view = Buffer.from(buffer);

		let i = 0;
		for await (const chunk of fileHandle.createReadStream()) {
			view.set(chunk, i);
			i += chunk.byteLength;
		}

		await fileHandle.close();

		return this.#load(buffer, performance.now() - start);
	}

	async loadArrayBuffer(arrbuf) {
		const start = performance.now();
		this.#isLoading = true;
		let buffer;
		if (arrbuf instanceof SharedArrayBuffer) {
			buffer = arrbuf;
		} else {
			buffer = new SharedArrayBuffer(arrbuf.byteLength);
			new Uint8Array(buffer).set(new Uint8Array(arrbuf))
		}

		return this.#load(buffer, performance.now() - start);
	}

	unload() {
		if (this.#isLoading) {
			this.#isLoading = false;
			this.emit('terminateWorkers');
		}

		this.stop();

		this.#format = null;
		this.#numTracks = 0;
		this.#ppqn = null;
		this.#tracks = [];
		this.#trackOffsets = [];
		this.#tempoEvents = [];

		this.#tracksParsed = 0;
		this.#totalEvents = 0;
		this.#totalTicks = 0;
		this.#songTime = 0;
		this.#midiChunksByteLength = 0;

		this.#currentTempo = DEFAULT_TEMPO / this.#playbackSpeed;
		this.#trackEventPointers = [];

		if (global.gc) global.gc();

		this.emit('unloaded');
	}

	play() {
		if (this.#isPlaying) return;
		if (this.#isLoading) return;
		if (this.#tracks.length === 0) throw new Error('No MIDI data loaded.');

		this.#isPlaying = true;

		if (this.#currentTick === 0) { // fresh start
			this.#currentTempo = DEFAULT_TEMPO / this.#playbackSpeed;
			this.#trackEventPointers = new Array(this.#numTracks).fill(0);
		}

		this.emit('play');

		this.#startTime = performance.now();
		this.#playLoopInterval = setInterval(this.#playLoop.bind(this), this.#sampleRate);
	}

	pause() {
		if (!this.#isPlaying) return;

		this.#isPlaying = false;
		clearInterval(this.#playLoopInterval);
		this.#playLoopInterval = null;

		this.#startTick = this.getCurrentTick();
		this.#startTime = 0;

		this.emit('pause');
	}

	stop() {
		if (!this.#isPlaying && this.#currentTick === 0) return;

		this.#isPlaying = false;
		clearInterval(this.#playLoopInterval);
		this.#playLoopInterval = null;

		const needsEmit = this.#currentTick > 0;

		this.#currentTick = 0;
		this.#startTick = 0;
		this.#startTime = 0;
		this.#currentTempo = DEFAULT_TEMPO / this.#playbackSpeed;

		if (needsEmit) this.emit('stop');
	}

	seek(tick) {
		if (this.#isLoading || this.#tracks.length === 0) return;

		tick = Math.min(Math.max(0, tick), this.#totalTicks);
		if (Number.isNaN(tick)) return;

		const wasPlaying = this.#isPlaying;
		if (wasPlaying) this.pause();

		// binary search for tempo
		if (this.#tempoEvents.length > 0) {
			let low = 0;
			let high = this.#tempoEvents.length - 1;

			let bestMatch = -1;

			while (low <= high) {
				const mid = Math.floor(low + (high - low) / 2);
				if (this.#tempoEvents[mid].tick <= tick) {
					bestMatch = mid;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			}

			this.#currentTempo = ((bestMatch !== -1) ? this.#tempoEvents[bestMatch].uspq : DEFAULT_TEMPO) / this.#playbackSpeed;
		}

		// find event ptr for each track
		for (let i = 0; i < this.#numTracks; ++i) {
			this.#trackEventPointers[i] = this.#findNextEventIndex(i, tick);
		}

		this.#currentTick = tick;
		this.#startTick = tick;
		// #startTime will be set by play()

		this.emit('seek', { tick });

		if (wasPlaying) this.play();
	}

	#findNextEventIndex(trackIndex, tick) {
		const track = this.#tracks[trackIndex];
		if (track.eventCount === 0) return 0;

		// binary search for event ptr
		let low = 0;
		let high = track.eventCount;

		while (low < high) {
			const mid = Math.floor(low + (high - low) / 2);
			const eventTick = track.view.getUint32(mid * EVENT_SIZE);

			if (eventTick < tick) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}
		return low;
	}

	// this is the best solution i could think of that
	// (a) doesn't block the event loop and
	// (b) doesn't slow the playback down like crazy
	// could use setImmediate, but i think 200hz update is good enough
	#playLoop() {
		if (!this.#isPlaying) {
			clearInterval(this.#playLoopInterval);
			this.#playLoopInterval = null;
			return;
		}

		this.#currentTick = this.getCurrentTick();

		if (this.#tracks.every((track, i) => this.#trackEventPointers[i] >= track.eventCount) || this.#currentTick > this.#totalTicks) {
			this.stop();
			this.emit('endOfFile');
			return;
		}

		for (let i = 0; i < this.#tracks.length; ++i) {
			const track = this.#tracks[i];
			if (!track) continue;

			let ptr = this.#trackEventPointers[i];

			while (ptr < track.eventCount && track.view.getUint32(ptr * EVENT_SIZE) <= this.#currentTick) {
				const eventOffset = ptr * EVENT_SIZE;
				const eventTick = track.view.getUint32(eventOffset);
				const eventData = track.view.getUint32(eventOffset + 4);
				const eventTypeCode = eventData >> 24;
				const event = { tick: this.#currentTick };

				switch (eventTypeCode) {
					case EVENT_CODE.NOTE_ON:
					case EVENT_CODE.NOTE_OFF:
						event.type     = eventTypeCode;
						event.channel  = (eventData >> 16) & 0xFF;
						event.note     = (eventData >> 8)  & 0xFF;
						event.velocity = (eventData)       & 0xFF;
						break;
					case EVENT_CODE.CONTROL_CHANGE:
						event.type     = 0x0B;
						event.channel  = (eventData >> 16) & 0xFF;
						event.ccNum    = (eventData >> 8)  & 0xFF;
						event.ccValue  = (eventData)       & 0xFF;
						break;
					case EVENT_CODE.SET_TEMPO:
						event.type     = 0xFF;
						event.metaType = 0x51;
						event.uspq     = eventData & 0xFFFFFF;
						break;
					case EVENT_CODE.END_OF_TRACK:
						event.type     = 0xFF;
						event.metaType = 0x2F;
						break;
					default:
						// in theory this should never happen unless someone messed with the worker
						throw new Error(`Unknown event type ${eventTypeCode}! Worker returned corrupted buffer?`);
						break;
				}

				this.emit('midiEvent', event);

				if (eventTypeCode === EVENT_CODE.SET_TEMPO) {
					// re-anchor to prevent accidental time jumps
					// requires some adjustment since we're not perfectly on-tick
					const oldTempo = this.#currentTempo * this.#playbackSpeed;
					const msAfterTempoEvent = ((this.#currentTick - eventTick) * (oldTempo / 1000)) / this.#ppqn;

					this.#startTick = eventTick;
					this.#startTime = performance.now() - msAfterTempoEvent;
					this.#currentTempo = event.uspq / this.#playbackSpeed;
				}

				++this.#trackEventPointers[i];
				ptr = this.#trackEventPointers[i];
			}
		}
	}

	#calculateSongTime() {
		this.#tempoEvents.sort((a, b) => a.tick - b.tick);

		const tempoMap = [{ tick: 0, uspq: DEFAULT_TEMPO }];

		for (const event of this.#tempoEvents) {
			const lastTempo = tempoMap[tempoMap.length - 1];
			if (event.tick === lastTempo.tick) {
				lastTempo.uspq = event.uspq;
			} else {
				tempoMap.push(event);
			}
		}

		let totalMs = 0;

		for (let i = 0; i < tempoMap.length; ++i) {
			const currentTempo = tempoMap[i].uspq;

			const nextTick = (i < tempoMap.length - 1) ? tempoMap[i + 1].tick : this.#totalTicks;
			const ticksInSegment = nextTick - tempoMap[i].tick;

			if (ticksInSegment > 0) totalMs += (ticksInSegment * (currentTempo / 1000)) / this.#ppqn;
		}

		this.#songTime = totalMs / 1000;
	}

	getCurrentTick() {
		if (!this.#startTime) return this.#startTick;

		const tpms = this.#ppqn / (this.#currentTempo / 1000);
		const ms = performance.now() - this.#startTime;

		return Math.round(tpms * ms) + this.#startTick;
	}

	get isLoading() {
		return this.#isLoading;
	}

	get isPlaying() {
		return this.#isPlaying;
	}

	get trackCount() {
		return this.#numTracks;
	}

	get tracksParsed() {
		return this.#tracksParsed;
	}

	get songTime() {
		return this.#songTime;
	}

	get ppqn() {
		return this.#ppqn;
	}

	get currentTempo() {
		// technically inaccurate, but for 'accuracy' i have to read the Time Signature event.
		// this will have to do.
		return 60_000_000 / this.#currentTempo;
	}

	get totalEvents() {
		return this.#totalEvents;
	}

	get totalTicks() {
		return this.#totalTicks;
	}

	get tracks() {
		return this.#tracks;
	}

	get playbackSpeed() {
		return this.#playbackSpeed;
	}

	set playbackSpeed(speed) {
		speed = +speed;
		if (Number.isNaN(speed)) throw new Error('Playback speed must be a valid number!');
		if (speed <= 0) throw new Error('Playback speed must be a positive number!');

		const oldSpeed = this.#playbackSpeed;
		if (speed === oldSpeed) return;

		this.#playbackSpeed = speed;

		if (this.isPlaying) {
			const tick = this.getCurrentTick();

			this.#currentTempo = (this.#currentTempo * oldSpeed) / speed;

			// re-anchor to prevent time jumps
			this.#startTick = tick;
			this.#startTime = performance.now();
		}
	}
}

export {
	Player
};