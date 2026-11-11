const formatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** A stable timestamp for server-rendered pages. Customer ticket times are the public activity time. */
export function formatWhen(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${formatter.format(date)} UTC`;
}
