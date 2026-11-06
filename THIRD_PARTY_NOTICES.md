# Third-party notices

Inklark's own code is licensed under MIT. Dependencies retain their licenses.

| Dependency                                     | License                                                         | Purpose                           |
| ---------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| pdf-lib                                        | MIT                                                             | PDF parsing and export            |
| PDF.js / pdfjs-dist                            | Apache-2.0                                                      | PDF rendering and text inspection |
| Liberation fonts bundled by PDF.js             | SIL Open Font License 1.1 and the notices in LICENSE_LIBERATION | Local UI and PDF rendering fonts  |
| Foxit fonts bundled by PDF.js                  | Notices in LICENSE_FOXIT                                        | Standard PDF font rendering       |
| esbuild                                        | MIT                                                             | Static build                      |
| Playwright                                     | Apache-2.0                                                      | Browser checks                    |
| @napi-rs/canvas, an optional PDF.js dependency | MIT                                                             | Agent PNG previews in Node        |

The optional local Python helper uses pikepdf under MPL-2.0 and its qpdf dependency under Apache-2.0. Their code is installed separately through `requirements-pdf.txt` and retains its own license.

The build copies the PDF.js font license files to `dist/pdf-assets/standard_fonts/`. Dependency package license files remain in `node_modules`. Review these notices when redistributing modified dependencies.
