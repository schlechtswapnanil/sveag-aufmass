// Kompakter JSON-Schema-Validator fuer genau die Teilmenge, die
// schema/brief.schema.json benutzt: type, const, enum, required,
// additionalProperties, properties, items, $ref (nur "#/$defs/..."),
// pattern, minLength, minimum, maximum.
//
// Absichtlich kein ajv: das Automations-Paket bleibt dependency-frei, damit es
// in jeder Umgebung ohne npm install laeuft. Wer das Schema erweitert, muss
// hier ggf. ein Keyword nachziehen - deshalb wirft unbekanntes Verhalten
// lieber einen Fehler, als still durchzuwinken.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object'
}

function matchesType(value, t) {
  const actual = typeOf(value);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'object') return actual === 'object';
  return actual === t;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Nicht unterstuetzter $ref: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node[part];
    if (!node) throw new Error(`$ref laeuft ins Leere: ${ref}`);
  }
  return node;
}

function walk(value, schema, root, path, errors) {
  if (schema.$ref) {
    walk(value, resolveRef(root, schema.$ref), root, path, errors);
    return;
  }
  const at = path || '(root)';

  if ('const' in schema && value !== schema.const) {
    errors.push(`${at}: erwartet ${JSON.stringify(schema.const)}, ist ${JSON.stringify(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} nicht in [${schema.enum.join(', ')}]`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at}: Typ ${typeOf(value)}, erwartet ${types.join('|')}`);
      return; // Folgepruefungen waeren nur Folgefehler
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${at}: zu kurz (${value.length} < ${schema.minLength})`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: entspricht nicht /${schema.pattern}/`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${at}: ${value} < Minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${at}: ${value} > Maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => walk(v, schema.items, root, `${at}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}: Pflichtfeld "${key}" fehlt`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${at}: unbekanntes Feld "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) walk(value[key], sub, root, path ? `${path}.${key}` : key, errors);
    }
  }
}

// Gibt die Liste der Verstoesse zurueck. Leeres Array = gueltig.
function schemaErrors(value, schema) {
  const errors = [];
  walk(value, schema, schema, '', errors);
  return errors;
}

module.exports = { schemaErrors };
