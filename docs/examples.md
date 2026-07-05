# Examples

Live demos and usage examples grouped by domain.

See also: [Usage Guide](usage-guide.md) | [Multichannel](multichannel.md) | [Data Guide](data-guide.md)

---

## Medical / CT Imaging

### Chameleon CT Scan
**2160 MB — 1024 × 1024 × 1080 @ 16-bit**

<a href="https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066" target="_blank">Live Demo</a>

<img width="1725" height="907" alt="Chameleon CT scan" src="https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405" />

CT scan of *Chamaeleo calyptratus*. Rendered in DVR mode with grayscale transfer function and window/level adjustments for soft tissue contrast.

**Dataset:** [Open SciVis — Chameleon](https://github.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets#chameleon) · Digital Morphology, 2003.

### Beechnut Micro-CT (OME-Zarr 0.5)
**3092 MB — 1024 × 1024 × 1546 @ 16-bit**

<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fbeechnut.ome.zarr&mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013" target="_blank">Live Demo</a>

<img width="1722" height="905" alt="Beechnut micro-CT scan" src="https://github.com/user-attachments/assets/02cffc17-bf44-422b-8752-9bf4edc96d89" />

MicroCT scan of a dried beechnut loaded directly from an OME-Zarr v0.5 store on S3. No preprocessing required — Kiln streams Zarr chunks on demand.

**Dataset:** [Open SciVis — Beechnut](https://github.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets#beechnut) · University of Zurich.

---

## Cryo-Electron Tomography

### Vibrio cholerae Cryo-ET (OME-Zarr 0.4)
**1123.9 MB — 1023 × 1440 × 400 @ 16-bit**

<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fsma2022-07-13-10.zarr&mode=dvr&wc=0.50&ww=1.00&iso=0.20&tf=grayscale-inverted&tfpts=0.00%2C1.00%2C1.00%2C1.00&up=-z&scale=0.50&cam=0.550%2C12.050%2C1.203%2C0.046%2C0.017%2C0.146&clipMin=0.00%2C0.00%2C0.37&wireframe=1" target="_blank">Live Demo</a>

<img width="1722" height="902" alt="Vibrio cholerae cryo-ET tomogram" src="https://github.com/user-attachments/assets/8e661338-ed45-4024-b818-c3162c11aa04" />

Cryo-ET tomogram from the CryoET Data Portal. Uses an inverted grayscale transfer function and Z-axis clipping to isolate a region of interest.

**Dataset:** [CryoET Data Portal — Vibrio cholerae](https://cryoetdataportal.czscience.com/runs/33757?table-tab=Tomograms) · Competence pilus study.

---

## Multichannel Fluorescence

All multichannel examples use the dedicated multichannel viewer with per-channel colour, window/level, and visibility controls. Compositing uses additive blending. See the [Multichannel documentation](multichannel.md) for API details and known limitations.

### Zebrafish Lateral Line — Cellular Architecture (IDR0079)
**~354 MB — 1584 × 788 × 142 @ 8-bit · 2 channels · OME-Zarr 0.4**

<a href="https://mpanknin.github.io/kiln-render/multichannel/?dataset=https%3A%2F%2Flivingobjects.ebi.ac.uk%2Fidr%2Fzarr%2Fv0.4%2Fidr0079A%2Fidr0079_images.zarr" target="_blank">Live Demo</a>

<img width="1725" height="907" alt="Zebrafish lateral line — 2 channels" src="https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405" />

AiryScan confocal fluorescence microscopy of the zebrafish (*Danio rerio*) posterior lateral line primordium. Two channels: lynEGFP (membrane, green) and NLStdTomato (nuclear, red). 142 z-slices at 0.102 µm xy / 0.225 µm z spacing.

**Dataset:** [IDR0079 — Hartmann et al., 2020](https://doi.org/10.7554/eLife.55913) · *An image-based data-driven analysis of cellular architecture in a developing tissue*

### In Situ Genome Sequencing — Human Fibroblast (IDR0101)
**~1.1 GB — 2048 × 2048 × 35 @ 16-bit · 4 channels · OME-Zarr 0.4**

<a href="https://mpanknin.github.io/kiln-render/multichannel/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fmultichannel%2F13457227.zarr%2F13457227.zarr&up=-y&mode=mip&scale=0.50&cam=-0.430%2C3.140%2C1.276%2C-0.001%2C0.048%2C0.022&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.01%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.02&slice=1024%2C1024%2C18%2C1%2C1%2C1" target="_blank">Live Demo</a>

<img width="1726" height="903" alt="In situ genome sequencing — human fibroblast, 4 channels" src="https://github.com/user-attachments/assets/7fa754a6-fd95-4556-9b5e-b9b6d467f18b" />


Confocal microscopy of human fibroblasts (PGP1) from an in situ genome sequencing study. Four fluorescence channels across 35 z-slices at 0.108 µm xy / 0.4 µm z spacing.

**Dataset:** [IDR0101 — Payne et al., 2021](https://doi.org/10.1126/science.aay3446) · *In situ genome sequencing resolves DNA sequence and structure in intact biological samples*

### Yeast smFISH — mRNA Expression (IDR0047)
**~800 MB — 2048 × 2048 × 25 @ 16-bit · 4 channels · OME-Zarr 0.4**

<a href="https://mpanknin.github.io/kiln-render/multichannel/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fmultichannel%2F4496763.zarr%2F4496763.zarr&up=-y&mode=slice&scale=0.50&cam=-0.380%2C3.140%2C1.261%2C-0.001%2C0.074%2C0.007&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04%3B255%2C255%2C0%2C1.00%2C1%2C0.02%2C0.04%3B255%2C0%2C0%2C1.00%2C1%2C0.01%2C0.09%3B255%2C255%2C255%2C1.00%2C1%2C0.01%2C0.05&slice=1024%2C1024%2C13%2C1%2C1%2C1" target="_blank">Live Demo</a>

<img width="1721" height="907" alt="Yeast smFISH — mRNA expression, 4 channels" src="https://github.com/user-attachments/assets/45452656-e3ff-4cc1-8db8-1a5f4478230f" />

Fluorescence microscopy of *Saccharomyces cerevisiae* (baker's yeast) showing single-molecule mRNA expression. Channels: CY5, TMR, DAPI, and transmitted light. 25 z-slices at 0.2 µm z spacing.

**Dataset:** [IDR0047 — Li & Neuert, 2019](https://doi.org/10.1038/s41597-019-0106-6) · *Multiplex RNA single molecule FISH of inducible mRNAs in single yeast cells*

---

## Render Modes

All single-channel demos support multiple render modes via URL parameter:

| Mode | URL | Description |
|------|-----|-------------|
| **DVR** | `?mode=dvr` | Front-to-back alpha compositing with transfer function |
| **MIP** | `?mode=mip` | Maximum intensity projection |
| **ISO** | `?mode=iso` | Isosurface extraction with Phong shading |
| **Slice** | `?mode=slice` | Orthogonal slice planes (X/Y/Z) |

Example — Chameleon in MIP mode:
```
https://mpanknin.github.io/kiln-render/?mode=mip&wc=0.35&ww=0.55&up=-y&scale=0.5
```

---

## Local File Loading

Load OME-Zarr datasets from your local filesystem using the File System Access API (Chrome/Edge only).

```typescript
import { KilnViewer, LocalZarrDataProvider, promptForZarrDirectory } from 'kiln-render';

const handle = await promptForZarrDirectory();
const viewer = await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
```

Both the single-channel and multichannel demos include a "Load Dataset" dialog for loading local or remote datasets interactively.

---

## Embedding in Your Application

Minimal example using the npm package:

```typescript
import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas')!;
const viewer = await KilnViewer.create(canvas, 'https://example.com/scan.ome.zarr', {
  mode: 'dvr',
  renderScale: 0.75,
  windowCenter: 0.35,
  windowWidth: 0.55,
  tfPreset: 'grayscale',
});

// Programmatic control
viewer.mode = 'mip';
viewer.renderScale = 0.5;
```

See the [Usage Guide](usage-guide.md) for the full API reference.

---

## Dataset Credits

- **Chameleon** — CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Beechnut** — MicroCT scan. Computer-Assisted Paleoanthropology group, University of Zurich.
- **Stag Beetle** — Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.
- **Vibrio cholerae** — Cryo-ET tomogram. [CryoET Data Portal](https://cryoetdataportal.czscience.com/).
- **IDR0079** — Zebrafish lateral line cellular architecture. [Hartmann et al., 2020](https://doi.org/10.7554/eLife.55913). [Image Data Resource](https://idr.openmicroscopy.org/).
- **IDR0101** — In situ genome sequencing. [Payne et al., 2021](https://doi.org/10.1126/science.aay3446). [Image Data Resource](https://idr.openmicroscopy.org/).
- **IDR0047** — Yeast smFISH mRNA expression. [Li & Neuert, 2019](https://doi.org/10.1038/s41597-019-0106-6). [Image Data Resource](https://idr.openmicroscopy.org/).

Single-channel datasets from the [Open SciVis Datasets](https://github.com/sci-visus/open-scivis-datasets) collection and [CryoET Data Portal](https://cryoetdataportal.czscience.com/). Multichannel datasets from the [Image Data Resource](https://idr.openmicroscopy.org/).
