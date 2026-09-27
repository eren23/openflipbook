export function reservationLabel(value: number): string {
  const cents = value.toFixed(2);
  return Number(cents) === value ? cents : String(value);
}
