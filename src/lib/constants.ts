/**
 * =============================================================================
 * CONSTANTS
 * =============================================================================
 *
 * Shared constants used throughout the application.
 */

/** Default Strudel code shown when the editor first loads */
export const DEFAULT_CODE = `// Welcome to klaude - name your layers and the console picks them up
setcpm(120/4)

const drums = s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909")
const bass = note("<c2 eb2 f2 g2>").s("sawtooth").lpf(400).lpenv(2)

$: layers({ drums, bass })
`
