<p align="center">
  <img src="docs/_static/brainana_logo_side.png" alt="Brainana Viewer logo" width="500">
</p>

# Brainana Viewer

**Brainana Viewer** is a free, cross-platform desktop app for exploring **macaque (monkey) brain MRI**.

View anatomical volumes, 3D cortical surfaces, atlases, and functional maps produced by the
[**Brainana**](https://github.com/xingyu-liu/brainana) preprocessing pipeline
([preprint](https://www.biorxiv.org/content/10.64898/2026.06.03.729972v1)).
Built on [NiiVue](https://github.com/niivue/niivue) + WebGL2, it runs on **macOS, Windows, and Linux**.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--v3-blue.svg)](LICENSE)

## Features

<p align="center">
  <img src="docs/_static/brainana_viewer_big.png" alt="Brainana Viewer — macaque brain MRI: cortical surface, atlas overlay, and slice views" width="900">
</p>

- **Volume & surface views** — volume slices and rotatable 3D surface.
- **Surface morphometry** — curvature, depth, or thickness on cortex.
- **Atlases & regions** — automatically overlay brain parcellations and read the region under your cursor.
- **Functional maps** — retinotopy and somatotopy on both volume and surface.
- **Local or remote data** — dataset on your computer or a lab workstation.
- **Compare monkeys** — easily switch subjects to compare across monkeys.
- **HTML reports** — bookmark locations and export a self-contained report with file provenance,
  region and measurement readouts, and screenshots.

## Download & install

Grab the app for your operating system from the **[Releases page](../../releases/latest)**.

| Your system | Download |
| ----------- | -------- |
| **macOS — Apple Silicon** (M1/M2/M3…) | `Brainana Viewer-*-arm64.dmg` |
| **macOS — Intel** | `Brainana Viewer-*.dmg` |
| **Windows** | `Brainana Viewer Setup *.exe` |
| **Linux** | `Brainana Viewer-*.AppImage` or `brainana-viewer_*_amd64.deb` |

> **First launch:** the app is currently **unsigned**, so the first time you open it macOS and
> Windows warn that it's from an unidentified developer. You only need to clear this once per app.
>
> - **macOS:** double-click the app; when it's blocked, open **System Settings → Privacy &
>   Security**, scroll down to the **Security** section, and click **Open Anyway** (confirm with
>   your password). *(On macOS Sequoia and later, the old right-click → Open shortcut no longer
>   works — use this route.)*
> - **Windows:** on the SmartScreen prompt choose **More info → Run anyway**.
> - **Linux (AppImage):** if double-clicking shows *"no application installed for AppImage… files"*,
>   the file just needs the executable bit — right-click → **Properties → Permissions → Allow
>   executing file as program**, or run `chmod +x Brainana-Viewer-*.AppImage && ./Brainana-Viewer-*.AppImage`.
>   *(The `.deb` needs none of this.)*

Not sure which Mac chip you have? Check **Apple menu → About This Mac.**

No account or sign-up is required. The app opens to a welcome screen with nothing loaded yet —
add a dataset to begin (see [Quick start](#quick-start)).

## Quick start

When you open the app it starts on a welcome screen — no data is loaded yet. Add a dataset to begin:

1. **Add a dataset.** Click **dataset** (top-left) and point the Viewer at a **brainana output
   directory** — a folder containing `sub-*` subjects. This can be a **local** folder or a
   **remote** workstation over **SSH/SFTP**. Add more than one if you like.

   > **Remote hosts must be in your `known_hosts`.** Like `ssh` itself, the Viewer refuses to
   > connect to a server whose host key it cannot verify, so a machine-in-the-middle cannot
   > collect your password. If you get *"Unrecognised SSH host key"*, `ssh` to that host once
   > from a terminal (or run `ssh-keyscan`) to record its key, then retry.
2. **Choose a monkey.** Pick a subject from the **monkey** dropdown; the default anatomy + surface view loads.
3. **Explore.** Use the toolbar and side panel to switch the base volume and surface, add an
   **atlas**, apply **morphology** shading or a **func map**, and tune colormaps. Click anywhere
   to move the crosshair and read out values.
4. **Compare.** Reopen the **monkey** dropdown to switch subjects — your view settings carry over.

### Try the demo dataset

No dataset of your own yet? A small [demo subject](datasets/demo_viewer) (`sub-example`) lives in
this repo. Grab just the `demo_viewer` folder and add it as a local dataset to try the app. This
needs git ≥ 2.25:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/brainana/brainana-viewer.git
cd brainana-viewer
git sparse-checkout set datasets/demo_viewer     # a real brainana output dir
```

Then, in the app, open the **dataset** panel and, under **local dataset**, add the `demo_viewer`
folder:

```
brainana-viewer/
└─ datasets/
   └─ demo_viewer/   ← add THIS folder
      ├─ sub-example/
      └─ fastsurfer/
```

> [!IMPORTANT]
> Add the **`demo_viewer` folder itself** — the level that *contains* `sub-example/`, not one of
> the subject folders inside it.

On older git, clone the whole repo instead: `git clone https://github.com/brainana/brainana-viewer.git`.

---

## Generate a report

The **report** controls sit at the top right of the toolbar, under the category tabs.

1. **Bookmark the locations you care about.** Move the crosshair to a spot and click **+ point**.
   The readouts are captured at that moment — every atlas's region, the morphometry at the nearest
   vertex, and the retinotopy or somatotopy values — so a point keeps what was on screen even after
   you switch overlays. The counter beside the button shows how many points you have.
2. **Click report.** The dialog lists your points (rename or remove them there), lets you include or
   skip screenshots, and asks where to put the file.
3. **Choose a destination.** **Download** is the default and behaves the same in the browser and the
   desktop app. Or pick **save into the dataset** to write the report next to your data — this works
   for remote datasets too, since the save happens server-side.

The result is a single self-contained `.html` file: it embeds its own styling and images, loads
nothing over the network, and contains no scripts, so it opens years later on any machine and prints
cleanly. It documents

- **where the data came from** — the path of every loaded file, its key NIfTI header fields (n_dim,
  dimensions, resolution, datatype, intent, scaling, and the voxel→world affine), and the version of
  the **brainana** pipeline that produced it, read from each file's JSON sidecar;
- **how it was displayed** — layout, overlays, colormaps, display ranges, clips, thresholds, camera;
- **what you selected** — the current crosshair and every bookmarked point, in full;
- **what it looked like** — the slice montage and 3D surface, plus a pair of images per point.

Bookmarked points are coordinates in one subject's space, so switching monkeys clears them.

> [!TIP]
> The report also embeds its own data as JSON (in a `<script type="application/json">` block at the
> end of the file), so a report can be parsed back into a table by a script.

---

## Citing Brainana

If you use the Brainana Viewer or the Brainana pipeline in your research, please cite the
Brainana preprint and link the software:

- **Paper:** [preprint](https://www.biorxiv.org/content/10.64898/2026.06.03.729972v1)
- **Preprocessing pipeline:** [![xingyu-liu/brainana on GitHub](https://img.shields.io/badge/GitHub-xingyu--liu%2Fbrainana-181717?logo=github)](https://github.com/xingyu-liu/brainana)
- **Viewer:** this repository.

## Acknowledgements & references

The Viewer is built on the shoulders of excellent open-source work. The key pieces:

**Core rendering & data**
- [**NiiVue**](https://github.com/niivue/niivue) — the WebGL2 neuroimaging engine that draws every slice and surface.
- [**fflate**](https://github.com/101arrowz/fflate) — fast zlib/gzip for compressed NIfTI/GIFTI payloads.
- [**nifti-reader-js**](https://github.com/rii-mango/NIFTI-Reader-JS) — NIfTI-1/2 header & data parsing.
- [**ssh2**](https://github.com/mscdex/ssh2) — pure-JS SSH/SFTP client backing the remote data source.

**Build, packaging & language**
- [**TypeScript**](https://www.typescriptlang.org/)
- [**Vite**](https://vitejs.dev/)
- [**Electron**](https://www.electronjs.org/)
- [**electron-builder**](https://www.electron.build/)
- [**Node.js**](https://nodejs.org/) (≥ 22.18)

**Standards**
- [WebGL 2.0](https://www.khronos.org/webgl/).

## License

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0), the same license
as the parent [**Brainana**](https://github.com/xingyu-liu/brainana) pipeline. See [LICENSE](LICENSE).