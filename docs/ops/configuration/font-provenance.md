# Font provenance

[Documentation](../../README.md) / [Operations](../README.md) / [Configuration](./README.md)

Bundled font files live in `server/static/fonts/` and are served by the Myoxus server.

Release rule: every shipped font file must have a recorded upstream source and an included
license file. The Google Fonts license files live in `server/static/fonts/licenses/*-OFL.txt`, copied
verbatim from the official `google/fonts` repository.

## Google fonts

The bundled Google Fonts families use OFL-1.1. Their original `OFL.txt` notices
are included in `server/static/fonts/licenses/`; the manifest records each
file's source and checksum.

| Family          | License file                                         |
| --------------- | ---------------------------------------------------- |
| Bebas Neue      | `server/static/fonts/licenses/bebasneue-OFL.txt`     |
| Fira Code       | `server/static/fonts/licenses/firacode-OFL.txt`      |
| IBM Plex Mono   | `server/static/fonts/licenses/ibmplexmono-OFL.txt`   |
| Inter           | `server/static/fonts/licenses/inter-OFL.txt`         |
| JetBrains Mono  | `server/static/fonts/licenses/jetbrainsmono-OFL.txt` |
| Kalam           | `server/static/fonts/licenses/kalam-OFL.txt`         |
| Lato            | `server/static/fonts/licenses/lato-OFL.txt`          |
| Lobster         | `server/static/fonts/licenses/lobster-OFL.txt`       |
| Lora            | `server/static/fonts/licenses/lora-OFL.txt`          |
| Merriweather    | `server/static/fonts/licenses/merriweather-OFL.txt`  |
| Montserrat      | `server/static/fonts/licenses/montserrat-OFL.txt`    |
| Nunito          | `server/static/fonts/licenses/nunito-OFL.txt`        |
| Open Sans       | `server/static/fonts/licenses/opensans-OFL.txt`      |
| Orelega One     | `server/static/fonts/licenses/orelegaone-OFL.txt`    |
| Pattaya         | `server/static/fonts/licenses/pattaya-OFL.txt`       |
| Poppins         | `server/static/fonts/licenses/poppins-OFL.txt`       |
| PT Serif        | `server/static/fonts/licenses/ptserif-OFL.txt`       |
| Roboto          | `server/static/fonts/licenses/roboto-OFL.txt`        |
| Source Code Pro | `server/static/fonts/licenses/sourcecodepro-OFL.txt` |
| Source Sans 3   | `server/static/fonts/licenses/sourcesans3-OFL.txt`   |
| Source Serif 4  | `server/static/fonts/licenses/sourceserif4-OFL.txt`  |

The checked-in `server/static/fonts/manifest.json` is the per-file asset
inventory. `build/scripts/ci/audit-fonts.sh` verifies manifest consistency.

## Typst preview fonts

The browser Typst-preview adapter also consumes seventeen bundled TTF/OTF
files from the pinned
[Typst assets revision `ad8080d46d42fca909562572cfa14a86f00eb945`](https://github.com/typst/typst-assets/tree/ad8080d46d42fca909562572cfa14a86f00eb945/files/fonts).
These are separate from the Google Fonts collection and do not all use OFL.

| Family              | Included files                     | License and retained notices                                                                                                                            |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DejaVu Sans Mono    | Four TTF files                     | Bitstream Vera; DejaVu changes are public domain. Each `licenses/typst-DejaVuSansMono*.txt` retains the upstream copyright, trademark and license text. |
| Libertinus Serif    | Six OTF files                      | OFL-1.1; the corresponding `licenses/typst-LibertinusSerif*.txt` files retain the copyright and license text.                                           |
| New Computer Modern | Four text and three math OTF files | GUST Font License 1.0, based on LPPL-1.3c-or-later; the corresponding `licenses/typst-NewCM*.txt` files retain the upstream notice and license terms.   |

The `typst_preview_fonts` entries in the manifest record each exact source URL,
SHA-256, license identifier and included notice path. The font licenses remain
separate from the Myoxus source-code license.
