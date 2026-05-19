import { describe, expect, it } from 'vitest';
import { createAdresyAppGeocoder } from './address-geocoder.js';

describe('Adresy.app reverse geocoder', () => {
  it('loads the nearest PRG address for WGS84 coordinates', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      requests.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            found: true,
            count: 1,
            results: [
              {
                miejscowosc: 'Ostrzeszewo',
                ulica: 'Gietrzwaldzka',
                nr_budynku: '10',
                kod_pocztowy: '10-001',
                distance_m: 12.4,
                lat: 53.774,
                lon: 20.456,
              },
            ],
          };
        },
      };
    };

    const geocoder = createAdresyAppGeocoder(
      {
        baseUrl: 'https://example.test/api/v1',
        apiKey: 'secret-key',
        radiusMeters: 150,
      },
      fetchImpl,
    );

    const result = await geocoder.reverse({ lat: 53.7739, lng: 20.4559 });

    expect(requests).toEqual([
      {
        url: 'https://example.test/api/v1/lookup/blisko?lat=53.7739&lon=20.4559&radius=150&limit=1',
        headers: { 'X-API-Key': 'secret-key' },
      },
    ]);
    expect(result).toEqual({
      city: 'Ostrzeszewo',
      street: 'Gietrzwaldzka',
      buildingNo: '10',
      postalCode: '10-001',
      propertyId: null,
      parcelNumber: null,
      lat: 53.774,
      lng: 20.456,
      distanceMeters: 12.4,
      source: 'adresy.app',
    });
  });

  it('returns null when no nearby PRG address is found', async () => {
    const geocoder = createAdresyAppGeocoder(
      {
        baseUrl: 'https://example.test/api/v1',
        apiKey: null,
        radiusMeters: 150,
      },
      async () => ({
        ok: true,
        status: 200,
        async json() {
          return { found: false, count: 0, results: [] };
        },
      }),
    );

    await expect(geocoder.reverse({ lat: 53.7739, lng: 20.4559 })).resolves.toBeNull();
  });
});

