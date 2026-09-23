/* Probe prelude: makes a silently-wrong probe impossible to mistake for a
 * passing one.
 *
 * Import at the top of any throwaway probe:
 *   const {must, mustShape, absent} = await import(`${R}/scripts/probe-guard.mjs`);
 *
 * WHY THIS EXISTS. Across four sessions every expensive probe error had the
 * same shape: a wrong export name, option name, or fixture shape produced
 * `undefined` or an empty collection rather than an exception, and the probe
 * then reported a confident result about nothing. Two real examples:
 *
 *   - `{from, to}` where the API took `{fromMs, toMs}` -> 0 occurrences ->
 *     "PASS: nothing private survived sharing". It survived nothing because
 *     there was nothing.
 *   - a fixture with `attribution: {name}` where the real type is a string ->
 *     "attribution ABSENT" -> working code looked broken.
 *
 * A guess that throws costs thirty seconds. A guess that returns undefined
 * costs a wrong conclusion reported as fact. These helpers convert the second
 * kind into the first.
 */

/** A value that must exist. Throws with the label if it does not. */
export function must(label, value) {
  if (value === undefined || value === null) {
    throw new Error(
      `PROBE BUG: ${label} is ${value}. The probe is wrong, not the code — `
      + 'check the real export name, signature and return shape with '
      + '`node scripts/surface.mjs <module> [export] [args...]` before rerunning.',
    );
  }
  return value;
}

/** A collection that must be non-empty. An absence assertion over an empty
 *  set is vacuous, which is the single most expensive failure mode here. */
export function mustHave(label, collection) {
  must(label, collection);
  const size = Array.isArray(collection) ? collection.length
    : typeof collection === 'string' ? collection.length
    : collection instanceof Map || collection instanceof Set ? collection.size
    : Object.keys(collection).length;
  if (size === 0) {
    throw new Error(
      `PROBE BUG: ${label} is empty. Any "nothing leaked" or "field absent" `
      + 'conclusion drawn from it would be vacuous. Fix the input first.',
    );
  }
  return collection;
}

/** Asserts the shape you believe you are holding, naming every missing key. */
export function mustShape(label, value, keys) {
  must(label, value);
  const missing = keys.filter((k) => value[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `PROBE BUG: ${label} is missing ${missing.join(', ')}. `
      + `It actually has: ${Object.keys(value).join(', ') || '(no keys)'}. `
      + 'Your fixture or unwrapping is wrong — confirm with scripts/surface.mjs.',
    );
  }
  return value;
}

/** An absence assertion WITH its positive control, together, so one cannot be
 *  written without the other.
 *
 *    absent('share export', sharedHtml, privateHtml, ['SECRET_LOCATION']);
 *
 *  Fails loudly if the needle is missing from the control too — that means the
 *  test proves nothing, whichever way it comes out. */
export function absent(label, haystack, control, needles) {
  mustHave(`${label}: haystack`, haystack);
  mustHave(`${label}: control`, control);
  const notInControl = needles.filter((n) => !control.includes(n));
  if (notInControl.length > 0) {
    throw new Error(
      `PROBE BUG: ${notInControl.join(', ')} absent from the CONTROL for ${label}. `
      + 'The permissive case must contain what the restricted case withholds, '
      + 'or this asserts nothing.',
    );
  }
  const leaked = needles.filter((n) => haystack.includes(n));
  console.log(`  ${label}: control carries all ${needles.length}; `
    + `${leaked.length === 0 ? 'restricted carries none — PASS' : `LEAKED ${leaked.join(', ')}`}`);
  return leaked.length === 0;
}
