# Overhead Scanner

A browser app for an overhead document camera: capture, deskew, clean up, OCR, and export
to searchable PDF. Everything runs locally — no uploads, no build step, no network at
runtime. Tesseract and the English language data are vendored in `vendor/`.

Full spec in [REQUIREMENTS.md](REQUIREMENTS.md).

---

## Run it

```bash
cd ~/overhead-scanner
python3 -m http.server 8931
```

Then open **http://localhost:8931**.

A server is needed because `getUserMedia` requires a secure context, and because the OCR
worker loads from the same origin. `localhost` counts as secure. Opening `index.html`
directly works in Chrome for everything except OCR; Safari won't give you the camera at
all over `file://`.

Grant camera permission when asked, pick your device in the top bar, press **Start camera**.

---

## The workflow it's built around

1. Put the page under the camera. The green outline shows the page it has found.
2. Turn on **Auto** (or press <kbd>A</kbd>). Now every time you turn a page and take your
   hands out of frame, it shoots by itself. You never touch the keyboard.
3. Pages stack up in the tray on the left. Pick a filter once and hit **Apply to all pages**.
4. **Read all** in the OCR tab, then **Save PDF** with *Searchable* ticked.

## Choosing a filter

| | |
|---|---|
| **Auto** | The default. Start here. |
| **Black & white** | Text-only pages. Smallest files, best OCR, kills any lighting gradient. |
| **Colour doc** | Anything with photos, highlighter, or coloured print. |
| **Whiteboard** | Photographs of whiteboards — hard background removal, punchy pens. |
| **Ink boost** | Pencil, faded carbon, old faint print. |
| **Photo** | Barely touches the image. For when you want the actual photograph. |

Every filter is just a preset over the sliders below it — nudge anything and the filter
switches to *custom*. The circular arrow beside each slider resets that one control back to
the filter's value.

## Getting a clean scan

- **Light from two sides** if you can. One lamp leaves a gradient that *Shadow & gradient
  removal* then has to undo, and undoing it costs you some tonal range.
- **A dark, matte desk mat** makes edge detection close to perfect. Detection works from the
  brightness difference between the page and what surrounds it, so the bigger that
  difference, the better. A pale or paper-coloured desk is the hard case.
- **Auto-level for the page** before blaming anything else. An overhead rig meters the whole
  desk, so a bright page on a dark mat comes out murky — the camera is exposing for the mat.
  The button measures the paper itself and searches for the setting that puts it where it
  belongs; <kbd>,</kbd> and <kbd>.</kbd> nudge it by hand. An under-exposed frame also
  crushes the paper/desk difference detection relies on.
- **Refocus** after changing how high the camera sits. Overhead modules hunt, or lock onto
  the desk rather than the page.
- Watch **Capture → crop** in the Capture tab. It shows what a shot will produce after
  cropping, and roughly what dpi that is for an A4 sheet — if it reads much under 200 dpi,
  move the camera closer or raise the resolution before scanning a stack.
- **Glossy pages**: raise the camera and tilt the lamp, rather than fighting the reflection
  in software.
- If the page isn't found, the status bar under the image says so and the whole frame is
  captured — it never guesses. Press **Corners** (or <kbd>C</kbd>) and drag the four handles;
  a magnifier follows your finger so you can land exactly on the paper edge.

## Keyboard

<kbd>Space</kbd> capture · <kbd>A</kbd> auto-capture · <kbd>C</kbd> corners · <kbd>D</kbd>
detect · <kbd>B</kbd> hold to compare · <kbd>L</kbd>/<kbd>E</kbd> live/edit ·
<kbd>←</kbd><kbd>→</kbd> pages · <kbd>[</kbd><kbd>]</kbd> rotate · <kbd>1</kbd>–<kbd>8</kbd>
filters · <kbd>R</kbd> OCR this page · <kbd>,</kbd><kbd>.</kbd> camera exposure ·
<kbd>0</kbd> fit · <kbd>?</kbd> help

---

## Other languages

Only English is bundled. Pick another language in the OCR tab and it will be fetched from
the CDN once (needs network, then it's cached by the browser). To make one permanent and
offline, drop its `.traineddata.gz` into `vendor/tessdata/` and add its code to
`O.BUNDLED` in `js/ocr.js`:

```bash
curl -L -o vendor/tessdata/deu.traineddata.gz \
  https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast/deu.traineddata.gz
```

---

## Layout

```
index.html            markup and the control panels
css/styles.css        the whole UI
js/util.js            helpers — toasts, downloads, canvas, beep
js/geometry.js        page detection, homography, perspective warp
js/imaging.js         the processing pipeline: flattening, tone, filters, threshold
js/camera.js          device enumeration, streaming, capture, motion detection
js/ocr.js             Tesseract wrapper, pointed at vendor/
js/pdf.js             PDF writer with an invisible OCR text layer
js/store.js           IndexedDB session persistence
js/app.js             UI controller
vendor/               Tesseract runtime + eng traineddata (offline)
test/                 see below
```

Classic scripts, no modules and no bundler, deliberately: it means the folder runs as-is.

### Getting the most pixels onto the page

Preview and capture are deliberately not the same thing.

A document camera's top mode is a **stills** mode. The unit this was developed against
reports a 4656×3496 maximum, and asking the *stream* for it yields 10 fps and a first frame
after **66 seconds** — a dead preview and nothing to capture. So the stream is set to the
sensor's aspect ratio at a size that actually moves (1598×1200 at 30 fps on that camera),
and the resolution for the scan comes from `ImageCapture.takePhoto()`, which returns the
full 4656×3496 in about three seconds while the preview stays live.

Two things make that safe:

- **The preview matches the sensor's aspect ratio.** A 16:9 preview of a 4:3 sensor is a
  *crop*, not a scaled copy — the two differ in field of view, so an outline drawn on the
  preview lands somewhere else on the still. Matching the shape makes them agree.
- **The match is measured, not assumed.** At start-up the app takes one photo and correlates
  it against the live frame. If they don't line up, the capture is re-detected instead of
  being cropped with an outline that doesn't belong to it.

`getPhotoCapabilities()` is not used to decide any of this: on the tested camera it reported
1920×1080 for a still that actually comes back at 4656×3496.

### Processing order

```
warp → rotate/flip/straighten → illumination flattening → white balance →
temperature/tint → tone curve → saturation/vibrance → denoise → sharpen →
filter mode (grey / adaptive threshold) → invert
```

The same function renders the preview and the export; only the input scale differs, so
what you see is what you get. Preview caps at 1500 px on the long edge (≈11–42 ms per
update), OCR at 2400 px, export is uncapped.

Two pieces are worth knowing about if you touch the code:

- **Illumination flattening** estimates the paper level as a per-block *maximum* of
  luminance (which reads straight through text), blurs it hard because illumination is by
  definition low-frequency, and divides. Strength interpolates the gain geometrically
  (`gain^s`), not the output — blending the output linearly leaves a residual gradient
  proportional to `1−s`, so half strength would still show the lamp.
- **Page detection** thresholds the frame with Otsu, dilates to close the gaps that lines of
  text cut through the paper, takes the largest connected component, and reduces its convex
  hull to four corners. It returns `null` rather than guessing when the region doesn't stand
  out from its surroundings — a blank desk should produce no crop, not a random one.

  Four things there matter more than the algorithm itself:

  - **Both threshold polarities are tried.** The page-is-brighter-than-the-desk guess is
    wrong often enough in ordinary use — a page that nearly fills the frame leaves a border
    ring that is itself mostly paper, a hand resting in the middle drags the centre down —
    and guessing wrong meant no outline at all.
  - **The region must fill its own outline.** On a desk close to paper colour the paper-side
    threshold takes in the desk too and gets rejected, so the ink-side attempt wins and its
    hull is the *text block* — a plausible-looking quadrilateral sitting well inside the real
    page. Ink covers a small fraction of its own bounding box; paper fills nearly all of its
    own outline. A quad covering more than 95% of the frame is refused for the same reason:
    cropping to everything is not a crop.
  - **The live outline is what gets cropped.** Capture hands the displayed quadrilateral to
    the page, including "there wasn't one", rather than running a second detection that can
    quietly disagree with what you were looking at.
  - **The outline is eased, not snapped.** Each reading is blended towards the last, with a
    snap when the page genuinely moves and a few frames of hold on a miss, so it stops
    flickering between readings.

---

## Tests

```bash
node test/algorithms.test.js      # 54 assertions, no browser needed
node test/detection.test.js       # 16 desk setups; --ppm dumps each scene to /tmp
node test/camera.test.js          # camera plumbing, via Chrome's fake device
```

`algorithms.test.js` covers the homography and warp, illumination flattening, adaptive
thresholding, output sizing, and the PDF writer — including that every xref offset resolves
to its object.

`detection.test.js` is the bench for page finding. It synthesises the setups an overhead rig
actually meets — dark mat, wooden desk, pale desk, white-on-white, one side lamp, badly
under-exposed, rotated, clipped by the frame, a hand reaching in — and checks both that the
page is found and that it is found to within 2% of the frame. Three of the sixteen have no
page in them at all and exist to check that detection *declines* rather than inventing a
crop from wood grain or sensor noise. Add a scenario here before changing anything in
`detect()`; the failure modes are not obvious from the code.

```
http://localhost:8931/test/browser-test.html    # pipeline, in a real canvas — instant
http://localhost:8931/test/ocr-test.html        # OCR + searchable PDF — 10-30 s
```

`browser-test.html` runs the real pipeline against a synthetic angled, unevenly lit capture
using the browser's own canvas, so it also covers `drawImage` resampling, `fillText`, and
the rotate/flip stage. It renders every filter with timings, so you can see what each does.

`ocr-test.html` is the one to open when OCR misbehaves: it exercises `vendor/` loading, the
worker, recognition of known text, and the PDF text layer end to end.

```bash
node test/integration.js                        # drives the real UI, needs the server up
```

Drives `index.html` in headless Chrome over the DevTools protocol: imports an image through
the actual file input, then checks the tray, thumbnail, auto-detection, filter switching,
rotation, export sizing and deletion, and asserts nothing threw. Set `CHROME=` to point at
a different browser binary.

`camera.test.js` covers the plumbing around capture: that `start()` completes at all (every
step in it interrogates the driver, and both `video.play()` and `getPhotoCapabilities()` can
simply never settle — which hung camera start with nothing to show for it), that the track
gets pushed to the device's real maximum resolution, and that the still-capture probe and
the exposure/focus controls degrade rather than throw. Anything that reads pixels needs a
real camera: headless Chrome hands out a MediaStream but never decodes fake-device frames
into a `<video>`.

---

## Known limits

- Curved book spines aren't dewarped — a quadrilateral can't model a curl. Flatten the
  page, or use a glass platen.
- The camera's own controls (zoom, focus, exposure) appear only if the browser exposes
  them; many UVC cameras expose nothing, in which case use their driver utility.
- Pages are held as JPEG (q0.94), so an edited page is one generation from the sensor.
  Export before you close if that matters.
- Chrome supports "Copy image"; Safari and Firefox may refuse the clipboard write.
