# Visual assets and texture sources

The texture images are included locally to avoid external requests during rendering. The five original Earth maps are 4096 × 2048 pixels. Credit and ownership of the imagery remain with their respective creators; no exclusive ownership of third-party imagery is claimed.

The website posters `public/site/earth.png`, `mars.png`, and `saturn.png` are original 900 × 900 transparent screenshots of this application's planet renderer using the textures listed below. They retain the underlying imagery credits and applicable licenses; they are not additional stock imagery. The site background uses the same `milky-way-4k.jpg` panorama. The deployed website includes this document and `THIRD_PARTY_NOTICES.md` under `legal/`.

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
| `mercury-real.jpg` (stage 04, replaced in stage 06) | 2048 × 1024 | Solar System Scope, `static/textures/2k_mercury.jpg` in [yamansdev/three.js-solar-system](https://github.com/yamansdev/three.js-solar-system) | CC BY 4.0; unchanged |
| `mars-real.jpg` (stage 04, replaced in stage 06) | 2048 × 1024 | Solar System Scope, `static/textures/2k_mars.jpg`, same source | CC BY 4.0; unchanged |
| `jupiter-real.jpg` | 4096 × 2048 | Askaniy Anpilogov; NASA/JPL-Caltech/SSI/SWRI/MSSS/ASI/INAF/JIRAM; Björn Jónsson, [CelestiaContent](https://github.com/CelestiaProject/CelestiaContent), `textures/hires/jupiter.jpg` | CC BY 3.0; JPEG re-encoded at quality 92 |
| `saturn-real.jpg` | 4096 × 2048 | Askaniy Anpilogov; NASA/JPL-Caltech; Björn Jónsson, CelestiaContent, `textures/hires/saturn.jpg` | CC BY 3.0; unchanged |
| `neptune-real.jpg` | 4096 × 2048 | Askaniy Anpilogov; NASA/JPL-Caltech; Björn Jónsson; Karkoschka, E. (1994), CelestiaContent, `textures/hires/neptune.jpg` | CC BY 3.0; unchanged |
| `venus-real.jpg` (stage 04, replaced in stage 06) | 512 × 256 | Oleg Pluton (Helleformer), [Stellarium](https://github.com/Stellarium/stellarium), `textures/venus.png` | CC BY 4.0; converted to JPEG |
| `uranus-real.jpg` (stage 04, replaced in stage 06) | 512 × 256 | Oleg Pluton (Helleformer), Stellarium, `textures/uranus.png` | CC BY 4.0; converted to JPEG |
| `sun-real.jpg` | 4096 × 2048 | Ruslan Kabatsayev; NASA/SDO HMI, Stellarium, `textures/sun.webp` | CC BY-SA 4.0; resized from 8K and converted to JPEG; this adapted image retains CC BY-SA 4.0 |

Retrieved on 2026-10-02 through normal HTTPS Git access. Source revisions:

- Whitebee7/solarsystem: `235e72c02e825e0c8d0792ec0aa6be43e1a14f68`; its `LICENSE-textures.md` identifies Solar System Scope's [CC BY 4.0 texture license](https://www.solarsystemscope.com/textures/).
- yamansdev/three.js-solar-system: `1a73e2921da8a7d8659ed159592932f8ce7a1d67`; its panorama is byte-identical to the licensed mirror above.
- CelestiaProject/CelestiaContent: `3ed5836133901114a9cb4a2ea35751b274a464a1`; each of the three included maps has an individual `.license` file with the credits and CC BY 3.0 identifier. The noncommercial Uranus map from this repository is not included.
- Stellarium/stellarium: `f57342271c6047774f3b25991ba494600301c709`; `CREDITS.md` sections 4.3c and 4.3o specify the Venus/Uranus and Sun map credits and licenses.

Exact source URLs, changes, pixel dimensions, original SHA-256 checksums and delivered SHA-256 checksums are recorded in [public/textures/provenance.json](public/textures/provenance.json). Stage 06 below replaces the stage 04 Mercury, Mars, Venus and Uranus maps.

License links: [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Attribution and these links accompany the standalone package in this file and `THIRD_PARTY_NOTICES.md`. Original authors do not endorse this game.

## Generated geometry and rendering

The seeded 128 × 128 terrain grain/bump texture is generated locally from original code; no additional downloaded assets are used. Atmospheric shells, Saturn's rings and analytic shadows, solar prominences, spacecraft geometry, UI, and warp tunnel effects are original generated geometry/shaders. Venus's cloud switch reveals a procedural illustration of its normally obscured surface. Cloud motion, exposure, and illumination are simplified; maps combine observations/artwork from different dates and are not live imagery.

Flight uses real mean radii and mean Sun distances in kilometres, with double-precision positions and a floating render origin. Planetary directions are a fixed illustrative layout, not an ephemeris. The observer fits each individual body into its own view. Propulsion, shields and faster-than-light travel are fictional gameplay; near-surface gravity is simplified and full orbit integration is not implemented.

## Stage 06: high-resolution maps for every body

Every planet, moon, star and exoplanet now has an equirectangular surface map. **Observed** maps are global mosaics built from spacecraft or telescope imagery of that body. **Concept** maps are openly licensed artwork used where no global imagery exists (Neptune's small inner moons, Nereid) or for bodies that have never been imaged (the Alpha Centauri stars and Proxima's planets); they are tinted and offset per body and are not presented as photographs. Earth keeps its original deep-blue Blue Marble day map and other Earth layers unchanged.

| Local file | Used for | Size | Kind | Credit | License |
| --- | --- | --- | --- | --- | --- |
| `mercury-real.jpg` | Mercury | 4096 × 2048 | observed | Solar System Scope (8k_mercury.jpg downscaled to 4096 px by the mirror) | CC BY 4.0 |
| `venus-real.jpg` | Venus cloud tops | 4096 × 2048 | observed | Solar System Scope (4k_venus_atmosphere.jpg) | CC BY 4.0 |
| `mars-real.jpg` | Mars | 4096 × 2048 | observed | Solar System Scope (8k_mars.jpg, byte-identical upstream) | CC BY 4.0 |
| `uranus-real.jpg` | Uranus | 2048 × 1024 | observed | Solar System Scope (2k_uranus.jpg; no larger openly licensed map) | CC BY 4.0 |
| `moon-real.jpg` | Moon | 4096 × 2048 | observed | Solar System Scope (8k_moon.jpg, byte-identical upstream) | CC BY 4.0 |
| `io-real.jpg` | Io | 4096 × 2048 | observed | ItzImcool; NASA/JPL-Caltech/ASI/USGS; NASA/JPL/SwRI/MSSS/Gerald Eichstädt/Jason Perry/John Rogers; AstroChara | CC BY 4.0 |
| `europa-real.jpg` | Europa | 4096 × 2048 | observed | John van Vliet; NASA/JPL Galileo and Voyager imagery | Celestia legacy texture, see note |
| `ganymede-real.jpg` | Ganymede | 4096 × 2048 | observed | Askaniy Anpilogov; NASA/JPL-Caltech/ASI/USGS; NASA/JPL-Caltech/Björn Jónsson; NASA/JPL-Caltech/SwRI/MSSS/Brian Swift | CC BY 3.0 |
| `callisto-real.jpg` | Callisto | 4096 × 2048 | observed | Askaniy Anpilogov from John van Vliet; NASA/JPL Galileo and Voyager imagery | Celestia legacy texture, see note |
| `mimas-real.jpg` | Mimas | 4096 × 2048 | observed | Celestia, from Paul Schenk's enhanced-colour Cassini map (NASA/JPL/LPI Photojournal) | Celestia legacy texture, see note |
| `enceladus-real.jpg` | Enceladus | 4096 × 2048 | observed | Celestia, from Paul Schenk's enhanced-colour Cassini map (NASA/JPL/LPI Photojournal) | Celestia legacy texture, see note |
| `tethys-real.jpg` | Tethys | 4096 × 2048 | observed | Celestia, from Paul Schenk's enhanced-colour Cassini map (NASA/JPL/LPI Photojournal) | Celestia legacy texture, see note |
| `dione-real.jpg` | Dione | 4096 × 2048 | observed | Celestia, from Paul Schenk's enhanced-colour Cassini map (NASA/JPL/LPI Photojournal) | Celestia legacy texture, see note |
| `rhea-real.jpg` | Rhea | 4096 × 2048 | observed | Celestia, from Björn Jónsson's albedo map and NASA/JPL Cassini data (Paul Schenk) | Celestia legacy texture, see note |
| `titan-real.jpg` | Titan | 4096 × 2048 | observed | Askaniy Anpilogov, Pedro Garcia, AstroChara; NASA/JPL-Caltech/ASI/USGS; Caltech-JPL/Univ. of Arizona/LPG Nantes-CNRS | CC BY 3.0 |
| `hyperion-real.jpg` | Hyperion | 2048 × 1024 | observed | ItzImcool | CC BY 4.0 |
| `iapetus-real.jpg` | Iapetus | 4096 × 2048 | observed | Celestia, from Paul Schenk's enhanced-colour Cassini map (NASA/JPL/LPI Photojournal) | Celestia legacy texture, see note |
| `miranda-real.jpg` | Miranda | 4096 × 2048 | observed | ItzImcool; Paul Schenk (2020); NASA/JPL/Ted Stryk | CC BY-SA 4.0 |
| `ariel-real.jpg` | Ariel | 4096 × 2048 | observed | ItzImcool; Paul Schenk (2020); NASA/JPL/Ted Stryk | CC BY-SA 4.0 |
| `umbriel-real.jpg` | Umbriel | 2048 × 1024 | observed | ItzImcool; Paul Schenk (2020); Phil Stooke (2006); NASA/JPL/Ted Stryk | CC BY-SA 4.0 |
| `titania-real.jpg` | Titania | 2048 × 1024 | observed | ItzImcool; Paul Schenk (2020); NASA/JPL/Ted Stryk | CC BY-SA 4.0 |
| `oberon-real.jpg` | Oberon | 2048 × 1024 | observed | ItzImcool; Paul Schenk (2020); NASA/JPL/Ted Stryk | CC BY-SA 4.0 |
| `triton-real.jpg` | Triton | 4096 × 2048 | observed | Askaniy Anpilogov; NASA/JPL-Caltech/ASI/USGS | CC BY 3.0 |
| `concept-asteroid.jpg` | Naiad, Thalassa, Despina, Galatea, Larissa, Proteus | 4096 × 2048 | concept | cubicApocalypse (fictional asteroid texture) | CC BY 4.0 |
| `concept-haumea.jpg` | Nereid | 4096 × 2048 | concept | Solar System Scope (4k_haumea_fictional.jpg) | CC BY 4.0 |
| `star-g.jpg` | Alpha Centauri A | 4096 × 2048 | concept | MrSpace43; AstroChara; NASA/SDO and the AIA, EVE and HMI science teams | CC BY-SA 4.0 |
| `star-k.jpg` | Alpha Centauri B | 4096 × 2048 | concept | MrSpace43; AstroChara; NASA/SDO and the AIA, EVE and HMI science teams | CC BY-SA 4.0 |
| `star-m.jpg` | Proxima Centauri | 4096 × 2048 | concept | Askaniy Anpilogov (2025) | CC BY 3.0 |
| `concept-makemake.jpg` | Proxima b | 4096 × 2048 | concept | Solar System Scope (4k_makemake_fictional.jpg) | CC BY 4.0 |
| `concept-ceres.jpg` | Proxima d | 4096 × 2048 | concept | Solar System Scope (4k_ceres_fictional.jpg) | CC BY 4.0 |
| `concept-venuslike.jpg` | Proxima c | 4096 × 2048 | concept | cubicApocalypse (fictional cloud-world texture) | CC BY 4.0 |

Notes:

- Solar System Scope textures are licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The 8K Moon and Mars originals were retrieved from a GitHub mirror and verified byte-identical to the published upstream SHA-256; they are resized to 4096 × 2048. Mercury comes from a mirror that ships the upstream 8K map downscaled to 4096 px. Solar System Scope publishes Uranus only at 2K, and the only larger Uranus map found (CelestiaContent) is non-commercial, so Uranus stays at 2048 × 1024.
- Maps marked "Celestia legacy texture" have no per-file SPDX license in [CelestiaContent](https://github.com/CelestiaProject/CelestiaContent). Celestia's README credits Paul Schenk's enhanced-colour Cassini maps from the NASA Photojournal (Mimas, Enceladus, Tethys, Dione, Rhea, Iapetus; Rhea also uses Björn Jónsson's albedo map) and John van Vliet (Europa, and the source of Askaniy Anpilogov's Callisto). These textures were distributed with Celestia under GPL-2.0-or-later, and the underlying NASA/JPL imagery is used under the [JPL Image Use Policy](https://www.jpl.nasa.gov/jpl-image-use-policy). They are listed separately so they can be swapped if a stricter licence review requires it.
- Voyager 2 imaged only one hemisphere of Miranda, Ariel, Umbriel, Titania, Oberon and Triton. The source maps fill the rest with flat grey; `scripts/prepare-body-textures.py` replaces that placeholder with a mirrored, longitude-shifted copy of imaged terrain and a soft blend. These filled hemispheres are illustrations, not observations.
- The Alpha Centauri star maps are concept textures derived from NASA/SDO solar imagery (CC BY-SA 4.0) and an original M-dwarf texture (CC BY 3.0); the game uses only their luminance and colours them by each star's temperature.
- JPEG re-encoding (quality 85) keeps the standalone package under 50 MB. Exact source URLs (pinned Git revisions), changes, pixel sizes and SHA-256 checksums of sources and delivered files are in [public/textures/provenance.json](public/textures/provenance.json). Run `python3 scripts/prepare-body-textures.py` (Python, NumPy, Pillow) to download, verify and rebuild them.
- Retrieved on 2026-10-03 through normal HTTPS access to GitHub: CelestiaContent `57daa0d8d33d4799a721c496de62f019e335f625`, Whitebee7/solarsystem `235e72c02e825e0c8d0792ec0aa6be43e1a14f68`, renoultdavid/textures `68b6d34056efb1065207f0b5e139d5998cc0a575`, 7ohnkuu/universe `200f5667391eb512a032e20b00bf41887eadc2b9`.

Rendering: magnified maps use cubic B-spline filtering and seam-aware texture gradients, relief normals are differenced in texture space, and procedural sub-texel grain fades in only beyond a map's native resolution. This adds apparent detail without claiming more source resolution. Until a moon, star or exoplanet map has loaded, the original procedural material is shown and the map fades in.

## Alpha Centauri system artwork

`centauri-milky-way-4k.jpg` is an original 4096 × 2048 spherical sky illustration generated by [scripts/generate-centauri-sky.py](scripts/generate-centauri-sky.py), with a seeded blue-violet galactic band, dark dust lanes and star points. It is a separate asset, not a recolour of the Solar System panorama, and is **not an observed or astrometrically accurate sky map**. Alpha Centauri and Proxima share this system artwork with different sky orientations. Dimensions and SHA-256 are in the provenance manifest.

Alpha Centauri A/B, Proxima and Proxima b, c and d use the stage 06 concept maps, coloured by temperature or tinted; their original procedural shaders remain only as the loading fallback. The planets' radii, atmosphere and visible surface are illustrative game choices, not measured images; c/d are explicitly labelled as candidates. Stellar sizes, approximate Sun distances, binary mean separation and orbital periods provide scale, with a static illustrative layout and fictional faster-than-light travel.
