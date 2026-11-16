# Sound Atlas visual redesign

## Design read
Architectural sound observatory for public exhibition and research presentations. Soft structuralism with an editorial split: a matte architectural plate, an instrument-like live-reading rail, then spacious temporal analysis and evidence-based daily notes.

DESIGN_VARIANCE: 8; MOTION_INTENSITY: 4; VISUAL_DENSITY: 3.

## Existing audit
- Existing brand: orange sound-wave mark, 声场 / SOUND ATLAS, Instrument Sans with Chinese UI fallback.
- Existing page: centered heading, large rectangular model panel, repeated readout cards, stacked analysis blocks.
- Preserve: brand, anchors and route slugs, navigation labels, real CAD geometry, 6 physical devices, data-source controls, dark/light preference, all acquisition and calibration behavior, all keyboard and empty-data states.
- Retire: repeated card borders and six boxed numeric tiles, miniature text, visually undifferentiated long page.

## New composition
1. SPACE: model is the main plate; precise live readings, device choices and legend share a right-side instrument rail. The main timeline stays below the plate.
2. TIME: a dedicated analysis chapter, with six aligned sound traces by default and a precise overlaid-curve alternative. Both use identical dB scales and keep missing intervals blank. The existing independent fullscreen remains available.
3. DAILY: large type for the actual insight; quiet dividers organize comparisons, peaks, and data coverage.

## Tokens and behavior
- Ink and silver surfaces, signal orange as the UI accent; categorical chart colors retain device identity.
- Self-hosted Manrope for Latin/numerals, Chinese system sans fallback. No external font requests.
- Rounded physical shells at 28 px, pill actions, unboxed data lists. Thin separators only for tabular structure.
- Motion only on opacity/transform, brief and reduced-motion aware. No fake sound waves or perpetual animation.
- Default dark for new users; explicitly saved light/dark preference wins.
- Do not replace real missing observations with illustration data.
