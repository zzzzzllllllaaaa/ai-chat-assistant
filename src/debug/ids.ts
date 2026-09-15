export function makeRunId(prefix = "run") {
  // Avoid crypto dependency differences; timestamp + random is good enough for debugging.
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
