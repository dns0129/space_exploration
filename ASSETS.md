# Visual assets and texture sources

The texture images are included locally to avoid external requests during rendering. The five original Earth maps are 4096 × 2048 pixels. Credit and ownership of the imagery remain with their respective creators; no exclusive ownership of third-party imagery is claimed.

| Local file         | Upstream file and source                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `earth-day.jpg`    | `example/img/earth-blue-marble.jpg`, [vasturiano/three-globe](https://github.com/vasturiano/three-globe), NASA Blue Marble Earth imagery |
| `earth-night.jpg`  | `example/img/earth-night.jpg`, [vasturiano/three-globe](https://github.com/vasturiano/three-globe), Earth night imagery                  |
| `earth-clouds.png` | `images/fair_clouds_4k.png`, [turban/webgl-earth](https://github.com/turban/webgl-earth), Bjorn Sandvik's WebGL Earth demonstration      |
| `earth-height.jpg` | `images/elev_bump_4k.jpg`, [turban/webgl-earth](https://github.com/turban/webgl-earth)                                                   |
| `earth-water.png`  | `images/water_4k.png`, [turban/webgl-earth](https://github.com/turban/webgl-earth)                                                       |

Retrieved on 2026-10-01, without modification, through HTTPS Git checkouts:

- `three-globe` revision `c4e4f1fc24572161bea3a4dbfc5abed78b46ee09`
- `webgl-earth` revision `7a97cb3f7ed917540d13959ad904e0116a7bffd8`

The three-globe project has an MIT license (copyright 2019 Vasco Asturiano). Its notice is reproduced in `THIRD_PARTY_NOTICES.md`. The WebGL Earth demonstration credits Bjorn Sandvik / thematicmapping.org; its repository does not include a standalone texture license.

The sky now uses a local 4096 × 2048 Milky Way panorama, replacing the generated star field. Earth uses static imagery and simplified lighting; atmospheric thickness and ocean highlights are reduced in stage 04.

## Stage 04: Milky Way and planetary imagery

The Milky Way is delivered at **4096 × 2048**, downsampled from an **8192 × 4096** original. It is a sky panorama, not a navigable three-dimensional reconstruction of the Galaxy. It retains its original artwork and astronomical appearance; it is not represented as a current scientific sky survey.

| Local file | Size | Source and credit | License / changes |
| --- | --- | --- | --- |
| `milky-way-4k.jpg` | 4096 × 2048 | Solar System Scope, `textures/8k_stars_milky_way.jpg` in [Whitebee7/solarsystem](https://github.com/Whitebee7/solarsystem) | CC BY 4.0; resized from 8K, JPEG quality 92 |
| `mercury-real.jpg` | 2048 × 1024 | Solar System Scope, `static/textures/2k_mercury.jpg` in [yamansdev/three.js-solar-system](https://github.com/yamansdev/three.js-solar-system) | CC BY 4.0; unchanged |
| `mars-real.jpg` | 2048 × 1024 | Solar System Scope, `static/textures/2k_mars.jpg`, same source | CC BY 4.0; unchanged |
| `jupiter-real.jpg` | 4096 × 2048 | Askaniy Anpilogov; NASA/JPL-Caltech/SSI/SWRI/MSSS/ASI/INAF/JIRAM; Björn Jónsson, [CelestiaContent](https://github.com/CelestiaProject/CelestiaContent), `textures/hires/jupiter.jpg` | CC BY 3.0; JPEG re-encoded at quality 92 |
| `saturn-real.jpg` | 4096 × 2048 | Askaniy Anpilogov; NASA/JPL-Caltech; Björn Jónsson, CelestiaContent, `textures/hires/saturn.jpg` | CC BY 3.0; unchanged |
| `neptune-real.jpg` | 4096 × 2048 | Askaniy Anpilogov; NASA/JPL-Caltech; Björn Jónsson; Karkoschka, E. (1994), CelestiaContent, `textures/hires/neptune.jpg` | CC BY 3.0; unchanged |
| `venus-real.jpg` | 512 × 256 | Oleg Pluton (Helleformer), [Stellarium](https://github.com/Stellarium/stellarium), `textures/venus.png` | CC BY 4.0; converted to JPEG |
| `uranus-real.jpg` | 512 × 256 | Oleg Pluton (Helleformer), Stellarium, `textures/uranus.png` | CC BY 4.0; converted to JPEG |
| `sun-real.jpg` | 4096 × 2048 | Ruslan Kabatsayev; NASA/SDO HMI, Stellarium, `textures/sun.webp` | CC BY-SA 4.0; resized from 8K and converted to JPEG; this adapted image retains CC BY-SA 4.0 |

Retrieved on 2026-10-02 through normal HTTPS Git access. Source revisions:

- Whitebee7/solarsystem: `235e72c02e825e0c8d0792ec0aa6be43e1a14f68`; its `LICENSE-textures.md` identifies Solar System Scope's [CC BY 4.0 texture license](https://www.solarsystemscope.com/textures/).
- yamansdev/three.js-solar-system: `1a73e2921da8a7d8659ed159592932f8ce7a1d67`; its panorama is byte-identical to the licensed mirror above.
- CelestiaProject/CelestiaContent: `3ed5836133901114a9cb4a2ea35751b274a464a1`; each of the three included maps has an individual `.license` file with the credits and CC BY 3.0 identifier. The noncommercial Uranus map from this repository is not included.
- Stellarium/stellarium: `f57342271c6047774f3b25991ba494600301c709`; `CREDITS.md` sections 4.3c and 4.3o specify the Venus/Uranus and Sun map credits and licenses.

Exact source URLs, changes, pixel dimensions, original SHA-256 checksums and delivered SHA-256 checksums are recorded in [public/textures/provenance.json](public/textures/provenance.json). Sizes for Venus and Uranus are stated explicitly; these low-frequency cloud maps are not advertised as 4K.

License links: [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Attribution and these links accompany the standalone package in this file and `THIRD_PARTY_NOTICES.md`. Original authors do not endorse this game.

## Generated geometry and rendering

Atmospheric shells, Saturn's rings and analytic shadows, solar prominences, spacecraft geometry, UI, and warp tunnel effects are original generated geometry/shaders. Venus's cloud switch reveals a procedural illustration of its normally obscured surface. Cloud motion, exposure, and illumination are simplified; maps combine observations/artwork from different dates and are not live imagery.

Flight uses real mean radii and mean Sun distances in kilometres, with double-precision positions and a floating render origin. Planetary directions are a fixed illustrative layout, not an ephemeris. The observer fits each individual body into its own view. Propulsion, shields and faster-than-light travel are fictional gameplay; gravity and orbit integration are not implemented.
