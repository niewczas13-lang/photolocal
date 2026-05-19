export interface ReverseGeocodePoint {
  lat: number;
  lng: number;
}

export interface ReverseGeocodeAddress {
  city: string;
  street: string;
  buildingNo: string | null;
  postalCode: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  lat: number;
  lng: number;
  distanceMeters: number | null;
  source: string;
}

export interface AddressGeocoder {
  reverse(point: ReverseGeocodePoint): Promise<ReverseGeocodeAddress | null>;
}

export interface AdresyAppGeocoderConfig {
  baseUrl: string;
  apiKey: string | null;
  radiusMeters: number;
}

interface AdresyAppResponse {
  found?: boolean;
  count?: number;
  results?: Array<{
    miejscowosc?: unknown;
    ulica?: unknown;
    ulica_norm?: unknown;
    nr_budynku?: unknown;
    kod_pocztowy?: unknown;
    distance_m?: unknown;
    lat?: unknown;
    lon?: unknown;
  }>;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function createAdresyAppGeocoder(
  config: AdresyAppGeocoderConfig,
  fetchImpl: FetchLike = fetch,
): AddressGeocoder {
  return {
    async reverse(point) {
      const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/lookup/blisko`);
      url.searchParams.set('lat', String(point.lat));
      url.searchParams.set('lon', String(point.lng));
      url.searchParams.set('radius', String(config.radiusMeters));
      url.searchParams.set('limit', '1');

      const headers = config.apiKey ? { 'X-API-Key': config.apiKey } : undefined;
      const response = await fetchImpl(url.toString(), headers ? { headers } : undefined);
      if (!response.ok) {
        throw new Error(`Adresy.app reverse geocoding failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as AdresyAppResponse;
      const first = payload.found === false ? null : payload.results?.[0];
      if (!first) return null;

      const city = stringOrNull(first.miejscowosc);
      const street = stringOrNull(first.ulica_norm) ?? stringOrNull(first.ulica);
      const lat = numberOrNull(first.lat);
      const lng = numberOrNull(first.lon);
      if (!city || !street || lat == null || lng == null) return null;

      return {
        city,
        street,
        buildingNo: stringOrNull(first.nr_budynku),
        postalCode: stringOrNull(first.kod_pocztowy),
        propertyId: null,
        parcelNumber: null,
        lat,
        lng,
        distanceMeters: numberOrNull(first.distance_m),
        source: 'adresy.app',
      };
    },
  };
}

