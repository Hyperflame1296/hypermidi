interface RendererOptions {
    sampleRate?: number; // in Hz, default 48000
    enableCC?: boolean; // enable control change (CC) processing, default true
    chorus?: {
        rate: number;  // in Hz, default 0.8
        depth: number; // in seconds, default 0.006 (6ms)
        mix: number;   // wet/dry mix, 0.0 to 1.0, default 0.5
    }
    logging?: {
        info: boolean; // log general info, default false
        warn: boolean; // log warnings, default true
        error: boolean; // log errors, default true
    }
}
export { 
    RendererOptions 
}