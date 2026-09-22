# Demo dataset — `sub-example`

A small, **trimmed** `brainana` output tree for one macaque subject — enough to launch the
Brainana Viewer against real data without preprocessing your own.

Produced by **brainana 3.0.0** at `synthesis_level: subject`, so `sub-example` has a single
reconstruction: one session, its 12 atlases, and its cortical surfaces. Rebuilt from a full
pipeline run with [`scripts/build-demo-dataset.mjs`](../../scripts/build-demo-dataset.mjs).

## ▶ Use it in the Viewer

**1. Download this folder.** From the repo root — needs git ≥ 2.25:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/brainana/brainana-viewer.git
cd brainana-viewer
git sparse-checkout set datasets/demo_viewer
```

On older git, clone the whole repo instead: `git clone https://github.com/brainana/brainana-viewer.git`.

**2. Add it as a local dataset.** In the Viewer, open the **dataset** panel. Under **local
dataset**, browse to (or paste the path of) the `demo_viewer` folder and click **add**:

```
datasets/demo_viewer/   ← add THIS folder
├─ sub-example/
└─ fastsurfer/
```

> [!IMPORTANT]
> Add the **`demo_viewer` folder itself** — the level that *contains* `sub-example/`, not one of
> the subject folders inside it.
