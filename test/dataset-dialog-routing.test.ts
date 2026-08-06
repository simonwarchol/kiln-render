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

  it('strips /app/multichannel/ suffix', () => {
    expect(viewerSiteRoot('/kiln-render/app/multichannel/')).toBe('/kiln-render/');
    expect(viewerSiteRoot('/app/multichannel/')).toBe('/');
  });
});

describe('tryKilnViewerHref', () => {
  const origin = 'https://kilnrender.com';

  it('recognises a multichannel share link on the same origin', () => {
    const input =
      'https://kilnrender.com/app/multichannel/?dataset=https%3A%2F%2Fexample.com%2Fim.zarr%2F0&up=-z&mode=mip&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04';
    expect(tryKilnViewerHref(input, origin)).toBe(
      '/app/multichannel/?dataset=https%3A%2F%2Fexample.com%2Fim.zarr%2F0&up=-z&mode=mip&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04',
    );
  });

  it('recognises a basic viewer share link', () => {
    const input = 'https://kilnrender.com/app/?dataset=https://example.com/vol.ome.zarr&mode=dvr';
    expect(tryKilnViewerHref(input, origin)).toBe(
      '/app/?dataset=https://example.com/vol.ome.zarr&mode=dvr',
    );
  });

  it('returns a full href for cross-origin kiln links', () => {
    const input = 'https://kilnrender.com/app/multichannel/?dataset=https://example.com/x.zarr';
    expect(tryKilnViewerHref(input, 'https://preview.example.com')).toBe(input);
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

  it('routes multi-channel datasets to /app/multichannel/', () => {
    expect(
      datasetViewerHref(zarr, 4, {
        baseUrl: '/app/',
        currentPathname: '/app/',
      }),
    ).toBe(`/app/multichannel/?dataset=${encodeURIComponent(zarr)}`);
  });

  it('routes single-channel datasets to /app/', () => {
    expect(
      datasetViewerHref(zarr, 1, {
        baseUrl: '/app/multichannel/',
        currentPathname: '/app/multichannel/',
      }),
    ).toBe(`/app/?dataset=${encodeURIComponent(zarr)}`);
  });

  it('keeps the current path when channel count is unknown (sharded)', () => {
    expect(
      datasetViewerHref('https://example.com/sharded', null, {
        baseUrl: '/app/',
        currentPathname: '/app/',
      }),
    ).toBe(`/app/?dataset=${encodeURIComponent('https://example.com/sharded')}`);
  });
});

describe('localViewerHref', () => {
  it('routes multi-channel local loads to /app/multichannel/', () => {
    expect(
      localViewerHref(4, { baseUrl: '/app/', currentPathname: '/app/' }),
    ).toBe('/app/multichannel/?local=true');
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
