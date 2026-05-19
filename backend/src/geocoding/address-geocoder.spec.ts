import { describe, expect, it } from 'vitest';
import {
  createAdresyAppGeocoder,
  createFallbackAddressGeocoder,
  createNominatimGeocoder,
} from './address-geocoder.js';

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

  it('maps the real Adresy.app PRG response shape for rural addresses without streets', async () => {
    const geocoder = createAdresyAppGeocoder(
      {
        baseUrl: 'https://example.test/api/v1',
        apiKey: null,
        radiusMeters: 500,
      },
      async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            query: { lat: 53.76778, lon: 20.5377, radius: 500 },
            found: true,
            total: 3,
            results: [
              {
                miejscowosc: 'Ostrzeszewo',
                ulica: null,
                nr: '5B',
                kod_pocztowy: '10-687',
                odleglosc_m: 12.3,
                lat: 53.76787759643711,
                lon: 20.53778660013072,
              },
            ],
          };
        },
      }),
    );

    const result = await geocoder.reverse({ lat: 53.76778, lng: 20.5377 });

    expect(result).toEqual({
      city: 'Ostrzeszewo',
      street: 'Ostrzeszewo',
      buildingNo: '5B',
      postalCode: '10-687',
      propertyId: null,
      parcelNumber: null,
      lat: 53.76787759643711,
      lng: 20.53778660013072,
      distanceMeters: 12.3,
      source: 'adresy.app',
    });
  });

  it('falls back to Nominatim when PRG lookup has no usable address', async () => {
    const geocoder = createFallbackAddressGeocoder([
      {
        async reverse() {
          return null;
        },
      },
      createNominatimGeocoder(
        {
          baseUrl: 'https://nominatim.example.test',
          userAgent: 'PhotoLocal test',
        },
        async (url, init) => {
          expect(url).toBe(
            'https://nominatim.example.test/reverse?format=jsonv2&addressdetails=1&zoom=18&layer=address&lat=53.76778&lon=20.5377&accept-language=pl',
          );
          expect(init?.headers).toEqual({ 'User-Agent': 'PhotoLocal test' });
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                lat: '53.7677834',
                lon: '20.5377180',
                address: {
                  house_number: '5B',
                  village: 'Ostrzeszewo',
                  postcode: '10-687',
                },
              };
            },
          };
        },
      ),
    ]);

    await expect(geocoder.reverse({ lat: 53.76778, lng: 20.5377 })).resolves.toEqual({
      city: 'Ostrzeszewo',
      street: 'Ostrzeszewo',
      buildingNo: '5B',
      postalCode: '10-687',
      propertyId: null,
      parcelNumber: null,
      lat: 53.7677834,
      lng: 20.537718,
      distanceMeters: null,
      source: 'nominatim',
    });
  });
});
