import {
  describeResolvedRecipeRef,
  resolveRecipeRefInput,
  serializeResolvedRecipeRef,
} from "../core/refs.js";

export async function runResolveCommand({ positionals, options }) {
  const inputRef = positionals[0] ?? "HEAD";
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveRecipeRefInput(inputRef, { cwd });

  if (options.json) {
    console.log(JSON.stringify(serializeResolvedRecipeRef(resolved), null, 2));
    return;
  }

  console.log(`Resolve ${resolved.input}`);
  console.log(`  kind:     ${resolved.kind}`);
  console.log(`  source:   ${resolved.source}`);
  console.log(`  resolved: ${resolved.resolvedRef}`);
  for (const line of describeResolvedRecipeRef(resolved)) {
    console.log(line);
  }
}
