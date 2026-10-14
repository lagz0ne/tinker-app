/** Visit Core's nested bindings without copying bindings or opening resources. */
function visitBindings(bindings, visit) {
  if (Array.isArray(bindings)) {
    for (const binding of bindings) visitBindings(binding, visit);
  } else if (bindings) visit(bindings);
}

/** Compare tag identity at settings time: source inspection cannot prove what a reader returns. */
export function joinSettings(items) {
  const owners = new Map();
  for (const item of items) {
    visitBindings(item.bindings, (binding) => {
      const previous = owners.get(binding.tag) ?? [];
      for (const owner of previous) {
        if (owner === item || item.requires.includes(owner.file)) continue;
        throw new Error(
          `${owner.file} and ${item.file}: both bind tag "${binding.tag.label}" without a requires path; declare requires in item.json`,
        );
      }
      previous.push(item);
      owners.set(binding.tag, previous);
    });
  }
  return items.map((item) => item.bindings);
}
