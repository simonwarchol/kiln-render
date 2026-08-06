import { describe, it, expect } from 'vitest';
import {
  viewerSiteRoot,
  tryKilnViewerHref,
  datasetViewerHref,
  localViewerHref,
} from '../examples/shared/dataset-routing.js';
import { countChannels } from '../src/data/zarr-validator.js';

describe('viewerSiteRoot', () => {
  it('strips /app/ suffix', () => {
    expect(viewerSiteRoot('/kiln-render/app/')).toBe('/kiln-render/');
    expect(viewerSiteRoot('/app/')).toBe('/');
  });

  it('strips legacy /app/multichannel/ suffix', () => {
    expect(viewerSiteRoot('/kiln-render/app/multichannel/')).toBe('/kiln-render/');
    expect(viewerSiteRoot('/app/multichannel/')).toBe('/');
  });
});

describe('tryKilnViewerHref', () => {
  const origin = 'https://kilnrender.com';

  it('rewrites legacy multichannel share links onto /app/', () => {
    const input =
      'https://kilnrender.com/app/multichannel/?dataset=https%3A%2F%2Fexample.com%2Fim.zarr%2F0&up=-z&mode=mip&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04';
    expect(tryKilnViewerHref(input, origin)).toBe(
      '/app/?dataset=https%3A%2F%2Fexample.com%2Fim.zarr%2F0&up=-z&mode=mip&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04',
    );
  });

  it('recognises a basic viewer share link', () => {
    const input = 'https://kilnrender.com/app/?dataset=https://example.com/vol.ome.zarr&mode=dvr';
    expect(tryKilnViewerHref(input, origin)).toBe(
      '/app/?dataset=https://example.com/vol.ome.zarr&mode=dvr',
    );
  });

  it('normalises cross-origin kiln links onto /app/', () => {
    const input = 'https://kilnrender.com/app/multichannel/?dataset=https://example.com/x.zarr';
    expect(tryKilnViewerHref(input, 'https://preview.example.com')).toBe(
      'https://kilnrender.com/app/?dataset=https://example.com/x.zarr',
    );
  });

  it('rejects plain zarr dataset URLs', () => {
    expect(
      tryKilnViewerHref('https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/S-BSST410/IM4/IM4.zarr/0', origin),
    ).toBeNull();
  });

  it('rejects non-URL input', () => {
    expect(tryKilnViewerHref('not a url', origin)).toBeNull();
  });
});

describe('datasetViewerHref', () => {
  const zarr = 'https://example.com/multi.zarr';

  it('always routes to the unified /app/ viewer', () => {
    expect(
      datasetViewerHref(zarr, {
        baseUrl: '/app/',
        currentPathname: '/app/',
      }),
    ).toBe(`/app/?dataset=${encodeURIComponent(zarr)}`);
  });

  it('rewrites legacy multichannel base onto /app/', () => {
    expect(
      datasetViewerHref(zarr, {
        baseUrl: '/app/multichannel/',
        currentPathname: '/app/multichannel/',
      }),
    ).toBe(`/app/?dataset=${encodeURIComponent(zarr)}`);
  });
});

describe('localViewerHref', () => {
  it('loads local datasets on /app/', () => {
    expect(
      localViewerHref({ baseUrl: '/app/', currentPathname: '/app/' }),
    ).toBe('/app/?local=true');
  });
});

describe('countChannels', () => {
  it('returns 1 when there is no channel axis', () => {
    expect(countChannels({ datasets: [{ path: '0' }], axes: ['z', 'y', 'x'] }, [64, 64, 64])).toBe(1);
  });

  it('reads channel count from the c axis', () => {
    expect(
      countChannels({ datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] }, [4, 103, 512, 512]),
    ).toBe(4);
  });

  it('handles v0.5 typed axes', () => {
    const axes = [
      { name: 'c', type: 'channel' },
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ];
    expect(countChannels({ datasets: [{ path: '0' }], axes }, [2, 10, 10, 10])).toBe(2);
  });
});
