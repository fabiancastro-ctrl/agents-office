// Oficina de Agentes · texto del aviso de «sin cuota» de Claude. Sin dependencias del daemon (lo prueban las unitarias).
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Wall clock of `tz` expressed as a UTC instant: guess it as UTC, then correct by the zone offset at that guess.
function zoned(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric'
      })
        .formatToParts(guess)
        .map(p => [p.type, Number(p.value)])
    );
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    return guess - (asUtc - guess);
  } catch {
    return new Date(y, mo, d, h, mi).getTime();
  }
}
// «You've hit your 5-hour limit · resets 6:20pm (America/Bogota)» → { kind: '5h'|'week', resetsText, until (ms|null) }.
// Without a date the reset is the next time that clock shows; with «Nov 30» it is that day. null when it cannot be read.
export function parseLimit(text, from = Date.now()) {
  const t = String(text || '');
  const kind = /week/i.test(t) ? 'week' : '5h';
  const m = /resets\s+(?:(?:on\s+)?([a-z]{3})[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(
    t
  );
  const resetsText = (/resets\s+(.+)$/i.exec(t)?.[1] || '').trim();
  if (!m) return { kind, resetsText, until: null };
  const h = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0),
    mi = Number(m[4] || 0),
    tz = m[6]?.trim();
  const base = new Date(from);
  const mon = m[1] ? MON[m[1].toLowerCase()] : undefined;
  let until;
  if (mon !== undefined) {
    until = zoned(base.getFullYear(), mon, Number(m[2]), h, mi, tz);
    if (until < from - 86400e3) until = zoned(base.getFullYear() + 1, mon, Number(m[2]), h, mi, tz);
  } else {
    until = zoned(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, tz);
    while (until <= from) until += 86400e3;
  }
  return { kind, resetsText, until };
}
