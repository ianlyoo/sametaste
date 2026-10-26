# Scene asset credits

Every file under `public/scene/` with its source and licence. Code: three.js 0.186.1 (MIT, npm). `components/scene/receipt.ts` is this project's own port of the round-3 `receipt.js` (MIT).

## Photos (Wikimedia Commons, downloaded 2026-10-22, resized to 1280 px)

The photos are generic to a category (coffee, pasta, a salad, a produce aisle, a street); they are not photos of the places the agent names, and none shows a brand storefront.

| file | title | licence | author | source |
|---|---|---|---|---|
| `photos/latte.jpg` | Cup of coffee with latte art 2016.jpg | CC BY-SA 4.0 | Abdulrohmatt | https://commons.wikimedia.org/wiki/File:Cup_of_coffee_with_latte_art_2016.jpg |
| `photos/salad.jpg` | Salad bowl at Bröd & Salt.jpg (downloaded 2026-10-23) | CC BY-SA 4.0 | JIP | https://commons.wikimedia.org/wiki/File:Salad_bowl_at_Br%C3%B6d_%26_Salt.jpg |
| `photos/grocery.jpg` | Fruit section of a grocery store.jpg (downloaded 2026-10-23) | CC0 | Alabama Extension | https://commons.wikimedia.org/wiki/File:Fruit_section_of_a_grocery_store.jpg |
| `photos/pasta.jpg` | Tagliatelle Bolognese at restaurant We Pasta.jpg | CC BY-SA 4.0 | JIP | https://commons.wikimedia.org/wiki/File:Tagliatelle_Bolognese_at_restaurant_We_Pasta.jpg |
| `photos/pasta2.jpg` | Fusilli pasta with duck ragù at Wanda's.jpg | CC BY-SA 4.0 | JIP | https://commons.wikimedia.org/wiki/File:Fusilli_pasta_with_duck_rag%C3%B9_at_Wanda%27s.jpg |
| `photos/greenpoint.jpg` | Greenpoint - Post-Sandy - 6 (8139515778).jpg | CC BY-SA 2.0 | Kai Brinker | https://commons.wikimedia.org/wiki/File:Greenpoint_-_Post-Sandy_-_6_(8139515778).jpg |
| `photos/wburg-street2.jpg` | Williamsburg Brooklyn April 2025 092.jpg | CC BY 4.0 | Kidfly182 | https://commons.wikimedia.org/wiki/File:Williamsburg_Brooklyn_April_2025_092.jpg |
| `photos/wburg-street3.jpg` | Williamsburg Brooklyn April 2025 026.jpg | CC BY 4.0 | Kidfly182 | https://commons.wikimedia.org/wiki/File:Williamsburg_Brooklyn_April_2025_026.jpg |
| `photos/wythe.jpg` | Wythe Hotel.jpg | CC BY-SA 3.0 | Mikeyfrecks | https://commons.wikimedia.org/wiki/File:Wythe_Hotel.jpg |
| `photos/nitehawk.jpg` | Nitehawk Williamsburg.jpg | CC BY-SA 4.0 | Morgan695 | https://commons.wikimedia.org/wiki/File:Nitehawk_Williamsburg.jpg |
| `photos/elsewhere.jpg` | Genesis-owusu-elsewhere-brookyln-2023-2.jpg | CC BY 4.0 | Neuroxic | https://commons.wikimedia.org/wiki/File:Genesis-owusu-elsewhere-brookyln-2023-2.jpg |
| `photos/turnstile.jpg` | Turnstile show.jpg | CC0 | Mollystarkdean | https://commons.wikimedia.org/wiki/File:Turnstile_show.jpg |
| `photos/steak.jpg` | Steak at restaurant Vltava.jpg (downloaded 2026-10-23) | CC BY-SA 4.0 | JIP | https://commons.wikimedia.org/wiki/File:Steak_at_restaurant_Vltava.jpg |
| `photos/steak2.jpg` | Onion steak at restaurant Salve.jpg (downloaded 2026-10-23) | CC BY-SA 4.0 | JIP | https://commons.wikimedia.org/wiki/File:Onion_steak_at_restaurant_Salve.jpg |
| `photos/wine.jpg` | Wine and lights (3250236214).jpg (downloaded 2026-10-23) | CC BY 2.0 | Geoff Peters | https://commons.wikimedia.org/wiki/File:Wine_and_lights_(3250236214).jpg |
| `photos/cocktail.jpg` | Syreni Śpiew Koneser Bar.jpg (downloaded 2026-10-23) | CC BY-SA 4.0 | Syreni Śpiew Koneser | https://commons.wikimedia.org/wiki/File:Syreni_%C5%9Apiew_Koneser_Bar.jpg |
| `photos/ceviche.jpg` | Ceviche at Peru.jpg (downloaded 2026-10-23) | CC0 | ProjectManhattan | https://commons.wikimedia.org/wiki/File:Ceviche_at_Peru.jpg |
| `photos/quinoa.jpg` | Vegan Quinoa Bowl (44040185371).jpg (downloaded 2026-10-23) | CC BY 2.0 | Ella Olsson | https://commons.wikimedia.org/wiki/File:Vegan_Quinoa_Bowl_(44040185371).jpg |
| `photos/coffee2.jpg` | Brewing Single Serving Pour Over Coffee.jpg (downloaded 2026-10-23) | CC BY-SA 4.0 | JoeSeyd | https://commons.wikimedia.org/wiki/File:Brewing_Single_Serving_Pour_Over_Coffee.jpg |

## Light

| file | what | licence | author | source |
|---|---|---|---|---|
| `hdri/lebombo_1k.hdr` | "Lebombo" indoor daylight HDRI, 1k (1,476,953 bytes) | CC0 | Greg Zaal, Poly Haven | https://polyhaven.com/a/lebombo |

## 3D objects

| file | what | licence | source |
|---|---|---|---|
| `glb/r3/cup.glb`, `glb/r3/card.glb`, `glb/r3/pen.glb` | round-3 objects, modelled by this project in Blender 5.2.3 (`design/.scratch/r3/objects.py`) | this project (MIT) | original work |
| `glb/pen.glb` | round-5 pen (110,688 bytes; metres, tip at the origin, axis +Y; Meshopt, WebP, quantized). The ball/socket nib (first ~1.4 mm) comes from "Stationery Supplies" by Mateusz Sadek, Poly Haven, reoriented to +Y with its contact at y=0 and given a clean metal finish; barrel, cone, grip, cap, trim and clip modelled for this project. No source labels or textures retained. | CC0 1.0 (Poly Haven) + this project (MIT) | https://polyhaven.com/a/stationery_supplies ; `assets3d/r5/CREDITS.md` |
| `glb/cup.glb` | round-5 cup and saucer (445,280 bytes, scene-8 revision: warm espresso with a golden crema, same dimensions and node names; metres, +Y up, origin on the table plane). Saucer from "Tea Set 01" (Rico Cilliers, James Ray Cock, Jurita Burger; Poly Haven), welded, subdivided, resized and given plain porcelain; cup body, lip, handle and coffee modelled for this project. Source decals excluded. | CC0 1.0 (Poly Haven) + this project (MIT) | https://polyhaven.com/a/tea_set_01 ; `assets3d/r5/CREDITS.md` |
| `glb/card.glb` | round-5 ID-1 card (45,080 bytes, glossy clearcoat body; 85.60 × 53.98 × 0.786 mm, face +Y). Body, chip and fictional digits "0000 0000 0000 4471" modelled for this project; the digits, name and expiry are glyph outlines from Blender's built-in Bfont (DejaVu lineage), exported as geometry, no font file shipped. No bank or network marks. | this project (MIT); glyphs Bitstream Vera + Arev font licences, DejaVu changes public domain (`glb/LICENSE-bfont.txt`) | `assets3d/r5/CREDITS.md` |
| `glb/dims.json` | the round-5 objects' stated dimensions (pen length and collision radius, saucer footprint, card body), copied from `assets3d/r5/README.md`, read by the scene for placement and the pen-collision guard | this project | `assets3d/r5/README.md` |
| `glb/r3/*.glb` | kept as the fallback when a round-5 file fails to load | this project (MIT) | original work |
| Meshopt decoder (`three/examples/jsm/libs/meshopt_decoder.module.js`) | decodes `EXT_meshopt_compression` in the round-5 GLBs; bundled with three.js 0.186.1 | MIT (meshoptimizer, Arseny Kapoulkine; three.js authors) | https://github.com/zeux/meshoptimizer |

## Poster

| file | what | licence |
|---|---|---|
| `poster.jpg` | a still of this scene (section 0, rendered by `components/scene/runtime.ts`), shown under the canvas while it loads | this project (MIT) |

## Fonts (SIL Open Font License 1.1, from Google Fonts)

| file | family | author |
|---|---|---|
| `fonts/IBMPlexMono-400.woff2`, `fonts/IBMPlexMono-600.woff2` | IBM Plex Mono | IBM, Mike Abbink, Bold Monday |
| `fonts/Caveat-600.woff2` | Caveat | Pablo Impallari |
| `fonts/InstrumentSans.woff2` (variable) | Instrument Sans | Rodrigo Fuenzalida, Jordan Egstad, Instrument |

## Demo fixtures

`demo/maya.csv` is the synthetic persona statement from `personas/maya-williamsburg.csv` (invented transactions). `demo/*.ndjson` and `demo/maya.replans.json` were recorded from the scripted agent with the Qloo mock; every merchant address in them is marked "(synthetic)".
