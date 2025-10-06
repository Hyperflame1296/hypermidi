interface RendererOptions {
    /**
     * The number of threads to use for rendering.  
     * - Defaults to `8`.
     */
    threadCount?: number
    /**
     * The audio sample rate in Hz.  
     * - Defaults to `48000`.
     */
    sampleRate?: number
    /**
     * Enable control change (CC) processing.  
     * - Defaults to `true`.
     */
    enableCC?: boolean
    /**
     * The maximum polyphony.  
     * - A value of `0` is unlimited.  
     * - Defaults to `0`.
     */
    polyphonyLimit?: number
    /**
     * The size of audio buffers used during rendering, in samples.  
     * - Larger buffer sizes may improve performance but may decrease accuracy.  
     * - Defaults to `512`.
     */
    audioBufferSize?: number
    /**
     * Chorus effect settings.
     */
    chorus?: {
        /**
         * Enable chorus effect.
         * - Defaults to `true`.
         */
        enabled?: boolean 
        /**
         * Chorus rate in Hz.
         * - Defaults to `0.8`.
         */
        rate?: number
        /**
         * Chorus depth in seconds.
         * - Defaults to `0.006` (6ms).
         */
        depth?: number
        /**
         * Chorus wet/dry mix, from `0.0` (dry only) to `1.0` (wet only).
         * - Defaults to `0.5`.
         */
        mix?: number
    }
    /**
     * Logging options.
     */
    logging?: {
        /**
         * Log general info messages.
         * - Defaults to `false`.
         */
        info?: boolean
        /**
         * Log warning messages.
         * - Defaults to `true`.
         */
        warn?: boolean
        /**
         * Log error messages.
         * - Defaults to `true`.
         */
        error?: boolean
    }
}
export { 
    RendererOptions 
}