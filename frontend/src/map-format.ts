const METER_FORMAT = new Intl.NumberFormat('pl-PL', {
  maximumFractionDigits: 1,
});

export function formatCableLength(value: number | null): string {
  return value == null ? 'brak danych' : `${METER_FORMAT.format(value)} m`;
}
