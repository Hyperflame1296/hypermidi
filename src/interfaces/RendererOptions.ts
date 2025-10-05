interface RendererOptions {
    /**
     * The number of threads to use for rendering.
     * Default is `8`.
     */
    threadCount?: number
    /**
     * The audio sample rate in Hz.  
     * Default is `48000`.
     */
    sampleRate?: number
    /**
     * Enable control change (CC) processing.  
     * Default is `true`.
     */
    enableCC?: boolean
    /**
     * The size of audio buffers used during rendering, in samples.  
     * Larger buffer sizes may improve performance but decrease accuracy.  
     * Default is `512`.
     */
    audioBufferSize?: number
    /**
     * Chorus effect settings.
     */
    chorus?: {
        /**
         * Enable chorus effect.
         * Default is `true`.
         */
        enabled?: boolean 
        /**
         * Chorus rate in Hz.
         * Default is `0.8`.
         */
        rate?: number
        /**
         * Chorus depth in seconds.
         * Default is `0.006` (6ms).
         */
        depth?: number
        /**
         * Chorus wet/dry mix, from `0.0` (dry only) to `1.0` (wet only).
         * Default is `0.5`.
         */
        mix?: number
    }
    /**
     * Logging options.
     */
    logging?: {
        /**
         * Log general info messages.
         * Default is `false`.
         */
        info?: boolean
        /**
         * Log warning messages.
         * Default is `true`.
         */
        warn?: boolean
        /**
         * Log error messages.
         * Default is `true`.
         */
        error?: boolean
    }
}
export { 
    RendererOptions 
}