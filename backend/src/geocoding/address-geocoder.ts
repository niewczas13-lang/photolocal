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

export interface NominatimGeocoderConfig {
  baseUrl: string;
  userAgent: string;
}

interface AdresyAppResponse {
  found?: boolean;
  count?: number;
  total?: number;
  results?: Array<{
    miejscowosc?: unknown;
    ulica?: unknown;
    ulica_norm?: unknown;
    nr_budynku?: unknown;
    nr?: unknown;
    kod_pocztowy?: unknown;
    distance_m?: unknown;
    odleglosc_m?: unknown;
    lat?: unknown;
    lon?: unknown;
  }>;
}

interface NominatimResponse {
  lat?: unknown;
  lon?: unknown;
  address?: {
    house_number?: unknown;
    road?: unknown;
    pedestrian?: unknown;
    footway?: unknown;
    village?: unknown;
    town?: unknown;
    city?: unknown;
    municipality?: unknown;
    hamlet?: unknown;
    postcode?: unknown;
  };
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

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = stringOrNull(value);
    if (parsed) return parsed;
  }
  return null;
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
      const street = firstString(first.ulica_norm, first.ulica, city);
      const lat = numberOrNull(first.lat);
      const lng = numberOrNull(first.lon);
      if (!city || !street || lat == null || lng == null) return null;

      return {
        city,
        street,
        buildingNo: firstString(first.nr_budynku, first.nr),
        postalCode: stringOrNull(first.kod_pocztowy),
        propertyId: null,
        parcelNumber: null,
        lat,
        lng,
        distanceMeters: numberOrNull(first.distance_m) ?? numberOrNull(first.odleglosc_m),
        source: 'adresy.app',
      };
    },
  };
}

export function createNominatimGeocoder(
  config: NominatimGeocoderConfig,
  fetchImpl: FetchLike = fetch,
): AddressGeocoder {
  return {
    async reverse(point) {
      const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/reverse`);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('zoom', '18');
      url.searchParams.set('layer', 'address');
      url.searchParams.set('lat', String(point.lat));
      url.searchParams.set('lon', String(point.lng));
      url.searchParams.set('accept-language', 'pl');

      const response = await fetchImpl(url.toString(), {
        headers: { 'User-Agent': config.userAgent },
      });
      if (!response.ok) {
        throw new Error(`Nominatim reverse geocoding failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as NominatimResponse;
      const address = payload.address;
      if (!address) return null;

      const city = firstString(address.village, address.town, address.city, address.municipality, address.hamlet);
      const street = firstString(address.road, address.pedestrian, address.footway, city);
      const lat = numberOrNull(payload.lat);
      const lng = numberOrNull(payload.lon);
      if (!city || !street || lat == null || lng == null) return null;

      return {
        city,
        street,
        buildingNo: stringOrNull(address.house_number),
        postalCode: stringOrNull(address.postcode),
        propertyId: null,
        parcelNumber: null,
        lat,
        lng,
        distanceMeters: null,
        source: 'nominatim',
      };
    },
  };
}

export function createFallbackAddressGeocoder(geocoders: AddressGeocoder[]): AddressGeocoder {
  return {
    async reverse(point) {
      let lastError: unknown = null;
      for (const geocoder of geocoders) {
        try {
          const result = await geocoder.reverse(point);
          if (result) return result;
        } catch (error) {
          lastError = error;
        }
      }

      if (lastError) throw lastError;
      return null;
    },
  };
}
