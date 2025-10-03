interface RendererOptions {
    sampleRate?: number; // in Hz, default 48000
    logging?: {
        info: boolean; // log general info, default false
        warn: boolean; // log warnings, default true
        error: boolean; // log errors, default true
    }
}
export { 
    RendererOptions 
}