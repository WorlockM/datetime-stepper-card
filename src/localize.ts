const en = {
  today: "Today",
  tomorrow: "Tomorrow",
  in: "in {value}",
  ago: "{value} ago",
  now: "now",
  hour_short: "h",
  minute_short: "min",
  day_short: "d",
  hours: "hours",
  minutes: "minutes",
  day: "day",
  in_past: "in the past",
  unavailable: "Unavailable",
  entity_not_found: "Entity not found: {entity}",
  unsupported_entity: "Use an input_datetime or datetime entity",
  increase: "Increase {unit}",
  decrease: "Decrease {unit}",
  select_unit: "Adjust {unit}",
};

type Strings = typeof en;

const nl: Strings = {
  today: "Vandaag",
  tomorrow: "Morgen",
  in: "over {value}",
  ago: "{value} geleden",
  now: "nu",
  hour_short: "u",
  minute_short: "min",
  day_short: "d",
  hours: "uren",
  minutes: "minuten",
  day: "dag",
  in_past: "ligt in het verleden",
  unavailable: "Niet beschikbaar",
  entity_not_found: "Entiteit niet gevonden: {entity}",
  unsupported_entity: "Gebruik een input_datetime- of datetime-entiteit",
  increase: "{unit} omhoog",
  decrease: "{unit} omlaag",
  select_unit: "{unit} aanpassen",
};

const translations: Record<string, Strings> = { en, nl };

export type StringKey = keyof Strings;

export function localize(
  language: string | undefined,
  key: StringKey,
  vars: Record<string, string> = {},
): string {
  const lang = (language ?? "en").split("-")[0];
  let text = (translations[lang] ?? en)[key] ?? en[key];
  for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
  return text;
}
