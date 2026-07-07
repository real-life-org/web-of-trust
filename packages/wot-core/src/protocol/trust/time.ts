export function wholeSecondRfc3339(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}
